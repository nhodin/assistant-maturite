/**
 * Browser provider — abstracts WHICH Chromium drives the capture so the rest of
 * the collector stays identical. Three providers:
 *
 *  - "playwright" (default): vanilla headless Chromium. Fast, no extra binary,
 *    but blocked by aggressive WAFs (Akamai serves "Access Denied").
 *  - "cloak": CloakBrowser stealth Chromium (patched binary). Required for the
 *    Akamai-protected LVMH brand sites. Fully Playwright API-compatible
 *    (newContext / addInitScript / newCDPSession all work — verified).
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
import type { BrowserProvider, CollectOptions } from "../core";

/**
 * Order the providers are tried in when the configured one fails or returns an
 * unhealthy capture. "cdp" (a real, user-owned Chrome) comes LAST: highest
 * anti-bot fidelity, but it needs a graphical session and pops a visible Chrome
 * window, so it is the last resort rather than a default.
 */
export const PROVIDER_PRIORITY: BrowserProvider[] = ["cloak", "playwright", "cdp"];

/** Narrow an arbitrary string (CLI flag, form field, DB column) to a known provider. */
export function asProvider(value: string | undefined): BrowserProvider {
  return (PROVIDER_PRIORITY as string[]).includes(value ?? "")
    ? (value as BrowserProvider)
    : "playwright";
}

/** Providers to try for one page: primary first, then every other one in priority order. */
export function fallbackChain(primary: BrowserProvider): BrowserProvider[] {
  return [primary, ...PROVIDER_PRIORITY.filter((p) => p !== primary)];
}

/**
 * Which providers are still worth trying after the ones in `attempted` failed.
 *
 * A "blocked" verdict is about the CLIENT — its IP, its session, its missing
 * anti-bot sensor cookie — not about which Chromium drove the capture. Measured
 * on an Akamai-protected LVMH site (2026-08): a first `cdp` capture succeeded,
 * then a handful of blocked captures from the same IP within the hour hardened
 * the WAF to the point where even a plain Node fetch got a 403 maintenance page,
 * while a human's warm Chrome session still loaded the site fine. So on a block
 * we escalate ONCE — to the strongest provider left — instead of burning the
 * whole chain against an origin that is already counting.
 *
 * A "unusable" failure (nothing fetched, no headers, broken URL) costs the
 * client nothing reputationally, so every remaining provider stays on the table.
 */
export function providersAfterFailure(
  chain: BrowserProvider[],
  attempted: BrowserProvider[],
  kind: "blocked" | "unusable",
): BrowserProvider[] {
  const left = chain.filter((p) => !attempted.includes(p));
  if (kind !== "blocked" || left.length === 0 || attempted.length === 0) return left;

  // "Strength" = position in PROVIDER_PRIORITY: the later, the more human-like the
  // client. Only an ESCALATION can plausibly get past a WAF that just refused us —
  // once the strongest provider has itself been blocked, a weaker one certainly
  // won't pass, and trying it anyway would only cost more standing with the origin.
  const strength = (p: BrowserProvider): number => PROVIDER_PRIORITY.indexOf(p);
  const strongestAttempted = Math.max(...attempted.map(strength));
  const stronger = left.filter((p) => strength(p) > strongestAttempted);
  if (stronger.length === 0) return [];
  return [stronger.reduce((best, p) => (strength(p) > strength(best) ? p : best))];
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

export async function openBrowser(
  opts: CollectOptions,
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
    // Lazy import so the ~535 MB stealth binary is only required when actually used.
    const cloak: any = await import("cloakbrowser");
    const browser = await cloak.launch({
      headless: opts.headless ?? false, // stealth works best non-headless
      humanize: true,
      humanPreset: "careful",
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
    });
    const context: BrowserContext = await browser.newContext(
      cloakContextOptions(device),
    );
    return {
      context,
      close: async () => {
        await browser.close();
      },
    };
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
