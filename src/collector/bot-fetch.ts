/**
 * Bot fetch — re-fetches the SAME document with a crawler user-agent (Googlebot
 * Smartphone), for the prospect diagnostic (see ../../docs/DIAGNOSTIC.md). This
 * is the "HTML bot" column of the GO/NOGO table: does the page's server-rendered
 * content survive when the requester identifies itself as Googlebot instead of a
 * real visitor.
 *
 * The raw fetch is INJECTED rather than imported: the collector hands in its own
 * `fetchRawHtmlWithEarlyHints`, so the user fetch and the bot fetch share
 * identical timeout / redirect / decompression behaviour and differ ONLY in who
 * they claim to be — any other difference would make the user/bot comparison
 * meaningless. Injecting it also keeps this module free of a runtime cycle with
 * ./index, and makes `fetchBotHtml` unit-testable without a network.
 */
import type { BotFetch } from "../core";
import type { RawFetchResult } from "./index";
import { blockSignature, isChallengeHtml } from "./challenge";

/**
 * The raw-HTML fetch this module depends on — structurally
 * `fetchRawHtmlWithEarlyHints`. Type-only knowledge of ./index, injected value:
 * no runtime import cycle.
 */
export type RawFetchFn = (
  url: string,
  timeoutMs?: number,
  maxRedirects?: number,
  userAgent?: string,
) => Promise<RawFetchResult>;

/**
 * Googlebot Smartphone user-agent, as currently published by Google
 * (https://developers.google.com/search/docs/crawling-indexing/googlebot#googlebot-smartphone).
 * Kept in one named constant so it can be bumped in one place when Google
 * advances the embedded Chrome version.
 */
export const GOOGLEBOT_SMARTPHONE_UA =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.6422.112 Mobile Safari/537.36 " +
  "(compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

/**
 * Below this many UTF-8 bytes, a "served" body is treated as empty/blocked
 * rather than a legitimately tiny document — real documents are never this
 * short, a WAF block page or an empty connection reset commonly is.
 */
const MIN_BOT_HTML_BYTES = 200;

export interface BlockedVerdict {
  blocked: boolean;
  /** Human-readable reason, in French (read by the diagnostic's operators). */
  blockReason?: string;
}

/**
 * Decide whether a bot-fetch result is a WAF challenge/block page rather than
 * the real document. Pure, so it is testable without any network:
 *  - HTTP status >= 400 is an explicit rejection;
 *  - a known challenge interstitial title (`isChallengeHtml`, shared with the
 *    browser-side challenge wait) catches Cloudflare/Akamai/Imperva pages that
 *    still answer 200 while showing a challenge;
 *  - an empty or very short body catches a block page with no matching title,
 *    or a connection that came back with nothing at all.
 * The three signals are independent; the first one to fire wins and names the
 * reason (docs/DIAGNOSTIC.md's "bot bloqué" — this is the fact that turns a
 * would-be NOGO into an `unknown` "à confirmer" row).
 */
export function classifyBotFetch(status: number, html: string): BlockedVerdict {
  if (status >= 400) {
    return { blocked: true, blockReason: `réponse HTTP ${status}` };
  }
  if (isChallengeHtml(html)) {
    const sig = blockSignature(html);
    return { blocked: true, blockReason: `page de challenge WAF détectée${sig ? ` (${sig})` : ""}` };
  }
  if (Buffer.byteLength(html, "utf-8") < MIN_BOT_HTML_BYTES) {
    return { blocked: true, blockReason: "réponse vide ou trop courte pour être le document" };
  }
  return { blocked: false };
}

/**
 * The browser context's own request API, narrowed to what the rescue needs.
 * Typed structurally so this module stays free of a Playwright import.
 */
export interface ContextRequest {
  get(
    url: string,
    options?: { headers?: Record<string, string>; timeout?: number },
  ): Promise<{
    ok(): boolean;
    status(): number;
    text(): Promise<string>;
    headers(): Record<string, string>;
  }>;
}

/**
 * Second attempt at the crawler document, through the BROWSER CONTEXT.
 *
 * The first attempt is a bare Node request: no cookies, no session, no history
 * with the origin — which is exactly the shape a WAF refuses when the UA claims
 * to be Googlebot from an IP that is not Google's. Replaying it through
 * `context.request` carries the session the browser already established, and
 * sometimes gets through where the bare socket did not. Same ladder the visitor
 * document already climbs (see collect()'s raw-HTML rescue).
 *
 * There is no third tier here, unlike the visitor side: the in-page `fetch()`
 * trick cannot set a User-Agent — the Fetch spec forbids the header and the
 * browser drops it silently — so a crawler request can never reuse the tab's own
 * connection.
 *
 * Returns the rescued `BotFetch`, or null when the rescue is refused too (the
 * caller then keeps the original blocked result and its reason).
 */
export async function rescueBotFetch(
  url: string,
  request: ContextRequest,
  opts: { timeoutMs?: number; userAgent?: string } = {},
): Promise<BotFetch | null> {
  const userAgent = opts.userAgent ?? GOOGLEBOT_SMARTPHONE_UA;
  try {
    const res = await request.get(url, {
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: opts.timeoutMs ?? 30000,
    });
    const html = await res.text();
    const verdict = classifyBotFetch(res.status(), html);
    if (verdict.blocked) return null;
    return {
      userAgent,
      status: res.status(),
      html,
      htmlBytes: Buffer.byteLength(html, "utf-8"),
      responseHeaders: { ...res.headers() },
      blocked: false,
    };
  } catch {
    return null;
  }
}

/**
 * Re-fetch `url` identifying as Googlebot Smartphone. Never throws: a network
 * failure (DNS, TLS, timeout, connection reset) is reported as `status: 0`,
 * `blocked: true` rather than propagated — a failed bot fetch is evidence
 * (docs/DIAGNOSTIC.md's "bot bloqué" case), not a capture failure.
 */
export async function fetchBotHtml(
  url: string,
  rawFetch: RawFetchFn,
  opts: { timeoutMs?: number; maxRedirects?: number; userAgent?: string } = {},
): Promise<BotFetch> {
  const userAgent = opts.userAgent ?? GOOGLEBOT_SMARTPHONE_UA;
  try {
    const res = await rawFetch(
      url,
      opts.timeoutMs ?? 30000,
      opts.maxRedirects ?? 5,
      userAgent,
    );
    const verdict = classifyBotFetch(res.status, res.html);
    return {
      userAgent,
      status: res.status,
      html: res.html,
      htmlBytes: Buffer.byteLength(res.html, "utf-8"),
      responseHeaders: res.headers,
      blocked: verdict.blocked,
      ...(verdict.blockReason ? { blockReason: verdict.blockReason } : {}),
    };
  } catch (err) {
    return {
      userAgent,
      status: 0,
      html: "",
      htmlBytes: 0,
      responseHeaders: {},
      blocked: true,
      blockReason: `échec réseau : ${(err as Error).message}`,
    };
  }
}
