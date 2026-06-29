/**
 * Main collector — captures everything about a page and returns an EvidenceBundle.
 * Performs NO scoring; only data gathering.
 */
import type { CDPSession } from "playwright";
import {
  EvidenceBundleSchema,
  type EvidenceBundle,
  type CollectFn,
  type CollectOptions,
  type NetworkRequest,
  type FontFace,
  type PerfMetrics,
  type LcpElement,
} from "../core";
import { probeNetwork } from "./network";
import { fetchCrux } from "./crux";
import { parseHead } from "./head";
import { openBrowser } from "./browser";

// ── Constants ──────────────────────────────────────────────────────────────────

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/16.0 Mobile/15E148 Safari/604.1";

const COOKIE_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "button#didomi-notice-agree-button",
  "#didomi-notice-agree-button",
  "[aria-label*='accept' i]",
  "[aria-label*='accepter' i]",
  "[aria-label*='agree' i]",
  "button[id*='accept']",
  "button[class*='accept']",
  ".cookie-accept",
  ".js-accept-cookies",
  "#accept-cookies",
];

const COOKIE_TEXT_PATTERNS = [
  /^accept\s*(all|cookies)?$/i,
  /^agree$/i,
  /^tout\s+accepter$/i,
  /^accepter(\s+tout)?$/i,
  /^j'accepte$/i,
  /^allow\s+all$/i,
  /^ok$/i,
];

// ── CDP resource type mapping ──────────────────────────────────────────────────

const CDP_TYPE_MAP: Record<string, string> = {
  Document: "document",
  Stylesheet: "stylesheet",
  Image: "image",
  Media: "media",
  Font: "font",
  Script: "script",
  TextTrack: "other",
  XHR: "xhr",
  Fetch: "fetch",
  EventSource: "other",
  WebSocket: "other",
  Manifest: "other",
  SignedExchange: "other",
  Ping: "other",
  CSPViolationReport: "other",
  Preflight: "other",
  Other: "other",
};

function mapResourceType(cdpType: string): string {
  return CDP_TYPE_MAP[cdpType] ?? "other";
}

// ── Font face parser ────────────────────────────────────────────────────────────

function parseFontFaces(html: string): FontFace[] {
  const fonts: FontFace[] = [];
  // Find all @font-face blocks in inline <style> elements
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;

  while ((styleMatch = styleRe.exec(html)) !== null) {
    const css = styleMatch[1];
    const fontFaceRe = /@font-face\s*\{([^}]+)\}/gi;
    let fontMatch: RegExpExecArray | null;

    while ((fontMatch = fontFaceRe.exec(css)) !== null) {
      const block = fontMatch[1];
      const font: FontFace = {};

      // Parse individual properties
      const propRe = /([a-z-]+)\s*:\s*([^;]+)/gi;
      let propMatch: RegExpExecArray | null;
      while ((propMatch = propRe.exec(block)) !== null) {
        const prop = propMatch[1].trim().toLowerCase();
        const val = propMatch[2].trim();
        switch (prop) {
          case "font-family":
            font.family = val.replace(/['"]/g, "");
            break;
          case "src":
            font.src = val;
            // Try to extract format
            const fmtMatch = val.match(/format\(['"]?([^'")\s]+)['"]?\)/i);
            if (fmtMatch) {
              font.format = fmtMatch[1].toLowerCase();
            }
            break;
          case "font-display":
            font.fontDisplay = val.toLowerCase();
            break;
          case "unicode-range":
            font.unicodeRange = val;
            break;
          case "size-adjust":
            font.sizeAdjust = val;
            break;
        }
      }

      if (Object.keys(font).length > 0) {
        fonts.push(font);
      }
    }
  }

  return fonts;
}

// ── Cookie acceptance ───────────────────────────────────────────────────────────

async function tryAcceptCookies(
  page: import("playwright").Page,
  customSelector?: string,
): Promise<boolean> {
  const shortTimeout = 3000;

  // Try custom selector first
  if (customSelector) {
    try {
      const el = page.locator(customSelector).first();
      await el.click({ timeout: shortTimeout });
      return true;
    } catch {
      // Continue to defaults
    }
  }

  // Try common selectors
  for (const sel of COOKIE_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: shortTimeout });
        return true;
      }
    } catch {
      // Try next
    }
  }

  // Try text-based matching on buttons
  try {
    const buttons = await page.locator("button").all();
    for (const btn of buttons.slice(0, 20)) {
      try {
        const text = (await btn.textContent({ timeout: 500 }))?.trim() ?? "";
        if (COOKIE_TEXT_PATTERNS.some((re) => re.test(text))) {
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click({ timeout: shortTimeout });
            return true;
          }
        }
      } catch {
        // Continue
      }
    }
  } catch {
    // Ignore
  }

  return false;
}

