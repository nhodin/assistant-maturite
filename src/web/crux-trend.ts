/**
 * Build the geometry for the CrUX field-metric trend charts of a monitored project.
 *
 * Pure (no I/O) so it can be unit-tested. Given the CrUX snapshots of a project in
 * chronological order, it produces one chart per metric (LCP, TTFB, INP, CLS), each
 * with one line series per scope (the site origin(s) + each project page URL).
 *
 * Unlike the maturity trend (fixed 0–100 y-axis), CrUX values have no fixed range,
 * so each chart's y-axis is auto-scaled to the min/max of the plotted values with a
 * little headroom, and always includes 0 as the baseline.
 */

/** The metrics we chart, in display order. */
export type CruxMetricKey = "lcpMs" | "ttfbMs" | "inpMs" | "cls";

export interface CruxMetricDef {
  key: CruxMetricKey;
  /** Chart title, e.g. "LCP (ms)". */
  label: string;
  /** Number of decimals for tick labels (0 for ms, 2 for CLS). */
  decimals: number;
}

export const CRUX_METRICS: CruxMetricDef[] = [
  { key: "lcpMs", label: "LCP (ms)", decimals: 0 },
  { key: "ttfbMs", label: "TTFB (ms)", decimals: 0 },
  { key: "inpMs", label: "INP (ms)", decimals: 0 },
  { key: "cls", label: "CLS", decimals: 2 },
];

/** One CrUX sample at a point in time for a given scope. */
export interface CruxSnapshotInput {
  /** Stable key identifying the scope (origin URL or page id string). */
  scopeKey: string;
  /** Human label for the legend, e.g. "Origine · brand.com" or "PDP". */
  scopeLabel: string;
  date: Date;
  lcpMs: number | null;
  ttfbMs: number | null;
  inpMs: number | null;
  cls: number | null;
}

export interface CruxTrendPoint {
  cx: number;
  cy: number;
  value: number;
  title: string;
}

export interface CruxTrendSeries {
  key: string;
  label: string;
  color: string;
  /** SVG path "d" (gaps where a value is null). Empty when no points. */
  path: string;
  points: CruxTrendPoint[];
}

export interface CruxTrendChart {
  key: CruxMetricKey;
  label: string;
  width: number;
  height: number;
  innerW: number;
  innerH: number;
  pad: { t: number; r: number; b: number; l: number };
  yTicks: { y: number; label: string }[];
  xLabels: { x: number; label: string }[];
  series: CruxTrendSeries[];
}

const COLORS = [
  "#0d47a1",
  "#00897b",
  "#8e24aa",
  "#ef6c00",
  "#5d4037",
  "#c62828",
  "#1565c0",
  "#558b2f",
];

const PAD = { t: 14, r: 16, b: 34, l: 46 };
const WIDTH = 720;
const HEIGHT = 240;

function fmtDate(d: Date): string {
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtValue(v: number, decimals: number): string {
  return v.toFixed(decimals);
}

/**
 * Pick a "nice" upper bound and tick step for an auto-scaled axis whose values
 * span [0, max]. Returns { top, step } so ticks are 0, step, 2·step, … top.
 */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.5 };
  const rough = max / 4; // aim for ~4 intervals
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  const step = nice * mag;
  const top = Math.ceil(max / step) * step;
  return { top, step };
}

/** Distinct scopes in first-seen order, preserving their labels. */
function scopeDefs(snaps: CruxSnapshotInput[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const s of snaps) {
    if (!seen.has(s.scopeKey)) seen.set(s.scopeKey, s.scopeLabel);
  }
  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}

/** Distinct sorted collection timestamps (x-axis positions). */
function timeAxis(snaps: CruxSnapshotInput[]): Date[] {
  const seen = new Map<number, Date>();
  for (const s of snaps) seen.set(s.date.getTime(), s.date);
  return [...seen.values()].sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Build one chart per CrUX metric, or null when there is nothing to plot
 * (no snapshots, or no non-null value for any metric).
 */
export function buildCruxTrends(snaps: CruxSnapshotInput[]): CruxTrendChart[] {
  if (snaps.length === 0) return [];

  const scopes = scopeDefs(snaps);
  const times = timeAxis(snaps);
  const n = times.length;
  const timeIndex = new Map<number, number>();
  times.forEach((d, i) => timeIndex.set(d.getTime(), i));

  const innerW = WIDTH - PAD.l - PAD.r;
  const innerH = HEIGHT - PAD.t - PAD.b;

  const xAt = (i: number): number =>
    n === 1 ? PAD.l + innerW / 2 : PAD.l + (innerW * i) / (n - 1);

  const xLabels = times.map((d, i) => ({ x: round(xAt(i)), label: fmtDate(d) }));

  const charts: CruxTrendChart[] = [];

  for (const metric of CRUX_METRICS) {
    // Collect values present for this metric to compute the axis range.
    const values = snaps
      .map((s) => s[metric.key])
      .filter((v): v is number => v !== null && v !== undefined);
    if (values.length === 0) continue; // no data for this metric — skip the chart

    const dataMax = Math.max(...values, 0);
    const { top, step } = niceScale(dataMax);
    const yAt = (v: number): number => PAD.t + innerH * (1 - v / top);

    const yTicks: { y: number; label: string }[] = [];
    for (let v = 0; v <= top + step / 2; v += step) {
      yTicks.push({ y: round(yAt(v)), label: fmtValue(v, metric.decimals) });
    }

    const series: CruxTrendSeries[] = scopes.map((scope, si) => {
      const forScope = snaps
        .filter((s) => s.scopeKey === scope.key)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      const points: CruxTrendPoint[] = [];
      let d = "";
      let pen = false;
      // Walk the shared time axis so gaps break the line consistently.
      for (const t of times) {
        const snap = forScope.find((s) => s.date.getTime() === t.getTime());
        const value = snap ? snap[metric.key] : null;
        if (value === null || value === undefined) {
          pen = false;
          continue;
        }
        const i = timeIndex.get(t.getTime())!;
        const cx = round(xAt(i));
        const cy = round(yAt(value));
        d += `${pen ? " L" : " M"} ${cx} ${cy}`;
        pen = true;
        points.push({
          cx,
          cy,
          value,
          title: `${scope.label} · ${fmtDate(t)} — ${metric.label}: ${fmtValue(value, metric.decimals)}`,
        });
      }
      return {
        key: scope.key,
        label: scope.label,
        color: COLORS[si % COLORS.length],
        path: d.trim(),
        points,
      };
    });

    charts.push({
      key: metric.key,
      label: metric.label,
      width: WIDTH,
      height: HEIGHT,
      innerW,
      innerH,
      pad: PAD,
      yTicks,
      xLabels,
      series,
    });
  }

  return charts;
}
