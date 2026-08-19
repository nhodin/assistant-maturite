/**
 * Capture health check — catches captures that landed on an error/bot-block page
 * instead of the real site, so the run executor can reject them instead of silently
 * scoring garbage (e.g. an Akamai/Cloudflare challenge page, a 403 mid-capture, or a
 * page whose assets never actually loaded).
 */
import type { EvidenceBundle } from "../core";

/**
 * Why a capture was rejected.
 * - "blocked": a WAF/anti-bot VERDICT (403/429, challenge or maintenance page,
 *   assets never served). The verdict is about the client's standing — its IP,
 *   its session, its lack of a valid sensor cookie — not about which Chromium
 *   drove it. Hammering the same origin with the next provider seconds later
 *   rarely helps and measurably degrades that standing, so the run executor
 *   escalates at most once and cools down first.
 * - "unusable": a technical capture failure (nothing fetched, no headers,
 *   broken URL). Another provider may genuinely do better, at no reputational cost.
 */
export type CaptureFailureKind = "blocked" | "unusable";

export interface CaptureHealth {
  ok: boolean;
  /** Human-readable reason, set only when ok === false. */
  reason: string | null;
  /** Set only when ok === false. Drives the run executor's retry policy. */
  kind?: CaptureFailureKind;
}

/**
 * HTTP statuses a WAF returns as a verdict on the client, as opposed to a
 * genuinely broken URL (404/410) or a one-off server error.
 */
const BLOCK_STATUSES = new Set([401, 403, 405, 406, 409, 418, 429, 503]);

const ERROR_TITLE_PATTERNS: RegExp[] = [
  /access denied/i,
  /forbidden/i,
  /page not found/i,
  /page introuvable/i,
  /erreur\s*40[0-9]/i,
  /\b40[0-9]\s*error\b/i,
  /just a moment/i, // Cloudflare JS challenge
  /attention required/i, // Cloudflare
  /pardon our interruption/i, // Akamai Bot Manager challenge
  /request rejected/i, // common WAF wording
  /are you a robot/i,
];

function titleOf(rawHtml: string): string {
  return rawHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
}

/** e.g. "document:2, script:2, xhr:4, other:2" — lets a human eyeball what actually loaded. */
function describeRequestCounts(requests: EvidenceBundle["requests"]): string {
  const byType = new Map<string, number>();
  for (const r of requests) byType.set(r.resourceType, (byType.get(r.resourceType) ?? 0) + 1);
  return [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}:${count}`)
    .join(", ");
}

/**
 * Decide whether an EvidenceBundle reflects a real, fully-loaded page rather than
 * an error/bot-check page. Pure and side-effect-free like a Control, but not a
 * scoring criterion — this gates whether the bundle is scored at all.
 */
export function assessCaptureHealth(bundle: EvidenceBundle): CaptureHealth {
  // The separate raw-HTML fetch can fail (bot-block at the HTTP layer, timeout,
  // reset) and the collector then continues with rawHtml="" and
  // mainResponseHeaders={}. Nothing below catches that (no 4xx doc, empty title,
  // imgTagCount=0), so every markup/header-based control would score garbage and
  // some pass vacuously. Reject such captures up front.
  if (bundle.rawHtml.trim().length < 500) {
    return {
      ok: false,
      kind: "unusable",
      reason:
        `Empty raw HTML: the raw-HTML fetch failed or returned a near-empty document ` +
        `(${bundle.rawHtml.trim().length} non-whitespace bytes, < 500) — likely bot-blocked or ` +
        `reset at the HTTP layer, so markup-based criteria (head order, image/CSS/JS markup, ` +
        `inline styles, SSR content) can't be evaluated.`,
    };
  }
  if (Object.keys(bundle.mainResponseHeaders).length === 0) {
    return {
      ok: false,
      kind: "unusable",
      reason:
        `No response headers: the raw-HTML fetch captured 0 main-document response headers — likely ` +
        `bot-blocked or reset at the HTTP layer, so header-based criteria (cache/TTL, CDN, ` +
        `critical-path/early-hint headers) can't be evaluated.`,
    };
  }

  // A legitimate document response is never 4xx/5xx. Any such request (initial nav
  // or a later reload during the interaction probe) means the browser session was
  // blocked or the URL is broken — never a real render.
  const blockedDoc = bundle.requests.find(
    (r) => r.resourceType === "document" && r.status >= 400,
  );
  if (blockedDoc) {
    return {
      ok: false,
      kind: BLOCK_STATUSES.has(blockedDoc.status) ? "blocked" : "unusable",
      reason:
        `Blocked mid-capture: the document request to ${blockedDoc.url} returned HTTP ${blockedDoc.status} ` +
        `during the "${blockedDoc.phase ?? "load"}" phase (a real document response is never 4xx/5xx) — ` +
        `likely an anti-bot/WAF block (Akamai/Cloudflare/etc.) or a broken URL, not the real page.`,
    };
  }

  const title = titleOf(bundle.rawHtml);
  const badTitlePattern = ERROR_TITLE_PATTERNS.find((re) => re.test(title));
  if (badTitlePattern) {
    return {
      ok: false,
      kind: "blocked",
      reason:
        `Blocked page: <title> is "${title}", which matches the known error/bot-challenge wording ` +
        `/${badTitlePattern.source}/ — capture hit a block/error page instead of the real site.`,
    };
  }

  // Content loaded (rawHtml has real <img> markup) but the browser never fetched
  // any image/stylesheet, with barely any requests overall — a hallmark of a
  // session that stalled/got challenged before real assets could load.
  const imgTagCount = (bundle.rawHtml.match(/<img\b/gi) ?? []).length;
  const imageRequests = bundle.requests.filter((r) => r.resourceType === "image").length;
  const styleRequests = bundle.requests.filter((r) => r.resourceType === "stylesheet").length;
  const scriptRequests = bundle.requests.filter((r) => r.resourceType === "script").length;
  if (imgTagCount >= 5 && imageRequests === 0 && styleRequests === 0 && scriptRequests <= 2) {
    return {
      ok: false,
      kind: "blocked",
      reason:
        `Blocked assets: raw HTML references ${imgTagCount} <img> tag(s) but the browser captured 0 image ` +
        `and 0 stylesheet requests (only ${bundle.requests.length} network requests total: ` +
        `${describeRequestCounts(bundle.requests)}) — the page likely stalled behind a bot challenge or ` +
        `capture error before its real assets could load.`,
    };
  }

  return { ok: true, reason: null };
}
