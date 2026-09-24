/**
 * GO / NOGO tallies for a diagnostic Speed/SEO project.
 *
 * A diagnostic scores nothing (see docs/DIAGNOSTIC.md), so a score-evolution
 * chart has nothing to draw on a diagnostic project. What the project page
 * shows instead is, per run, how many pages reached each verdict for Speed
 * (EdgeSpeed) and for SEO (EdgeSEO).
 *
 * Pure (no I/O) so it can be unit-tested. Only DONE pages carrying a
 * diagnostic are counted — the same rule the run view applies — and the pages
 * the run could not diagnose are reported apart, never folded into NOGO.
 */
import type { DiagVerdict } from "../prospect/types";

export interface VerdictTally {
  GO: number;
  NOGO: number;
  /** « À confirmer » — a check could not be measured and awaits arbitration. */
  UNKNOWN: number;
}

export interface DiagRunSummary {
  speed: VerdictTally;
  seo: VerdictTally;
  /** Pages that produced a diagnostic (DONE + diagJson). */
  diagnosed: number;
  /** Pages of the run without a diagnostic (failed, pending, interrupted). */
  notDiagnosed: number;
}

export interface DiagRunPageInput {
  status: string;
  diagJson: unknown;
}

const emptyTally = (): VerdictTally => ({ GO: 0, NOGO: 0, UNKNOWN: 0 });

function asVerdict(v: unknown): DiagVerdict {
  return v === "GO" || v === "NOGO" ? v : "UNKNOWN";
}

export function summarizeDiagRun(pages: DiagRunPageInput[]): DiagRunSummary {
  const speed = emptyTally();
  const seo = emptyTally();
  let diagnosed = 0;
  for (const rp of pages) {
    const d = rp.status === "DONE" ? (rp.diagJson as { speed?: unknown; seo?: unknown } | null) : null;
    if (!d) continue;
    diagnosed++;
    speed[asVerdict(d.speed)]++;
    seo[asVerdict(d.seo)]++;
  }
  return { speed, seo, diagnosed, notDiagnosed: pages.length - diagnosed };
}
