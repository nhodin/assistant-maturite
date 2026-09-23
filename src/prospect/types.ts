/**
 * Prospect diagnostic — shared contract. See ../../../docs/DIAGNOSTIC.md for the spec.
 *
 * This is NOT the maturity barème: nothing here is scored on 0–100. A diagnostic
 * answers one question per page — can EdgeSpeed and/or EdgeSEO work on this site —
 * and the answer is categorical.
 *
 * Design rule, mirroring `core/types.ts`: a check is a PURE function of an
 * `EvidenceBundle`. It decides `passed` + `evidence` (+ `unknown` when it cannot
 * measure) and never does I/O. The verdict is DERIVED from the checks, never
 * computed inside one.
 */
import type { EvidenceBundle, NavigationProbe, StackProbe } from "../core";
import type { SsrMetrics } from "./detect";

/** GO / NOGO, or UNKNOWN when a check could not be measured and awaits arbitration. */
export type DiagVerdict = "GO" | "NOGO" | "UNKNOWN";

/** The two checks the verdict is built from. */
export type DiagCheckId = "ssr.user" | "ssr.bot";

/**
 * One measured check. Carries the SAME `unknown` / `manual` / `auto` triplet as
 * `ControlResult`, deliberately: the diagnostic reuses the maturity side's
 * manual-correction route and its "provisional result" presentation verbatim.
 *
 * `unknown` is not a nuance of `passed`: `passed` MUST be false when the check
 * could not measure, so an unmeasurable check never flatters a verdict.
 */
export interface DiagCheck {
  id: DiagCheckId;
  label: string;
  passed: boolean;
  /** Short justification carrying the concrete data point, as in the MD reports. */
  evidence: string;
  /** Could not measure — e.g. the crawler fetch was blocked by a WAF. */
  unknown?: boolean;
  /** An operator decided this by hand on a stored result. */
  manual?: boolean;
  /** The measured verdict, stashed on the FIRST manual correction. Never overwritten. */
  auto?: { passed: boolean; evidence: string; unknown?: boolean };
  /**
   * The raw numbers behind the verdict, when it could be measured. Stored so a
   * threshold change can be replayed on past results instead of recapturing.
   */
  metrics?: SsrMetrics;
  /**
   * A reasoned indication attached to an `unknown` check — NEVER a verdict.
   *
   * It exists for the case where the crawler fetch was refused while the visitor
   * document is server-rendered: dynamic rendering only ever goes one way (a site
   * serves MORE to crawlers, never less), so the crawler almost certainly sees
   * content too. That reasoning makes the operator's arbitration informed instead
   * of blind — but it is not a measurement, so `passed` stays false and the check
   * stays « à confirmer » until somebody decides. The UI must present it as a
   * note under the "à confirmer" badge, never as a GO.
   */
  presumption?: string;
}

/** A non-blocking risk worth naming in the report. Never affects the verdict. */
export interface VigilanceFlag {
  /** Stable id, e.g. "csp.strict", "html.setcookie", "sw.registered", "cdn.frontend". */
  id: string;
  label: string;
  /** The observed fact, e.g. "script-src 'nonce-…' — inlining at the edge is blocked". */
  detail: string;
}

/** Diagnostic of ONE page. The verdict is rendered at this granularity. */
export interface PageDiagnostic {
  url: string;
  /** Inventory label / page kind, when known. */
  label?: string;
  checks: DiagCheck[];
  speed: DiagVerdict;
  seo: DiagVerdict;
  /**
   * SSR for crawlers only, recognised POSITIVELY (prerender headers, stripped app
   * scripts, no hydration payload) — a deliberate architecture, not an anomaly.
   */
  dynamicRendering: boolean;
  dynamicRenderingEvidence?: string;
  /** Informational, never part of the verdict. Absent when the probe did not run. */
  stack?: StackProbe;
  navigation?: NavigationProbe;
  flags: VigilanceFlag[];
}

/** Diagnostic of a site: one entry per captured page, plus whether they disagree. */
export interface SiteDiagnostic {
  site: string;
  pages: PageDiagnostic[];
  /**
   * The site's pages do not all reach the same verdict. Deliberately NOT collapsed
   * into a single GO/NOGO: a PDP carries more optimisation volume than a home, and
   * the divergence is itself the commercial finding.
   */
  divergent: boolean;
}

/** A pure check: `EvidenceBundle` in, verdict + evidence out. */
export type DiagCheckFn = (e: EvidenceBundle) => Omit<DiagCheck, "id" | "label">;
