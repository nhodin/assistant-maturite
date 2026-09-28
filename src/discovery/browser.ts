/**
 * Page discovery — browser fetcher, the fallback for what a plain request cannot
 * read: a WAF interstitial (the stealth browser waits for a self-clearing challenge
 * the same way the collector does — it never solves one), or a navigation built in
 * JavaScript (the returned `html` is the RENDERED DOM, so JS-built links count).
 *
 * Opened lazily — a site that HTTP handles never pays for a browser — and ONE
 * session at a time for the whole process: discovery may run while a capture is in
 * progress, and the CloakBrowser plan bounds the sessions both share.
 */
import type { Page, Response } from "playwright";
import type { BrowserProvider } from "../core";
import { openBrowser, type OpenedBrowser } from "../collector/browser";
import { ensureCloakBinary } from "../collector/cloak-binary";
import { waitForChallengeToSettle } from "../collector/challenge";
import type { Fetcher, FetchResult } from "./types";

/** One browser session for discovery at a time, process-wide. */
let slotBusy: Promise<void> = Promise.resolve();
function acquireSlot(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const ready = slotBusy.then(() => release);
  slotBusy = slotBusy.then(() => next);
  return ready;
}

export interface BrowserFetcherOptions {
  provider?: BrowserProvider;
  headless?: boolean;
  /** Navigation timeout per page, ms. */
  timeoutMs?: number;
}

export interface ClosableFetcher extends Fetcher {
  close(): Promise<void>;
}

export function createBrowserFetcher(opts: BrowserFetcherOptions = {}): ClosableFetcher {
  const provider = opts.provider ?? "cloak";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let session: Promise<{ browser: OpenedBrowser; page: Page; release: () => void }> | null = null;

  const open = (url: string) =>
    (session ??= (async () => {
      const release = await acquireSlot();
      try {
        if (provider === "cloak") await ensureCloakBinary();
        const browser = await openBrowser({ browser: provider, device: "mobile", headless: opts.headless }, url);
        const page = await browser.context.newPage();
        await browser.preparePage?.(page);
        return { browser, page, release };
      } catch (err) {
        release();
        throw err;
      }
    })());

  return {
    kind: "browser",
    async get(url: string): Promise<FetchResult> {
      let page: Page;
      try {
        ({ page } = await open(url));
      } catch (err) {
        session = null; // let a later site try again
        return { error: `navigateur indisponible : ${(err as Error).message.slice(0, 200)}` };
      }
      // The main frame's LAST navigation response: after a challenge clears, it is
      // the real document's, not the interstitial's.
      let lastNav: Response | null = null;
      const onResponse = (resp: Response) => {
        try {
          if (resp.request().isNavigationRequest() && resp.frame() === page.mainFrame()) lastNav = resp;
        } catch {
          /* detached frame */
        }
      };
      page.on("response", onResponse);
      try {
        const first = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
        await waitForChallengeToSettle(page).catch(() => undefined);
        // A listing often renders its tiles as they scroll into view.
        await page.mouse.wheel(0, 2500).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        const html = await page.content();
        const resp = (lastNav as Response | null) ?? first;
        return { url: page.url(), status: resp?.status() ?? 200, html };
      } catch (err) {
        return { error: (err as Error).message.split("\n")[0].slice(0, 200) };
      } finally {
        page.off("response", onResponse);
      }
    },
    async close() {
      const s = session;
      session = null;
      if (!s) return;
      try {
        const { browser, release } = await s;
        await browser.close().catch(() => {});
        release();
      } catch {
        /* never opened */
      }
    },
  };
}
