/**
 * Browser provider — abstracts WHICH Chromium drives the capture so the rest of
 * the collector stays identical. Three providers:
 *
 *  - "cloak" (default): CloakBrowser stealth Chromium (patched binary). The one
 *    the audit runs on — required for the Akamai-protected LVMH brand sites and
 *    fully Playwright API-compatible (newContext / addInitScript /
 *    newCDPSession all work — verified).
 *  - "playwright": vanilla headless Chromium. Fast, no extra binary, but blocked
 *    by aggressive WAFs (Akamai serves "Access Denied"). Debug/offline use only.
 *  - "cdp": a REAL, user-owned Chrome. Two modes, tried in that order:
 *      1. ATTACH — a Chrome is already listening on `cdpEndpoint`
 *         (started with `chrome.exe --remote-debugging-port=9222`): connect to it
 *         and capture inside the user's own profile — real cookies, real history,
 *         real IP, real fingerprint, `navigator.webdriver === false`. Highest
 *         anti-bot fidelity. Disconnecting never closes the user's browser
 *         (verified: `browser.close()` on a CDP connection only detaches), and we
 *         close only the tab we opened.
 *      2. LAUNCH — nothing on the endpoint: launch the *installed* Chrome
 *         (`channel: "chrome"`, not the bundled Chromium) headful with a dedicated
 *         PERSISTENT profile, so accepted cookie banners and device reputation
 *         accumulate run after run.
 *    Both modes need a graphical session — a Chrome window becomes visible.
 *
 * All three return a Playwright `BrowserContext`, so the caller never branches.
 * The single exception is `preparePage`: an attached context is the user's own and
 * carries no Playwright device emulation, so the provider hands back a hook the
 * collector applies to each page it creates (no-op for the other providers).
 */
import { chromium, devices, type BrowserContext, type Page } from "playwright";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserProvider, CaptureMode, CollectOptions } from "../core";
import { cloakConfigFromEnv, cloakLaunchOptions } from "./cloak-config";

/**
 * Every provider the collector knows how to drive. The order is informational
 * (roughly least → most human-like client): a capture uses exactly the provider
 * it was configured with — there is no automatic retry with another one.
 */
export const PROVIDERS: BrowserProvider[] = ["cloak", "playwright", "cdp"];

/**
 * Narrow an arbitrary string (CLI flag, form field, DB column) to a known
 * provider. Unknown/missing → "cloak", the stealth Chromium the audit runs on.
 */
export function asProvider(value: string | undefined): BrowserProvider {
  return (PROVIDERS as string[]).includes(value ?? "")
    ? (value as BrowserProvider)
    : "cloak";
}

export interface OpenedBrowser {
  context: BrowserContext;
  /**
   * Applied by the collector to every page it creates, BEFORE navigation.
   * Only the "cdp" attach mode sets it (device emulation over CDP); undefined
   * for providers whose context already carries Playwright emulation.
   */
  preparePage?: (page: Page) => Promise<void>;
  close: () => Promise<void>;
}

const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

const PLAYWRIGHT_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-sandbox",
];

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";

/** `<app>/data/chrome-profile` — persistent profile for the cdp LAUNCH mode. */
function defaultChromeProfileDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // src/collector
  return path.join(here, "..", "..", "data", "chrome-profile");
}

/** `<app>/data/cloak-profiles` — root of the per-origin CloakBrowser profiles. */
function defaultCloakProfileRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // src/collector
  return path.join(here, "..", "..", "data", "cloak-profiles");
}

/**
 * Directory of the persistent CloakBrowser profile for one URL — ONE PER ORIGIN,
 * never a single shared profile. Two reasons, and both matter:
 *
 *  - Correctness: a persistent context locks its directory, and the run executor
 *    captures several origins in parallel. Per-origin dirs can never collide,
 *    because the pool already guarantees one live session per origin.
 *  - Credibility: what makes a warm profile read as a real user is that ITS
 *    cookies, storage and history belong to the site being visited. A single
 *    profile carrying twenty unrelated brands is its own anomaly.
 */
