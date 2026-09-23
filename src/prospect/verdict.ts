/**
 * Prospect diagnostic — verdict engine + run-level aggregation. Spec:
 * docs/DIAGNOSTIC.md, section "Ce qu'on mesure" for the decision table, and
 * "Granularité" for why pages are never collapsed into one verdict.
 *
 * Pure decision logic only — no I/O, no DB, no browser. `diagnosePage` calls the
 * pure checks from ./checks and assembles a `PageDiagnostic`; everything here is
 * unit-testable from hand-built `DiagCheck[]`/`EvidenceBundle` values.
 */
import type { EvidenceBundle } from "../core";
import {
  detectDynamicRendering,
  detectVigilanceFlags,
  ssrBotCheck,
  ssrUserCheck,
} from "./checks";
import type { DiagCheck, DiagCheckId, DiagVerdict, PageDiagnostic, SiteDiagnostic } from "./types";

/* ── decision table ───────────────────────────────────────────────────────── */

function findCheck(checks: DiagCheck[], id: DiagCheckId): DiagCheck | undefined {
  return checks.find((c) => c.id === id);
}

/**
 * One check's effective verdict, feeding the decision table below.
 *
 * - `manual: true` always wins and is read as an ordinary pass/fail: an operator
 *   has already arbitrated this check, so it must never come back as UNKNOWN.
 * - Otherwise `unknown: true` (the check could not measure — e.g. the crawler
 *   fetch was blocked by a WAF) yields UNKNOWN. This is not a nuance of `passed`:
 *   `DiagCheck.passed` is required to be `false` on an unmeasurable check (see
 *   ./types.ts), so an unmeasured check can never silently read as a pass here —
 *   but it must ALSO never read as a flat NOGO, which is why `unknown` is
 *   checked before `passed`.
 * - A missing check (checks.ts should always supply both `ssr.user`/`ssr.bot`)
 *   is treated as a measured failure rather than silently defaulting to GO.
 */
function verdictOfCheck(check: DiagCheck | undefined): DiagVerdict {
  if (!check) return "NOGO";
  if (check.manual) return check.passed ? "GO" : "NOGO";
  if (check.unknown) return "UNKNOWN";
  return check.passed ? "GO" : "NOGO";
}

/**
 * The decision table from docs/DIAGNOSTIC.md:
 *
 * | ssr.user | ssr.bot           | speed | seo               |
 * |----------|-------------------|-------|-------------------|
 * | pass     | pass              | GO    | GO                |
 * | fail     | pass              | NOGO  | GO (dynamic rendering) |
 * | pass     | fail-but-unknown  | GO    | UNKNOWN (à confirmer)  |
 * | fail     | fail              | NOGO  | NOGO              |
 *
 * EdgeSpeed optimises the HTML served to VISITORS, so its verdict depends only
 * on `ssr.user`. EdgeSEO acts on the HTML served to CRAWLERS, so its verdict
 * depends only on `ssr.bot`. The two columns are therefore independent — every
 * row above is just the pairing of two independent per-check mappings, and
 * there is deliberately no cross-term: EdgeSEO does NOT drop to NOGO because
 * EdgeSpeed failed, and vice versa. Written as two explicit lookups rather than
 * boolean arithmetic so each row of the table above is traceable in the code.
 */
export function decide(checks: DiagCheck[]): { speed: DiagVerdict; seo: DiagVerdict } {
  const speed = verdictOfCheck(findCheck(checks, "ssr.user"));
  const seo = verdictOfCheck(findCheck(checks, "ssr.bot"));
  return { speed, seo };
}

/* ── page diagnostic ──────────────────────────────────────────────────────── */

/**
 * Run every check on `e`, derive the verdict, and attach the informational data
 * (stack/navigation/flags/dynamic-rendering) straight from the bundle. That data
 * NEVER feeds `decide` — it is display-only, wired here purely for storage next
 * to the verdict it does not influence.
 */
export function diagnosePage(e: EvidenceBundle, label?: string): PageDiagnostic {
  const checks: DiagCheck[] = [ssrUserCheck(e), ssrBotCheck(e)];
  const { speed, seo } = decide(checks);
  const dynamic = detectDynamicRendering(e);
  const flags = detectVigilanceFlags(e);

  return {
    url: e.url,
    ...(label !== undefined ? { label } : {}),
    checks,
    speed,
    seo,
    dynamicRendering: dynamic.detected,
    ...(dynamic.evidence !== undefined ? { dynamicRenderingEvidence: dynamic.evidence } : {}),
    ...(e.stack !== undefined ? { stack: e.stack } : {}),
    ...(e.navigation !== undefined ? { navigation: e.navigation } : {}),
    flags,
  };
}

