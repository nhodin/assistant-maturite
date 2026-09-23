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

/**
 * Body markers of an interstitial served INSTEAD of the document, for the ones
 * whose <title> is the site's own name and so never trip `isChallengeTitle`.
 *
 * DataDome is the case that forced this: it answers 200 with a 772-byte page
 * titled "kiabi.com" saying "Please enable JS and disable any ad blocker". On
 * title alone it reads as a real — if empty — document, so a diagnostic scored it
 * as "no SSR" when the site had simply refused us.
 *
 * Deliberately TECHNICAL signatures (vendor hostnames, script and element ids),
 * never editorial prose: a real page may well contain the words "access denied",
 * and a false positive here turns a measured verdict into an "à confirmer".
 */
const BLOCK_BODY_SIGNATURES: RegExp[] = [
  /captcha-delivery\.com/i, // DataDome
  /\bdd\s*=\s*\{\s*'rt'/i, // DataDome inline config object
  /please enable js and disable any ad blocker/i, // DataDome interstitial copy
  /cf-browser-verification/i, // Cloudflare
  /challenge-platform\/[^"']*\/orchestrate/i, // Cloudflare managed challenge
  /_incapsula_resource/i, // Imperva / Incapsula
  /incapsula incident id/i,
  /px-captcha|perimeterx/i, // PerimeterX / HUMAN
  /\/_sec\/cp_challenge\//i, // Akamai Bot Manager challenge assets
];

/**
 * Wording of a SELF-BRANDED block page — a site's own firewall notice, with no
 * vendor signature at all. printemps.com answers a product URL with a 10.9 KB
 * page titled "Printemps.com - Mode homme, femme et beauté de luxe" saying
 * "Une activité anormale a été détectée sur cette adresse IP … L'accès à notre
 * site a été bloqué automatiquement par notre pare-feu". Nothing above catches
 * it, and it scored as "no SSR" — a confident, wrong NOGO.
 *
 * Prose alone is NOT enough to conclude (an article may discuss firewalls), so a
 * match here only counts alongside a corroborating structural signal — see
 * `selfBrandedBlock`.
 */
const BLOCK_WORDINGS: RegExp[] = [
  /activité anormale/i,
  /bloqué automatiquement/i,
  /par notre pare-?feu/i,
  /votre adresse ip a été bloquée/i,
  /unusual activity (has been )?detected/i,
  /your (ip )?access (to this site )?has been blocked/i,
  /blocked by our (firewall|security service)/i,
  /why have i been blocked/i,
];

/** An IPv4 address shown in the page — block pages echo the visitor's IP. */
const VISITOR_IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/** Documents above this size are real pages; a block notice is always small. */
const BLOCK_PAGE_MAX_BYTES = 25_000;

/**
 * A site's own block page: blocking wording PLUS a corroborating structural
 * signal (tiny document, or the visitor's IP echoed back). Requiring two
 * independent signals is what keeps an editorial article about firewalls — long,
 * illustrated, no IP — from being read as a block.
 */
function selfBrandedBlock(html: string): boolean {
  if (!BLOCK_WORDINGS.some((re) => re.test(html))) return false;
  const small = Buffer.byteLength(html, "utf-8") < BLOCK_PAGE_MAX_BYTES;
  return small || VISITOR_IP_RE.test(html);
}

/**
 * Wording of a site-wide "unavailable / maintenance" notice. sarenza.com answers
 * Googlebot (and, at times, a plain fetch) with a 403 whose body is a full 550 KB
 * branded page — header, footer, fonts — titled "Sarenza | Serious about shoes
 * and clothes", with an h1 "Page momentanément indisponible." Too big for the
 * size corroboration above, no IP echoed, no vendor mark: it was measured as the
 * site and produced a confident NOGO.
 *
 * Scoped to the PAGE or SITE being unavailable, never to an item: a product page
 * saying "article temporairement indisponible" is a real page.
 */
const UNAVAILABLE_WORDINGS: RegExp[] = [
  /\b(page|site|service)\s+(momentanément|temporairement)\s+indisponible/i,
  /\ben\s+(cours\s+de\s+)?maintenance\b/i,
  /\b(site|page)\s+(is\s+)?(temporarily\s+)?(unavailable|down)\b/i,
  /\bservice\s+(temporarily\s+)?unavailable\b/i,
  /\b(under|down\s+for)\s+maintenance\b/i,
];

/** Words of visible text below which a document is a notice, not a page. */
const NOTICE_MAX_WORDS = 150;

/**
 * A site-wide unavailability notice. The wording alone is not enough (a help page
 * may explain maintenance windows), so it must be corroborated: either it IS the
 * page's headline (`<h1>` or `<title>`), or the document carries almost no text.
 */
function unavailablePage(html: string): boolean {
  const headline = [
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "",
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ") ?? "",
  ].join(" ");
  if (UNAVAILABLE_WORDINGS.some((re) => re.test(headline))) return true;
  if (!UNAVAILABLE_WORDINGS.some((re) => re.test(html))) return false;
  const text = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return text.length < NOTICE_MAX_WORDS;
}

/**
 * Same verdict, on a raw HTML string rather than on a live page's title — plus
 * the body signatures above, because the most common interstitials keep the
 * site's own <title>, and a site's own firewall notice carries no vendor mark
 * at all.
 */
export function isChallengeHtml(html: string): boolean {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  if (isChallengeTitle(title)) return true;
  if (BLOCK_BODY_SIGNATURES.some((re) => re.test(html))) return true;
  return selfBrandedBlock(html) || unavailablePage(html);
}

/**
 * Which signature matched, for an evidence string that names the reason rather
 * than asserting "blocked" without saying how we know. Null when none did.
 */
export function challengeSignature(html: string): string | null {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  if (isChallengeTitle(title)) return `titre d'interstitiel « ${title} »`;
  const hit = BLOCK_BODY_SIGNATURES.find((re) => re.test(html));
  if (!hit) return null;
  if (/captcha-delivery|'rt'|ad blocker/i.test(hit.source)) return "interstitiel DataDome";
  if (/cf-browser|challenge-platform/i.test(hit.source)) return "interstitiel Cloudflare";
  if (/incapsula/i.test(hit.source)) return "interstitiel Imperva/Incapsula";
  if (/perimeterx|px-captcha/i.test(hit.source)) return "interstitiel PerimeterX";
  if (/cp_challenge/i.test(hit.source)) return "interstitiel Akamai Bot Manager";
  return "interstitiel anti-bot";
}

/**
 * Same as `challengeSignature`, but also names a site's own firewall notice.
 * Kept separate from the vendor list so the reason stays precise: "pare-feu du
 * site" is a different fact from "interstitiel DataDome", and an operator
 * arbitrating the check needs to know which.
 */
export function blockSignature(html: string): string | null {
  const vendor = challengeSignature(html);
  if (vendor) return vendor;
  if (selfBrandedBlock(html)) {
    const ip = html.match(VISITOR_IP_RE)?.[0];
    return ip
      ? `page de blocage du site (adresse IP ${ip} refusée)`
      : "page de blocage du site (pare-feu maison)";
  }
  if (unavailablePage(html)) return "page « indisponible / maintenance » servie à la place du site";
  return null;
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
