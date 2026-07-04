/**
 * Build the geometry for the project "score evolution" line chart.
 *
 * Pure (no I/O) so it can be unit-tested. Given the DONE runs of a project in
 * chronological order, it produces ready-to-render SVG primitives: one line for
 * the global (principal) score plus one line per project page (HP/PLP/PDP…).
 * The EJS view only has to drop the precomputed paths/points into an <svg>.
 */

export interface TrendRunInput {
  id: number;
  /** Run timestamp (finishedAt ?? createdAt). */
  date: Date;
  /** Aggregated site-level overall for the run, or null when unavailable. */
  global: number | null;
  /** Per-page overall keyed by pageId. Missing/failed pages → null. */
  pageScores: Record<number, number | null>;
}

export interface TrendPageDef {
  pageId: number;
  label: string;
}

export interface TrendPoint {
  cx: number;
  cy: number;
  score: number;
  runId: number;
  /** Tooltip text, e.g. "Run #12 · 30/06/2026 14:05 — 72". */
  title: string;
}

export interface TrendSeries {
  key: string;
  label: string;
  color: string;
  isGlobal: boolean;
  /** SVG path "d" (gaps where a score is null). Empty when no points. */
  path: string;
  points: TrendPoint[];
}

export interface TrendChart {
  width: number;
  height: number;
  innerW: number;
  innerH: number;
  pad: { t: number; r: number; b: number; l: number };
  yTicks: { y: number; value: number }[];
  xLabels: { x: number; label: string }[];
  series: TrendSeries[];
}

const GLOBAL_COLOR = "#0d47a1";
const PAGE_COLORS = ["#1565c0", "#00897b", "#8e24aa", "#ef6c00", "#5d4037", "#c62828"];

const PAD = { t: 14, r: 16, b: 34, l: 34 };
const WIDTH = 720;
const HEIGHT = 300;

function fmtDate(d: Date): string {
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Build a line-chart model, or null when there is nothing to plot. */
export function buildProjectTrend(
  runs: TrendRunInput[],
  pages: TrendPageDef[],
): TrendChart | null {
  if (runs.length === 0) return null;

  const innerW = WIDTH - PAD.l - PAD.r;
  const innerH = HEIGHT - PAD.t - PAD.b;
  const n = runs.length;

  const xAt = (i: number): number =>
    n === 1 ? PAD.l + innerW / 2 : PAD.l + (innerW * i) / (n - 1);
  const yAt = (score: number): number => PAD.t + innerH * (1 - score / 100);

  const yTicks = [0, 20, 40, 60, 80, 100].map((value) => ({
    value,
    y: round(yAt(value)),
  }));

  const xLabels = runs.map((r, i) => ({ x: round(xAt(i)), label: `#${r.id}` }));

  const buildSeries = (
    key: string,
    label: string,
    color: string,
    isGlobal: boolean,
    scoreOf: (r: TrendRunInput) => number | null,
  ): TrendSeries => {
    const points: TrendPoint[] = [];
    let d = "";
    let pen = false;
    runs.forEach((r, i) => {
      const score = scoreOf(r);
      if (score === null || score === undefined) {
        pen = false; // break the line across a gap
        return;
      }
      const cx = round(xAt(i));
      const cy = round(yAt(score));
      d += `${pen ? " L" : " M"} ${cx} ${cy}`;
      pen = true;
      points.push({
        cx,
        cy,
        score,
        runId: r.id,
        title: `Run #${r.id} · ${fmtDate(r.date)} — ${label}: ${score}`,
      });
    });
    return { key, label, color, isGlobal, path: d.trim(), points };
  };

  const series: TrendSeries[] = [
    buildSeries("global", "Note globale", GLOBAL_COLOR, true, (r) => r.global),
    ...pages.map((p, i) =>
      buildSeries(
        `page-${p.pageId}`,
        p.label,
        PAGE_COLORS[i % PAGE_COLORS.length],
        false,
        (r) => r.pageScores[p.pageId] ?? null,
      ),
    ),
  ];

  return {
    width: WIDTH,
    height: HEIGHT,
    innerW,
    innerH,
    pad: PAD,
    yTicks,
    xLabels,
    series,
  };
}