export function cloakProfileDirFor(url: string, root?: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = "unknown";
  }
  // Sanitize hard: the host comes from a URL in the DB, and the result is a path.
  // Collapsing dot runs is what stops a host like ".." from walking out of the root.
  const safe =
    host
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, "_")
      .replace(/[.]{2,}/g, ".")
      .replace(/^[.-]+|[.-]+$/g, "") || "unknown";
  return path.join(root ?? defaultCloakProfileRoot(), safe);
}

/** Context options for a mobile/desktop profile WITH a forced UA (Playwright). */
function playwrightContextOptions(device: "mobile" | "desktop") {
  return device === "mobile"
    ? {
        ...devices["iPhone 13"],
        locale: "en-US",
        extraHTTPHeaders: { "accept-language": ACCEPT_LANGUAGE },
      }
    : {
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        extraHTTPHeaders: { "accept-language": ACCEPT_LANGUAGE },
      };
}

/**
 * Context options WITHOUT a forced user-agent — CloakBrowser sets its own
 * coherent stealth fingerprint/UA, and overriding it would re-expose automation
 * to the WAF. We only set viewport/touch to get a mobile layout.
 */
function cloakContextOptions(device: "mobile" | "desktop") {
  return device === "mobile"
    ? {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        locale: "en-US",
      }
    : { viewport: { width: 1280, height: 800 }, locale: "en-US" };
}

/** True when something answers the CDP endpoint's /json/version within `timeoutMs`. */
export async function cdpEndpointAlive(
  endpoint: string,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Device emulation for a page in an ATTACHED real Chrome. The user's context has
 * no Playwright emulation (viewport follows the real window), so we drive
 * Chrome's own Emulation domain instead — the same mechanism DevTools' device
 * toolbar uses. Best effort: a failure here degrades layout fidelity, it must
 * never abort the capture.
 */
async function emulateOverCdp(
  page: Page,
  device: "mobile" | "desktop",
): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    if (device === "mobile") {
      const iphone = devices["iPhone 13"];
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: iphone.viewport.width,
        height: iphone.viewport.height,
        deviceScaleFactor: iphone.deviceScaleFactor,
        mobile: true,
      });
      await session.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      await session.send("Emulation.setUserAgentOverride", {
        userAgent: iphone.userAgent,
      });
    } else {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
  } catch {
    // Best effort — emulation failure must not abort capture.
  }
}

/** ATTACH: capture inside an already-running Chrome owned by the user. */
async function attachToRunningChrome(
  endpoint: string,
  device: "mobile" | "desktop",
): Promise<OpenedBrowser> {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  // The user's real profile lives in the FIRST (default) context — that is the
  // whole point of attaching, so never call newContext() here: it would create a
  // fresh incognito context and throw the real cookies/history away.
  const context = browser.contexts()[0] ?? (await browser.newContext());

  // Tabs the user already had open. On close we must leave exactly these behind.
  const preExisting = new Set(context.pages());

  return {
    context,
    preparePage: (page) => emulateOverCdp(page, device),
    close: async () => {
      for (const page of context.pages()) {
        if (!preExisting.has(page)) {
          await page.close().catch(() => {});
        }
      }
      // Only detaches the CDP connection — the user's Chrome keeps running.
      await browser.close().catch(() => {});
    },
  };
}

/** LAUNCH: start the installed Chrome headful on a dedicated persistent profile. */
async function launchRealChrome(
  opts: CollectOptions,
  device: "mobile" | "desktop",
): Promise<OpenedBrowser> {
  const profileDir = opts.chromeProfileDir ?? defaultChromeProfileDir();
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome", // the REAL installed Chrome, not the bundled Chromium
    headless: opts.headless ?? false, // a real window is far less detectable
    args: PLAYWRIGHT_ARGS,
    ...(opts.proxy ? { proxy: { server: opts.proxy } } : {}),
    ...(device === "mobile"
      ? { ...devices["iPhone 13"], locale: "en-US" }
      : { viewport: { width: 1280, height: 800 }, locale: "en-US" }),
  });
  return {
    context,
    close: async () => {
      await context.close();
    },
  };
}

