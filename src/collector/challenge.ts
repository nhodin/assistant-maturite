/**
 * Bot-challenge interstitials (Cloudflare "Just a moment…", Akamai "Pardon our
 * interruption", Imperva/Incapsula…).
 *
 * These pages are served *instead of* the site, usually with a 403, and replace
 * themselves with the real document a few seconds later once their JS proof of
 * work completes. Without the wait below the whole capture — cookie click,
 * interaction probe, scroll, metrics — runs against the interstitial, and the
 * capture is rejected downstream by `assessCaptureHealth`.
 *
 * SCOPE: this module only *waits*. It never clicks a checkbox, never solves a
 * CAPTCHA, never touches a challenge widget — letting a page finish loading is
 * patience, defeating an interactive human-verification step is not something
 * this tool does. An interactive challenge simply times out here and the capture
 * is reported as blocked; run headed (CLOAK_HEADLESS=0) and clear it by hand, or
 * have the audited origin allowlist the audit client.
 */
import type { Page } from "playwright";

/**
 * Interstitial <title> wordings. Narrower on purpose than sanity.ts's list: a
 * "Page not found" never resolves itself, so waiting on one is wasted capture
 * time. Only self-clearing challenge pages belong here.
 */
export const CHALLENGE_TITLE_PATTERNS: RegExp[] = [
  /just a moment/i, // Cloudflare JS challenge
  /attention required/i, // Cloudflare
  /pardon our interruption/i, // Akamai Bot Manager
  /checking your browser/i, // Cloudflare (legacy wording)
  /verifying you are human/i, // Cloudflare Turnstile interstitial
  /un moment/i, // Cloudflare, FR locale
  /are you a robot/i,
];

/** DOM markers, for interstitials whose <title> is the site's own. */
const CHALLENGE_SELECTORS = [
  "#challenge-running",
  "#cf-challenge-running",
  "#challenge-form",
  ".cf-browser-verification",
  "#px-captcha",
];

/**
 * How long to let a challenge run, from `CAPTURE_CHALLENGE_TIMEOUT_MS`.
 * 30s covers the usual Cloudflare/Akamai interstitial with margin; raise it for
 * an origin known to be slow, set it to 0 to skip the wait entirely (the capture
 * is then rejected as blocked, as before this phase existed).
 */
export function challengeTimeoutFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env.CAPTURE_CHALLENGE_TIMEOUT_MS ?? "").trim();
  if (raw === "") return 30000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30000;
}

export interface ChallengeOutcome {
  /** A challenge interstitial was on screen when we first looked. */
  challenged: boolean;
  /** It resolved on its own and a real document took its place. */
  cleared: boolean;
  /** Time spent waiting, ms. */
  waitedMs: number;
}

/** True when `title` matches a known self-clearing challenge interstitial. */
export function isChallengeTitle(title: string): boolean {
  return CHALLENGE_TITLE_PATTERNS.some((re) => re.test(title));
}

/** Same verdict, on a raw HTML string rather than on a live page's title. */
export function isChallengeHtml(html: string): boolean {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  return isChallengeTitle(title);
}

/**
 * True when the page currently shows a challenge interstitial. Errors (the
 * execution context is destroyed mid-navigation — exactly what happens when the
 * challenge hands over to the real page) count as "still on it": the next poll
 * runs against the new document and settles it either way.
 */
async function looksLikeChallenge(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    if (isChallengeTitle(title)) return true;
    return await page.evaluate(
      (selectors) => selectors.some((sel) => document.querySelector(sel) !== null),
      CHALLENGE_SELECTORS,
    );
  } catch {
    return true;
  }
}

/**
 * Wait for a non-interactive challenge to hand over to the real page.
 *
 * Returns immediately (`challenged: false`) on a normal page, so the healthy
 * path pays one `page.title()` call. When the interstitial clears, the real
 * document's load is awaited before returning — the caller can then treat the
 * capture as starting from scratch (the perf init script re-runs on the new
 * document; network requests collected so far belong to the interstitial and are
 * the caller's to discard).
 */
export async function waitForChallengeToSettle(
  page: Page,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ChallengeOutcome> {
  const timeoutMs = opts.timeoutMs ?? challengeTimeoutFromEnv();
  const pollMs = opts.pollMs ?? 500;
  const start = Date.now();

  if (!(await looksLikeChallenge(page))) {
    return { challenged: false, cleared: false, waitedMs: 0 };
  }

  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, pollMs));
    if (!(await looksLikeChallenge(page))) {
      // Let the document that replaced the interstitial actually load, so the
      // caller's own networkidle/scroll phases see the real page.
      await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      return { challenged: true, cleared: true, waitedMs: Date.now() - start };
    }
  }

  return { challenged: true, cleared: false, waitedMs: Date.now() - start };
}
