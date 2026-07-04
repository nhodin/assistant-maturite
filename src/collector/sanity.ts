/**
 * Capture health check — catches captures that landed on an error/bot-block page
 * instead of the real site, so the run executor can reject them instead of silently
 * scoring garbage (e.g. an Akamai/Cloudflare challenge page, a 403 mid-capture, or a
 * page whose assets never actually loaded).
 */
import type { EvidenceBundle } from "../core";

export interface CaptureHealth {
  ok: boolean;
  /** Human-readable reason, set only when ok === false. */
  reason: string | null;
}

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
  // A legitimate document response is never 4xx/5xx. Any such request (initial nav
  // or a later reload during the interaction probe) means the browser session was
  // blocked or the URL is broken — never a real render.
  const blockedDoc = bundle.requests.find(
    (r) => r.resourceType === "document" && r.status >= 400,
  );
  if (blockedDoc) {
    return {
      ok: false,
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
      reason:
        `Blocked assets: raw HTML references ${imgTagCount} <img> tag(s) but the browser captured 0 image ` +
        `and 0 stylesheet requests (only ${bundle.requests.length} network requests total: ` +
        `${describeRequestCounts(bundle.requests)}) — the page likely stalled behind a bot challenge or ` +
        `capture error before its real assets could load.`,
    };
  }

  return { ok: true, reason: null };
}
