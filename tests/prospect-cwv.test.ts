/**
 * CWV summary of a diagnostic: the mobile ORIGIN p75, coloured with Google's
 * thresholds. Informational — never part of the verdict.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { CWV_TREND_PERIODS, cwvRating, cwvTrend, fetchOriginCwv } from "../src/prospect/cwv"
import { parseCruxHistory } from "../src/collector/crux"

afterEach(() => vi.unstubAllGlobals())

describe("cwvRating", () => {
  it("uses Google's good / needs-improvement / poor thresholds, bounds inclusive on the good side", () => {
    expect(cwvRating("lcp", 2500)).toBe("good")
    expect(cwvRating("lcp", 2501)).toBe("ni")
    expect(cwvRating("lcp", 4000)).toBe("ni")
    expect(cwvRating("lcp", 4001)).toBe("poor")
    expect(cwvRating("inp", 200)).toBe("good")
    expect(cwvRating("inp", 350)).toBe("ni")
    expect(cwvRating("inp", 501)).toBe("poor")
    expect(cwvRating("cls", 0.1)).toBe("good")
    expect(cwvRating("cls", 0.2)).toBe("ni")
    expect(cwvRating("cls", 0.3)).toBe("poor")
  })
})

describe("cwvTrend", () => {
  const dates = Array.from({ length: 20 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`)

  it("compares the latest point with the one 13 periods (~3 months) earlier", () => {
    const series = Array.from({ length: 20 }, (_, i) => 4000 - i * 50) // 4000 → 3050
    const t = cwvTrend("lcp", series, dates)!
    expect(t.from).toBe(series[19 - CWV_TREND_PERIODS])
    expect(t.to).toBe(3050)
    expect(t.fromDate).toBe(dates[19 - CWV_TREND_PERIODS])
    expect(t.direction).toBe("better")
  })

  it("says worse when the p75 went up, stable within 5 % / the absolute floor", () => {
    expect(cwvTrend("inp", [150, 250], ["a", "b"])!.direction).toBe("worse")
    expect(cwvTrend("lcp", [3000, 3080], ["a", "b"])!.direction).toBe("stable") // < 5 %
    expect(cwvTrend("cls", [0.05, 0.058], ["a", "b"])!.direction).toBe("stable") // < 0.01
    expect(cwvTrend("cls", [0.05, 0.08], ["a", "b"])!.direction).toBe("worse")
  })

  it("skips missing points and falls back to the oldest one on a short series", () => {
    const t = cwvTrend("lcp", [null, 5000, null, 3000, null], ["a", "b", "c", "d", "e"])!
    expect(t).toMatchObject({ from: 5000, to: 3000, fromDate: "b", toDate: "d", direction: "better" })
  })

  it("is null with fewer than two points", () => {
    expect(cwvTrend("lcp", [null, 3000], ["a", "b"])).toBeNull()
    expect(cwvTrend("lcp", [], [])).toBeNull()
  })
})

describe("parseCruxHistory", () => {
  it("aligns the p75 series on the collection periods, CLS strings and NaN handled", () => {
    const h = parseCruxHistory({
      record: {
        metrics: {
          largest_contentful_paint: { percentilesTimeseries: { p75s: [3200, 3100] } },
          cumulative_layout_shift: { percentilesTimeseries: { p75s: ["0.12", "NaN"] } },
        },
        collectionPeriods: [
          { lastDate: { year: 2026, month: 6, day: 7 } },
          { lastDate: { year: 2026, month: 6, day: 14 } },
        ],
      },
    })!
    expect(h.dates).toEqual(["2026-06-07", "2026-06-14"])
    expect(h.lcpMs).toEqual([3200, 3100])
    expect(h.cls).toEqual([0.12, null])
    expect(h.inpMs).toEqual([null, null])
  })
})

describe("fetchOriginCwv", () => {
  it("attaches the trend from the History API", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes("queryHistoryRecord")
        ? {
            record: {
              metrics: { largest_contentful_paint: { percentilesTimeseries: { p75s: [4200, 3100] } } },
              collectionPeriods: [
                { lastDate: { year: 2026, month: 6, day: 7 } },
                { lastDate: { year: 2026, month: 9, day: 6 } },
              ],
            },
          }
        : { record: { metrics: { largest_contentful_paint: { percentiles: { p75: 3100 } } } } },
    })))
    const cwv = await fetchOriginCwv("https://www.example.com/", "k")
    expect(cwv!.trend).toEqual({
      lcp: { from: 4200, to: 3100, fromDate: "2026-06-07", toDate: "2026-09-06", direction: "better" },
    })
  })

  it("is not queried without an API key", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect(await fetchOriginCwv("https://www.example.com/p/1", undefined)).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("queries the ORIGIN on the PHONE form factor and keeps LCP / INP / CLS", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        record: {
          metrics: {
            largest_contentful_paint: { percentiles: { p75: 3100 } },
            interaction_to_next_paint: { percentiles: { p75: 180 } },
            cumulative_layout_shift: { percentiles: { p75: "0.05" } },
          },
        },
      }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const cwv = await fetchOriginCwv("https://www.example.com/p/1?x=2", "k")
    expect(cwv).toEqual({ origin: "https://www.example.com", formFactor: "PHONE", lcpMs: 3100, inpMs: 180, cls: 0.05 })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ formFactor: "PHONE", origin: "https://www.example.com" })
  })

  it("returns null when CrUX has no record for the origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    expect(await fetchOriginCwv("https://tiny.example", "k")).toBeNull()
  })
})
