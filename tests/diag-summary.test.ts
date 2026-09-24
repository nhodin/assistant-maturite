/**
 * GO/NOGO tallies shown on a diagnostic project's page (pure, no I/O).
 */
import { describe, it, expect } from "vitest";
import { summarizeDiagRun } from "../src/web/diag-summary";

const page = (speed: string, seo: string) => ({ status: "DONE", diagJson: { speed, seo } });

describe("summarizeDiagRun", () => {
  it("counts Speed and SEO verdicts independently", () => {
    const s = summarizeDiagRun([page("GO", "NOGO"), page("GO", "GO"), page("NOGO", "UNKNOWN")]);
    expect(s.speed).toEqual({ GO: 2, NOGO: 1, UNKNOWN: 0 });
    expect(s.seo).toEqual({ GO: 1, NOGO: 1, UNKNOWN: 1 });
    expect(s.diagnosed).toBe(3);
    expect(s.notDiagnosed).toBe(0);
  });

  it("reports undiagnosed pages apart, never as NOGO", () => {
    const s = summarizeDiagRun([
      page("GO", "GO"),
      { status: "FAILED", diagJson: null },
      // A stale diagnostic on a non-DONE page (mid-recapture) is ignored, like the run view does.
      { status: "RUNNING", diagJson: { speed: "NOGO", seo: "NOGO" } },
    ]);
    expect(s.speed).toEqual({ GO: 1, NOGO: 0, UNKNOWN: 0 });
    expect(s.seo).toEqual({ GO: 1, NOGO: 0, UNKNOWN: 0 });
    expect(s.diagnosed).toBe(1);
    expect(s.notDiagnosed).toBe(2);
  });

  it("returns zero tallies for a run without pages", () => {
    const s = summarizeDiagRun([]);
    expect(s.speed).toEqual({ GO: 0, NOGO: 0, UNKNOWN: 0 });
    expect(s.diagnosed).toBe(0);
  });
});