/**
 * CloakBrowser stealth Chromium — the provider the audit runs on.
 *
 * "standard" (default): headless, fresh context. Headless needs no display and
 * is simpler to run, so it is where every capture starts.
 *
 * "escalated": the ONE retry a blocked page gets. Everything the vendor
 * prescribes against a challenge, at once — headed (headless is detectable on
 * its own), humanize/careful input timing, and a persistent per-origin profile
 * whose cookies and history make the session look like a returning user instead
 * of a disposable incognito one.
 *
 * Note for whoever reads a rescued capture: a warm profile may already hold the
 * site's consent cookie, so consent-gated third parties can load without the
 * banner ever being clicked. Topic 4 evidence from an escalated capture is
 * therefore weaker than from a standard one — the run executor records which
 * mode produced the bundle.
 */
async function openCloak(
  opts: CollectOptions,
  device: "mobile" | "desktop",
  url?: string,
): Promise<OpenedBrowser> {
  const mode: CaptureMode = opts.mode ?? "standard";
  const escalated = mode === "escalated";

  // Lazy import so the ~535 MB stealth binary is only required when actually used.
  const cloak: any = await import("cloakbrowser");
  // License key, proxy, geoip and humanize settings all come from .env — see
  // cloak-config.ts. An escalated attempt overrides the two that are its whole
  // point (headed + careful humanize), whatever the environment says.
  const launchOptions = cloakLaunchOptions(cloakConfigFromEnv(), {
    proxy: opts.proxy,
    headless: escalated ? false : opts.headless,
    ...(escalated ? { humanize: true, humanPreset: "careful" as const } : {}),
  });

  const contextOptions = cloakContextOptions(device);

  if (escalated && url) {
    const profileDir = cloakProfileDirFor(url, opts.cloakProfileRoot);
    // Playwright-compatible builds expose launchPersistentContext; if this one
    // does not — or if opening the profile fails — a fresh headed context is
    // still a real escalation: losing the warm profile must not cost us the retry.
    if (typeof cloak.launchPersistentContext === "function") {
      try {
        // NOTE the shape: cloakbrowser takes ONE options object with
        // `userDataDir` inside (NOT Playwright's `(dir, options)` signature), and
        // only surfaces viewport/locale/userAgent at top level — every other
        // context field has to travel in `contextOptions`, or it is dropped.
        const { viewport, locale, ...restContext } = contextOptions as Record<string, unknown>;
        const context: BrowserContext = await cloak.launchPersistentContext({
          userDataDir: profileDir,
          ...launchOptions,
          ...(viewport ? { viewport } : {}),
          ...(locale ? { locale } : {}),
          ...(Object.keys(restContext).length ? { contextOptions: restContext } : {}),
        });
        return { context, close: async () => { await context.close(); } };
      } catch (err) {
        console.warn(
          `[cloak] persistent profile ${profileDir} unusable (${(err as Error).message}) — ` +
            `escalating with a fresh headed context instead`,
        );
      }
    }
  }

  const browser = await cloak.launch(launchOptions);
  const context: BrowserContext = await browser.newContext(contextOptions);
  return {
    context,
    close: async () => {
      await browser.close();
    },
  };
}

/**
 * Open a browser context for one capture.
 *
 * `url` is only used by the cloak provider in "escalated" mode, to pick the
 * per-origin persistent profile; every other path ignores it.
 */
export async function openBrowser(
  opts: CollectOptions,
  url?: string,
): Promise<OpenedBrowser> {
  const device = opts.device ?? "mobile";
  const provider = opts.browser ?? "playwright";

  if (provider === "cdp") {
    const endpoint =
      opts.cdpEndpoint ?? process.env.CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT;
    if (await cdpEndpointAlive(endpoint)) {
      return attachToRunningChrome(endpoint, device);
    }
    return launchRealChrome(opts, device);
  }

  if (provider === "cloak") {
    return openCloak(opts, device, url);
  }

  // Default: vanilla Playwright Chromium.
  const browser = await chromium.launch({
    headless: opts.headless ?? true,
    args: PLAYWRIGHT_ARGS,
  });
  const context = await browser.newContext(playwrightContextOptions(device));
  return {
    context,
    close: async () => {
      await browser.close();
    },
  };
}
