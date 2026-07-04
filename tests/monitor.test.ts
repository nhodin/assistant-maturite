/**
 * Unit tests for the pure monitoring helpers (no DB / no network).
 */
import { describe, it, expect } from "vitest";
import { computeNextAt } from "../src/web/monitor";
import { parseCruxMetrics } from "../src/collector/crux";

describe("computeNextAt", () => {
  const from = new Date("2026-07-04T10:00:00.000Z");

  it("adds 24h for DAILY", () => {
    const next = computeNextAt("DAILY", from);
    expect(next.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("adds 7 days for WEEKLY", () => {
    const next = computeNextAt("WEEKLY", from);
    expect(next.getTime() - from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("parseCruxMetrics", () => {
  it("returns null when there is no record/metrics", () => {
    expect(parseCruxMetrics(null)).toBeNull();
    expect(parseCruxMetrics(undefined)).toBeNull();
    expect(parseCruxMetrics({})).toBeNull();
    expect(parseCruxMetrics({ record: {} })).toBeNull();
  });

  it("extracts p75 values including FCP", () => {
    const m = parseCruxMetrics({
      record: {
        metrics: {
          largest_contentful_paint: { percentiles: { p75: 2400 } },
          experimental_time_to_first_byte: { percentiles: { p75: 500 } },
          interaction_to_next_paint: { percentiles: { p75: 180 } },
          first_contentful_paint: { percentiles: { p75: 1600 } },
        },
      },
    });
    expect(m).toEqual({
      lcpMs: 2400,
      ttfbMs: 500,
      inpMs: 180,
      cls: undefined,
      fcpMs: 1600,
    });
  });

  it("parses CLS delivered as a decimal string", () => {
    const m = parseCruxMetrics({
      record: {
        metrics: {
          cumulative_layout_shift: { percentiles: { p75: "0.08" } },
        },
      },
    });
    expect(m?.cls).toBeCloseTo(0.08, 5);
  });

  it("leaves missing metrics undefined", () => {
    const m = parseCruxMetrics({
      record: {
        metrics: { largest_contentful_paint: { percentiles: { p75: 2000 } } },
      },
    });
    expect(m).toEqual({
      lcpMs: 2000,
      ttfbMs: undefined,
      inpMs: undefined,
      cls: undefined,
      fcpMs: undefined,
    });
  });
});
