/**
 * Browser provider — abstracts WHICH Chromium drives the capture so the rest of
 * the collector stays identical. Two providers:
 *
 *  - "playwright" (default): vanilla headless Chromium. Fast, no extra binary,
 *    but blocked by aggressive WAFs (Akamai serves "Access Denied").
 *  - "cloak": CloakBrowser stealth Chromium (patched binary). Required for the
 *    Akamai-protected LVMH brand sites. Fully Playwright API-compatible
 *    (newContext / addInitScript / newCDPSession all work — verified).
 *
 * Both return a Playwright `BrowserContext`, so the caller never branches.
 */
import { chromium, devices, type BrowserContext } from "playwright";
import type { CollectOptions } from "../core";

export interface OpenedBrowser {
  context: BrowserContext;
  close: () => Promise<void>;
}

const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

const PLAYWRIGHT_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-sandbox",
];

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

export async function openBrowser(
  opts: CollectOptions,
): Promise<OpenedBrowser> {
  const device = opts.device ?? "mobile";
  const provider = opts.browser ?? "playwright";

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