// ── Auto-scroll (anti-bot / lazy-load mitigation) ───────────────────────────────
// Headless never scrolls, so lazy-loaded images and SPA-deferred content never
// request and LCP never settles. We scroll top→bottom in viewport-sized steps,
// re-reading scrollHeight as it grows, then scroll back to top.
async function autoScroll(page: import("playwright").Page): Promise<void> {
  try {
    const viewportH =
      (await page.evaluate(() => window.innerHeight).catch(() => 0)) || 800;
    const maxSteps = 25; // cap ~12s total (25 * 300ms + work)
    let lastScrollY = -1;

    for (let i = 0; i < maxSteps; i++) {
      const { scrollY, scrollHeight } = await page
        .evaluate(() => ({
          scrollY: window.scrollY,
          scrollHeight: document.body ? document.body.scrollHeight : 0,
        }))
        .catch(() => ({ scrollY: 0, scrollHeight: 0 }));

      // Reached the bottom and no further growth — stop early.
      if (scrollY + viewportH >= scrollHeight && scrollY === lastScrollY) break;
      lastScrollY = scrollY;

      await page.mouse.wheel(0, viewportH).catch(() => {});
      await new Promise<void>((r) => setTimeout(r, 300));
    }

    // Back to top so above-the-fold LCP element is the settled one.
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 300));
  } catch {
    // Best effort — scrolling failures must not abort capture.
  }
}

// ── Performance init script (injected before navigation) ───────────────────────

const PERF_INIT_SCRIPT = `
(function() {
  window.__perf = {
    lcpTime: null,
    lcpElement: null, // live reference to the latest LCP element (re-marked at the end)
    cls: 0,
    longTasks: [],
  };

  // LCP observer — keeps updating through the auto-scroll so the final entry wins.
  try {
    const lcpObs = new PerformanceObserver(function(list) {
      const entries = list.getEntries();
      if (entries.length > 0) {
        const entry = entries[entries.length - 1];
        window.__perf.lcpTime = entry.startTime;
        // Stash the live element reference; we mark it just before extraction.
        window.__perf.lcpElement = entry.element || null;
      }
    });
    lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch(e) {}

  // CLS observer
  try {
    const clsObs = new PerformanceObserver(function(list) {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__perf.cls += entry.value;
        }
      }
    });
    clsObs.observe({ type: 'layout-shift', buffered: true });
  } catch(e) {}

  // Long tasks observer
  try {
    const ltObs = new PerformanceObserver(function(list) {
      for (const entry of list.getEntries()) {
        window.__perf.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    ltObs.observe({ type: 'longtask', buffered: true });
  } catch(e) {}
})();
`;

// ── Main collect function ───────────────────────────────────────────────────────

