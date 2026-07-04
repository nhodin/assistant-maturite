/**
 * Unit tests for the project score-evolution chart geometry (pure, no I/O).
 */
import { describe, it, expect } from "vitest";
import { buildProjectTrend, type TrendRunInput } from "../src/web/trend";

const PAGES = [
  { pageId: 1, label: "HP" },
  { pageId: 2, label: "PLP" },
  { pageId: 3, label: "PDP" },
];

function run(id: number, global: number | null, hp: number | null, plp: number | null, pdp: number | null): TrendRunInput {
  return {
    id,
    date: new Date(2026, 5, id, 12, 0, 0),
    global,
    pageScores: { 1: hp, 2: plp, 3: pdp },
  };
}

describe("buildProjectTrend", () => {
  it("returns null when there are no runs", () => {
    expect(buildProjectTrend([], PAGES)).toBeNull();
  });

  it("builds a global series plus one series per page", () => {
    const chart = buildProjectTrend([run(1, 60, 50, 70, 80)], PAGES)!;
    expect(chart).not.toBeNull();
    expect(chart.series.map((s) => s.key)).toEqual([
      "global",
      "page-1",
      "page-2",
      "page-3",
    ]);
    expect(chart.series[0].isGlobal).toBe(true);
    expect(chart.series.slice(1).every((s) => !s.isGlobal)).toBe(true);
  });

  it("places a single run at the horizontal centre", () => {
    const chart = buildProjectTrend([run(1, 50, 50, 50, 50)], PAGES)!;
    const expected = chart.pad.l + chart.innerW / 2;
    expect(chart.series[0].points[0].cx).toBeCloseTo(expected, 1);
  });

  it("maps score 100 to the top and 0 to the bottom of the plot area", () => {
    const chart = buildProjectTrend([run(1, 100, 0, 0, 0)], PAGES)!;
    expect(chart.series[0].points[0].cy).toBeCloseTo(chart.pad.t, 1);
    expect(chart.series[1].points[0].cy).toBeCloseTo(chart.pad.t + chart.innerH, 1);
  });

  it("spreads multiple runs across the x-axis and emits a path", () => {
    const chart = buildProjectTrend(
      [run(1, 40, 40, 40, 40), run(2, 60, 60, 60, 60), run(3, 80, 80, 80, 80)],
      PAGES,
    )!;
    const g = chart.series[0];
    expect(g.points).toHaveLength(3);
    expect(g.points[0].cx).toBeLessThan(g.points[1].cx);
    expect(g.points[1].cx).toBeLessThan(g.points[2].cx);
    expect(g.path.startsWith("M")).toBe(true);
    expect(chart.xLabels.map((x) => x.label)).toEqual(["#1", "#2", "#3"]);
  });

  it("breaks the line across runs with a missing (null) score", () => {
    const chart = buildProjectTrend(
      [run(1, 40, 40, null, 40), run(2, 60, null, null, 60), run(3, 80, 80, null, 80)],
      PAGES,
    )!;
    const hp = chart.series.find((s) => s.key === "page-1")!;
    // HP missing only in run #2 → two points, two separate segments (two "M").
    expect(hp.points).toHaveLength(2);
    expect((hp.path.match(/M/g) || []).length).toBe(2);
    const plp = chart.series.find((s) => s.key === "page-2")!;
    // PLP missing in every run → no points, empty path.
    expect(plp.points).toHaveLength(0);
    expect(plp.path).toBe("");
  });
});
