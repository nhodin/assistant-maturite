/**
 * Prospect diagnostic — the measured checks. Spec: docs/DIAGNOSTIC.md.
 *
 * Thin wrappers over `detect.ts`'s pure detectors: this module owns the
 * `DiagCheck`/`VigilanceFlag` shaping (ids, French labels, the `unknown` cases),
 * `detect.ts` owns the actual measurement.
 */
import type { EvidenceBundle } from "../core";
import type { DiagCheck, VigilanceFlag } from "./types";
import {
  evaluateSsr,
  selectVisitorDocument,
  detectDynamicRendering as detectDynamicRenderingFacts,
  vigilanceFlags,
} from "./detect";

/**
 * Is the page's main content in the HTML served to a normal visitor, before JS?
 *
 * `unknown` when the document we got is an anti-bot interstitial rather than the
 * page. Measuring SSR on a block page reads as "no SSR" and produces a confident,
 * WRONG NOGO — Kiabi was scored that way off a 772-byte DataDome interstitial
 * titled with the site's own name. The crawler side has always had this guard;
 * the visitor side needs it just as much, and for the same reason: an
 * unmeasurable check is « à confirmer », never a verdict.
 */
export function ssrUserCheck(e: EvidenceBundle): DiagCheck {
  // Refused documents are set aside — a 4xx/5xx whatever it looks like (sarenza's
  // 403 is a full branded page), or a block page — and the visitor is judged on
  // the better of the clean ones: the direct fetch or the browser's own document.
  const { chosen, refused, measured } = selectVisitorDocument(e);
  if (chosen === null) {
    return {
      id: "ssr.user",
      label: "SSR — utilisateur",
      passed: false,
      unknown: true,
      evidence:
        `le document servi au visiteur n'est pas la page (${refused.join(" ; ")}) — ` +
        `le SSR n'a pas pu être mesuré, à confirmer manuellement`,
    };
  }
  // Say where the measured document came from when it is not the usual one.
  const other = measured.find((m) => m !== chosen);
  const origin =
    chosen.source !== "browser"
      ? ""
      : other
        ? `document reçu par le navigateur (le fetch direct n'a reçu que ${other.result.metrics.rawWords} mots) — `
        : `document reçu par le navigateur (${refused.join(" ; ")}) — `;
  return {
    id: "ssr.user",
    label: "SSR — utilisateur",
    passed: chosen.result.passed,
    evidence: origin + chosen.result.evidence,
    metrics: chosen.result.metrics,
  };
}

/**
 * What the VISITOR document lets us suppose about the crawler one, when the
 * crawler fetch was refused. Null when it lets us suppose nothing.
 *
 * The reasoning: dynamic rendering only ever goes ONE way — a site serves MORE
 * to crawlers than to visitors (prerendering), never less, because withholding
 * content from Googlebot would wreck its own SEO. So a page that is
 * server-rendered for a visitor is almost certainly server-rendered for a
 * crawler too.
 *
 * "Almost certainly" is not "measured": this returns a NOTE, never a verdict.
 * The check stays `unknown` and `passed: false` — see `DiagCheck.presumption`.
 * No note at all when the visitor side failed or was itself blocked: there is
 * then nothing to reason from, and inventing a direction would be worse than
 * saying nothing.
 */
function botPresumption(e: EvidenceBundle): string | null {
  const visitor = selectVisitorDocument(e).chosen; // null: the visitor was refused too
  if (visitor === null || !visitor.result.passed) return null;
  const user = visitor.result;
  return (
    `le HTML servi au visiteur est rendu côté serveur ` +
    `(${user.metrics.rawWords} mots, ancrage et images présents) ; un site qui sert le SSR ` +
    `à ses visiteurs ne le retire pas aux crawlers — présomption favorable, à confirmer`
  );
}

/** Same question, on the HTML served to a crawler. `unknown` when the bot was blocked. */
export function ssrBotCheck(e: EvidenceBundle): DiagCheck {
  if (e.bot === null) {
    return {
      id: "ssr.bot",
      label: "SSR — crawler",
      passed: false,
      unknown: true,
      evidence: "aucune capture crawler disponible pour cette page (fetch bot non exécuté)",
    };
  }
  if (e.bot.blocked) {
    const presumption = botPresumption(e);
    return {
      id: "ssr.bot",
      label: "SSR — crawler",
      passed: false,
      unknown: true,
      evidence:
        `fetch crawler bloqué${e.bot.blockReason ? ` (${e.bot.blockReason})` : ""} — à confirmer manuellement`,
      ...(presumption ? { presumption } : {}),
    };
  }
  const result = evaluateSsr(e.bot.html, e.renderedHtml);
  return {
    id: "ssr.bot",
    label: "SSR — crawler",
    passed: result.passed,
    evidence: result.evidence,
    metrics: result.metrics,
  };
}

/** SSR for crawlers only, recognised positively (prerender.io, Rendertron, CDN prerender). */
export function detectDynamicRendering(
  e: EvidenceBundle,
): { detected: boolean; evidence?: string } {
  return detectDynamicRenderingFacts(e);
}

/** Non-blocking risks worth naming: strict CSP, Set-Cookie on HTML, service worker, CDN. */
export function detectVigilanceFlags(e: EvidenceBundle): VigilanceFlag[] {
  return vigilanceFlags(e).map((f) => ({ id: f.id, label: f.label, detail: f.detail }));
}