export const collect: CollectFn = async (
  url: string,
  opts: CollectOptions = {},
): Promise<EvidenceBundle> => {
  const device = opts.device ?? "mobile";
  const acceptCookies = opts.acceptCookies ?? true;
  const timeoutMs = opts.timeoutMs ?? 45000;
  const capturedAt = new Date().toISOString();

  // ── Step 1: Raw HTML fetch (pre-JS, outside browser) ────────────────────────
  let rawHtml = "";
  let mainResponseHeaders: Record<string, string> = {};
  let finalUrl = url;
  let altSvcHeader: string | null = null;

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": MOBILE_UA,
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      redirect: "follow",
      // @ts-ignore — node-fetch / undici signal option
      signal: AbortSignal.timeout(30000),
    });

    finalUrl = res.url || url;
    rawHtml = await res.text();

    // Collect response headers as lowercase map
    res.headers.forEach((value, key) => {
      mainResponseHeaders[key.toLowerCase()] = value;
    });

    altSvcHeader = mainResponseHeaders["alt-svc"] ?? null;
  } catch {
    rawHtml = "";
    mainResponseHeaders = {};
    finalUrl = url;
  }

  // ── Step 2: Browser capture ──────────────────────────────────────────────────
  let renderedHtml = "";
  const requests: NetworkRequest[] = [];
  let perfMetrics: PerfMetrics = {
    lcpMs: null,
    lcpElement: null,
    cls: null,
    ttfbMs: null,
    longTasks: [],
    totalBytes: 0,
  };
  let cookieAccepted = false;
  let sliderDetected = false;
  let videoDetected = false;

  // Browser capture via the selected provider: vanilla Playwright (default) or
  // CloakBrowser stealth (opts.browser === "cloak") for WAF-protected sites.
  // The provider returns a Playwright-compatible BrowserContext either way.
  const opened = await openBrowser(opts);
  const { context } = opened;
  try {

    // Hide navigator.webdriver before any page script runs (anti-bot mitigation).
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      } catch {
        // ignore
      }
    });

    // Inject perf observer script before any navigation
    await context.addInitScript(PERF_INIT_SCRIPT);

    const page = await context.newPage();

    // ── CDP session for network events ─────────────────────────────────────────
    let cdp: CDPSession;
    try {
      cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
    } catch {
      // CDP unavailable — proceed without it
      cdp = null as unknown as CDPSession;
    }

    // Track per-requestId data from CDP
    const requestMap = new Map<
      string,
      {
        url: string;
        resourceType: string;
        status: number;
        fromCache: boolean;
        encodedBytes: number;
        decodedBytes: number;
        requestHeaders: Record<string, string>;
        responseHeaders: Record<string, string>;
        mimeType: string;
      }
    >();

    if (cdp) {
      cdp.on(
        "Network.responseReceived",
        (event: {
          requestId: string;
          type: string;
          response: {
            url: string;
            status: number;
            headers: Record<string, string>;
            mimeType: string;
            fromDiskCache?: boolean;
            fromServiceWorker?: boolean;
            requestHeaders?: Record<string, string>;
          };
        }) => {
          try {
            const r = event.response;
            const respHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.headers ?? {})) {
              respHeaders[k.toLowerCase()] = String(v);
            }
            const reqHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.requestHeaders ?? {})) {
              reqHeaders[k.toLowerCase()] = String(v);
            }

            const contentLength = parseInt(
              respHeaders["content-length"] ?? "0",
              10,
            );

            requestMap.set(event.requestId, {
              url: r.url,
              resourceType: mapResourceType(event.type),
              status: r.status,
              fromCache: r.fromDiskCache === true || r.fromServiceWorker === true,
              encodedBytes: contentLength || 0,
              decodedBytes: contentLength || 0,
              requestHeaders: reqHeaders,
              responseHeaders: respHeaders,
              mimeType: r.mimeType ?? "",
            });
          } catch {
            // ignore bad events
          }
        },
      );

      cdp.on(
        "Network.loadingFinished",
        (event: { requestId: string; encodedDataLength: number }) => {
          try {
            const entry = requestMap.get(event.requestId);
            if (entry) {
              entry.encodedBytes = event.encodedDataLength ?? entry.encodedBytes;
              // decodedBytes: use same approximation
              entry.decodedBytes = entry.decodedBytes || entry.encodedBytes;
            }
          } catch {
            // ignore
          }
        },
      );
    }

    // ── Navigate ───────────────────────────────────────────────────────────────
    try {
      await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    } catch {
      // Partial load — continue with whatever we got
    }

    // Wait for network idle (best effort)
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      // Ignore timeout
    }

    // ── Accept cookies ─────────────────────────────────────────────────────────
    if (acceptCookies) {
      cookieAccepted = await tryAcceptCookies(page, opts.cookieSelector);
      if (cookieAccepted) {
        // Wait for late third-parties to load after cookie acceptance
        await new Promise<void>((r) => setTimeout(r, 1500));
        try {
          await page.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {
          // Ignore
        }
      }
    }

    // ── Auto-scroll to trigger lazy-loading (anti-bot / lazy-load mitigation) ────
    // Done AFTER cookie acceptance, BEFORE reading metrics/HTML so deferred images
    // and SPA content actually request and LCP can settle on a real element.
    await autoScroll(page);
    try {
      await page.waitForLoadState("networkidle", { timeout: 6000 });
    } catch {
      // Ignore — late assets may still be in flight; we captured what we could.
    }

    // ── Rendered HTML ──────────────────────────────────────────────────────────
    try {
      renderedHtml = await page.content();
    } catch {
      renderedHtml = "";
    }

    // ── Extract perf metrics ───────────────────────────────────────────────────
    try {
      const perfData = await page.evaluate(() => {
        const perf = (window as unknown as { __perf?: {
          lcpTime: number | null;
          lcpElement: Element | null;
          cls: number;
          longTasks: { startTime: number; duration: number }[];
        } }).__perf;

        // Mark the latest LCP element right now (after scroll + settle) so we
        // extract the element that actually won, not a stale early one.
        try {
          if (perf?.lcpElement && perf.lcpElement.isConnected) {
            perf.lcpElement.setAttribute("data-lcp-marker", "1");
          }
        } catch {
          // ignore
        }

        // TTFB from Navigation Timing
        let ttfbMs: number | null = null;
        try {
          const nav = performance.getEntriesByType(
            "navigation",
          )[0] as PerformanceNavigationTiming | undefined;
          if (nav) ttfbMs = nav.responseStart;
        } catch {
          // ignore
        }

        // LCP element details via data-lcp-marker attribute
        let lcpElement: {
          tagName: string;
          src?: string;
          selector?: string;
          loadingAttr?: string;
          fetchPriorityAttr?: string;
        } | null = null;

        try {
          const el = document.querySelector("[data-lcp-marker='1']") as HTMLElement | null;
          // Be honest: BODY/HTML or a zero-size element is not a real LCP element.
          // Returning null lets downstream "LCP is/isn't an image" logic stay truthful.
          const rect = el?.getBoundingClientRect();
          const hasSize = rect ? rect.width > 0 && rect.height > 0 : false;
          const isStructural =
            el?.tagName === "BODY" || el?.tagName === "HTML";
          if (el && hasSize && !isStructural) {
            const tagName = el.tagName.toLowerCase();
            let src: string | undefined;
            if (el instanceof HTMLImageElement) {
              src = el.currentSrc || el.src || undefined;
            } else if (el instanceof HTMLVideoElement) {
              src = el.src || undefined;
            }

            // Build a basic selector
            let selector = tagName;
            if (el.id) selector += `#${el.id}`;
            else if (el.className) {
              const classes = Array.from(el.classList)
                .slice(0, 3)
                .join(".");
              if (classes) selector += `.${classes}`;
            }

            lcpElement = {
              tagName,
              src,
              selector,
              loadingAttr: el.getAttribute("loading") ?? undefined,
              fetchPriorityAttr: el.getAttribute("fetchpriority") ?? undefined,
            };
          }
        } catch {
          // ignore
        }

        return {
          lcpTime: perf?.lcpTime ?? null,
          cls: perf?.cls ?? null,
          longTasks: perf?.longTasks ?? [],
          ttfbMs,
          lcpElement,
        };
      });

      perfMetrics = {
        lcpMs: perfData.lcpTime,
        lcpElement: (perfData.lcpElement as LcpElement | null) ?? null,
        cls: perfData.cls,
        ttfbMs: perfData.ttfbMs,
        longTasks: perfData.longTasks,
        totalBytes: 0, // Will be set after request collection
      };
    } catch {
      // perfMetrics stays as null-filled defaults
    }

    // ── Detect slider / video ──────────────────────────────────────────────────
    try {
      const pageFeatures = await page.evaluate(() => {
        // Slider detection: common selectors and classes
        const sliderSelectors = [
          ".swiper",
          ".swiper-wrapper",
          ".slick-slider",
          ".glide",
          ".splide",
          ".owl-carousel",
          "[class*='carousel']",
          "[class*='slider']",
          "[data-glide-el]",
          "swiper-container",
        ];
        const hasSlider = sliderSelectors.some(
          (sel) => document.querySelector(sel) !== null,
        );

        // Video detection
        const hasVideo =
          document.querySelector("video") !== null ||
          document.querySelector("iframe[src*='youtube']") !== null ||
          document.querySelector("iframe[src*='vimeo']") !== null;

        return { hasSlider, hasVideo };
      });

      sliderDetected = pageFeatures.hasSlider;
      videoDetected = pageFeatures.hasVideo;
    } catch {
      // Defaults to false
    }

    // ── Collect all requests ───────────────────────────────────────────────────
    for (const entry of requestMap.values()) {
      requests.push({
        url: entry.url,
        resourceType: entry.resourceType,
        status: entry.status,
        fromCache: entry.fromCache,
        encodedBytes: entry.encodedBytes,
        decodedBytes: entry.decodedBytes,
        requestHeaders: entry.requestHeaders,
        responseHeaders: entry.responseHeaders,
        mimeType: entry.mimeType,
      });
    }

    // Compute totalBytes
    perfMetrics.totalBytes = requests.reduce(
      (sum, r) => sum + r.encodedBytes,
      0,
    );

    await context.close();
  } finally {
    await opened.close();
  }

  // ── Step 3: Fonts from raw HTML ──────────────────────────────────────────────
  let fonts: FontFace[] = [];
  try {
    fonts = parseFontFaces(rawHtml);
  } catch {
    fonts = [];
  }

  // ── Step 4: Parse head ───────────────────────────────────────────────────────
  let head = { order: [] as string[], tags: [] as { tag: string; attrs: Record<string, string> }[] };
  try {
    head = parseHead(rawHtml || renderedHtml);
  } catch {
    // Keep empty defaults
  }

  // ── Step 5: Network probe ────────────────────────────────────────────────────
  const network = await probeNetwork(finalUrl, altSvcHeader);

  // ── Step 6: CrUX field data ──────────────────────────────────────────────────
  const field = await fetchCrux(url, opts.cruxApiKey);

  // ── Step 7: Assemble and validate ────────────────────────────────────────────
  const bundle = {
    url,
    finalUrl,
    device,
    capturedAt,
    rawHtml,
    renderedHtml,
    mainResponseHeaders,
    head,
    requests,
    perf: perfMetrics,
    coverage: { cssUnusedPct: null, jsUnusedPct: null },
    fonts,
    field: field ?? null,
    network,
    features: {
      sliderDetected,
      videoDetected,
      cookieAccepted,
    },
  };

  return EvidenceBundleSchema.parse(bundle);
};
