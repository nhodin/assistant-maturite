/**
 * Unit tests for the CrUX field-metric trend chart geometry (pure, no I/O).
 */
import { describe, it, expect } from "vitest";
import { buildCruxTrends, type CruxSnapshotInput } from "../src/web/crux-trend";

function snap(
  scopeKey: string,
  scopeLabel: string,
  day: number,
  vals: Partial<Pick<CruxSnapshotInput, "lcpMs" | "ttfbMs" | "inpMs" | "cls">>,
): CruxSnapshotInput {
  return {
    scopeKey,
    scopeLabel,
    date: new Date(2026, 6, day, 12, 0, 0),
    lcpMs: vals.lcpMs ?? null,
    ttfbMs: vals.ttfbMs ?? null,
    inpMs: vals.inpMs ?? null,
    cls: vals.cls ?? null,
  };
}

describe("buildCruxTrends", () => {
  it("returns [] with no snapshots", () => {
    expect(buildCruxTrends([])).toEqual([]);
  });

  it("skips a metric with no data and builds charts only for present metrics", () => {
    const charts = buildCruxTrends([
      snap("origin:a", "Origine · a", 1, { lcpMs: 2000, ttfbMs: 400 }),
    ]);
    const keys = charts.map((c) => c.key);
    expect(keys).toContain("lcpMs");
    expect(keys).toContain("ttfbMs");
    expect(keys).not.toContain("inpMs");
    expect(keys).not.toContain("cls");
  });

  it("builds one series per distinct scope", () => {
    const charts = buildCruxTrends([
      snap("origin:a", "Origine · a", 1, { lcpMs: 2000 }),
      snap("page:1", "PDP", 1, { lcpMs: 3000 }),
    ]);
    const lcp = charts.find((c) => c.key === "lcpMs")!;
    expect(lcp.series.map((s) => s.key)).toEqual(["origin:a", "page:1"]);
    expect(lcp.series[0].points).toHaveLength(1);
  });

  it("auto-scales the y-axis so the max value sits at or below the top tick", () => {
    const charts = buildCruxTrends([
      snap("origin:a", "a", 1, { lcpMs: 3200 }),
    ]);
    const lcp = charts.find((c) => c.key === "lcpMs")!;
    const topLabel = Number(lcp.yTicks[lcp.yTicks.length - 1].label);
    expect(topLabel).toBeGreaterThanOrEqual(3200);
    // The top tick maps to the top of the plot area.
    expect(lcp.yTicks[lcp.yTicks.length - 1].y).toBeCloseTo(lcp.pad.t, 1);
    // The zero tick maps to the bottom.
    expect(lcp.yTicks[0].label).toBe("0");
    expect(lcp.yTicks[0].y).toBeCloseTo(lcp.pad.t + lcp.innerH, 1);
  });

  it("spreads multiple timestamps across the x-axis and emits a path", () => {
    const charts = buildCruxTrends([
      snap("origin:a", "a", 1, { lcpMs: 2000 }),
      snap("origin:a", "a", 2, { lcpMs: 2500 }),
      snap("origin:a", "a", 3, { lcpMs: 1800 }),
    ]);
    const s = charts.find((c) => c.key === "lcpMs")!.series[0];
    expect(s.points).toHaveLength(3);
    expect(s.points[0].cx).toBeLessThan(s.points[1].cx);
    expect(s.points[1].cx).toBeLessThan(s.points[2].cx);
    expect(s.path.startsWith("M")).toBe(true);
  });

  it("breaks the line across a missing value", () => {
    const charts = buildCruxTrends([
      snap("origin:a", "a", 1, { lcpMs: 2000 }),
      snap("origin:a", "a", 2, {}), // missing lcp at t2
      snap("origin:a", "a", 3, { lcpMs: 2200 }),
    ]);
    const s = charts.find((c) => c.key === "lcpMs")!.series[0];
    expect(s.points).toHaveLength(2);
    expect((s.path.match(/M/g) || []).length).toBe(2);
  });

  it("formats CLS ticks with two decimals", () => {
    const charts = buildCruxTrends([snap("origin:a", "a", 1, { cls: 0.12 })]);
    const cls = charts.find((c) => c.key === "cls")!;
    expect(cls.yTicks[0].label).toBe("0.00");
  });
});