/* ── site diagnostic ──────────────────────────────────────────────────────── */

/**
 * Assemble a site's pages into a `SiteDiagnostic`. Deliberately NOT collapsed
 * into one GO/NOGO (see docs/DIAGNOSTIC.md, "Granularité") — `divergent` only
 * flags that the pages disagree, so the UI can surface it (and weigh a PDP more
 * than a home) without this function inventing an aggregate verdict.
 */
export function siteDiagnostic(site: string, pages: PageDiagnostic[]): SiteDiagnostic {
  const speeds = new Set(pages.map((p) => p.speed));
  const seos = new Set(pages.map((p) => p.seo));
  const divergent = speeds.size > 1 || seos.size > 1;
  return { site, pages, divergent };
}

/* ── manual correction / cheap re-derivation ─────────────────────────────── */

/** The three actions a manual correction can take on a stored check. */
export type DiagManualVerdict = "pass" | "fail" | "auto";

/**
 * Apply a manual correction to ONE check of a stored `checks` array, mirroring
 * the maturity side's `ControlResult` mechanics (engine/score.ts,
 * web/routes/runs.ts): the measured verdict is stashed under `auto` on the
 * FIRST correction only (so a second correction never loses the original
 * measurement), "auto" restores it, and `unknown` is left untouched either way
 * — it is what lets a restore ("↺ mesuré") put the check back to "à confirmer"
 * (`countPendingDiagConfirmations` only excludes a check while `manual` is set).
 *
 * Pure: returns a NEW array, never mutates `checks`. Does not touch `speed`/
 * `seo` — call `decide` (or `rescorePageDiagnostic`) on the result to
 * re-derive them, exactly the cheap-rescore property `engine/score.ts` has for
 * the maturity side.
 */
export function applyManualDiagCheck(
  checks: DiagCheck[],
  checkId: DiagCheckId,
  verdict: DiagManualVerdict,
): DiagCheck[] {
  return checks.map((c): DiagCheck => {
    if (c.id !== checkId) return c;

    if (verdict === "auto") {
      // Undo: only possible while the measured verdict is still stashed.
      if (!c.auto) return c;
      const restored: DiagCheck = {
        ...c,
        passed: c.auto.passed,
        evidence: c.auto.evidence,
      };
      delete restored.manual;
      delete restored.auto;
      if (c.auto.unknown === true) restored.unknown = true;
      else delete restored.unknown;
      return restored;
    }

    // Stashed on the FIRST correction only.
    const auto = c.auto ?? {
      passed: c.passed,
      evidence: c.evidence,
      ...(c.unknown === true ? { unknown: true } : {}),
    };
    const was = auto.unknown ? "à confirmer" : auto.passed ? "✓" : "✗";
    return {
      ...c,
      passed: verdict === "pass",
      manual: true,
      auto,
      evidence: `Corrigé manuellement (mesuré : ${was} — ${auto.evidence})`,
    };
  });
}

/**
 * Re-derive a page's `speed`/`seo` from its (possibly manually-corrected)
 * `checks` — without recapturing the page. Leaves every other field
 * (`dynamicRendering`, `stack`, `navigation`, `flags`) untouched: they are
 * informational and were never part of the verdict to begin with.
 */
export function rescorePageDiagnostic(page: PageDiagnostic): PageDiagnostic {
  const { speed, seo } = decide(page.checks);
  return { ...page, speed, seo };
}

/* ── "à confirmer" bookkeeping ────────────────────────────────────────────── */

/**
 * How many checks across `pages` still need a human verdict: flagged `unknown`
 * and not yet arbitrated (`manual` not set). Mirrors
 * `engine/score.ts#countPendingConfirmations` for the diagnostic side, so the
 * UI can flag a diagnostic as provisional the same way it does a maturity score.
 */
export function countPendingDiagConfirmations(pages: PageDiagnostic[]): number {
  let n = 0;
  for (const p of pages) {
    for (const c of p.checks) {
      if (c.unknown === true && c.manual !== true) n += 1;
    }
  }
  return n;
}
