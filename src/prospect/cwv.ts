/**
 * Core Web Vitals summary shown next to the Speed verdict of a diagnostic.
 *
 * INFORMATIONAL, never part of the verdict (see docs/DIAGNOSTIC.md "Informations
 * relevées, hors verdict"): a GO/NOGO says whether EdgeSpeed CAN work on the
 * page, the field p75 says how much there is to gain — the two read side by side.
 *
 * The record is the ORIGIN's, on the PHONE form factor, whatever the run's
 * device: it is the most widely available CrUX record (a PDP rarely has its own)
 * and mobile is where the prospect's traffic and pain are.
 */
import { fetchCruxHistory, fetchCruxMetrics } from "../collector/crux";

export type CwvMetric = "lcp" | "inp" | "cls";
export type CwvRating = "good" | "ni" | "poor";

/** Google's thresholds: ≤ good is "good", > poor is "poor", in between "needs improvement". */
export const CWV_THRESHOLDS: Record<CwvMetric, { good: number; poor: number }> = {
  lcp: { good: 2500, poor: 4000 }, // ms
  inp: { good: 200, poor: 500 }, // ms
  cls: { good: 0.1, poor: 0.25 },
};

/** How a p75 moved over the last months. Lower is better for all three metrics. */
export interface CwvTrend {
  from: number;
  to: number;
  /** `lastDate` of the two compared CrUX collection periods (yyyy-mm-dd). */
  fromDate: string;
  toDate: string;
  direction: "better" | "worse" | "stable";
}

export interface CwvSummary {
  /** The CrUX origin key that answered. */
  origin: string;
  formFactor: "PHONE";
  lcpMs?: number;
  inpMs?: number;
  cls?: number;
  /** Absent when the History API had nothing (or the run predates the field). */
  trend?: Partial<Record<CwvMetric, CwvTrend>>;
}

/**
 * Collection periods between the two compared points. The History API steps
 * weekly, so 13 periods ≈ 3 months — long enough to see a real move, short
 * enough to say something about the site as it is now.
 */
export const CWV_TREND_PERIODS = 13;

/**
 * Below this change a p75 is "stable": the larger of 5 % and an absolute floor,
 * because CrUX p75s wobble week to week and a 0.01 CLS move is noise, not news.
 */
const STABLE_FLOOR: Record<CwvMetric, number> = { lcp: 100, inp: 10, cls: 0.01 };

/**
 * Compare the latest point of a weekly p75 series with the one CWV_TREND_PERIODS
 * earlier — or the oldest available point when the series is shorter. Null when
 * fewer than two points exist.
 */
export function cwvTrend(
  metric: CwvMetric,
  series: (number | null)[],
  dates: string[],
): CwvTrend | null {
  let last = -1;
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) { last = i; break; }
  if (last < 1) return null;
  let first = -1;
  for (let i = Math.max(0, last - CWV_TREND_PERIODS); i < last; i++) if (series[i] != null) { first = i; break; }
  if (first < 0) return null;
  const from = series[first] as number;
  const to = series[last] as number;
  const delta = to - from;
  const stable = Math.abs(delta) < Math.max(STABLE_FLOOR[metric], Math.abs(from) * 0.05);
  return {
    from,
    to,
    fromDate: dates[first] ?? "",
    toDate: dates[last] ?? "",
    direction: stable ? "stable" : delta < 0 ? "better" : "worse",
  };
}

export function cwvRating(metric: CwvMetric, value: number): CwvRating {
  const t = CWV_THRESHOLDS[metric];
  if (value <= t.good) return "good";
  if (value <= t.poor) return "ni";
  return "poor";
}

/**
 * Fetch the mobile origin p75 for the origin of `url`. `undefined` when CrUX was
 * not queried (no API key, unparsable URL), `null` when CrUX has no data for it —
 * the UI tells "not collected" and "no field data" apart.
 */
export async function fetchOriginCwv(
  url: string,
  apiKey: string | undefined,
): Promise<CwvSummary | null | undefined> {
  if (!apiKey) return undefined;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return undefined;
  }
  const [m, h] = await Promise.all([
    fetchCruxMetrics({ origin }, apiKey, "PHONE"),
    fetchCruxHistory({ origin }, apiKey, "PHONE"),
  ]);
  if (!m || (m.lcpMs === undefined && m.inpMs === undefined && m.cls === undefined)) return null;
  const summary: CwvSummary = { origin, formFactor: "PHONE", lcpMs: m.lcpMs, inpMs: m.inpMs, cls: m.cls };
  if (h) {
    const trend: Partial<Record<CwvMetric, CwvTrend>> = {};
    const lcp = cwvTrend("lcp", h.lcpMs, h.dates);
    const inp = cwvTrend("inp", h.inpMs, h.dates);
    const cls = cwvTrend("cls", h.cls, h.dates);
    if (lcp) trend.lcp = lcp;
    if (inp) trend.inp = inp;
    if (cls) trend.cls = cls;
    if (Object.keys(trend).length) summary.trend = trend;
  }
  return summary;
}
