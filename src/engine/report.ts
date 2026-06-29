/**
 * Report generators — Markdown and CSV output.
 * Mirrors the style of ../reports/2026-03-30-maturity.md
 */
import type { SiteResult, TopicResult, ControlResult } from "../core/types";

/* ── helpers ──────────────────────────────────────────────────────────────── */

function resultIcon(cr: ControlResult): string {
  if (!cr.applicable) return "N/A";
  return cr.passed ? "✓" : "✗";
}

/** Column header order matching CLAUDE.md fixed CSV header. */
const CSV_TOPIC_NAMES = [
  "Image management score",
  "Slider management score",
  "Video management score",
  "Third parties score",
  "TTFB/Cache score",
  "JS management score",
  "CSS management score",
  "Critical path score",
  "Fonts management score",
  "CDN score",
  "Technical GEO score",
  "China Market Access score",
];

/** Map topic id → zero-based column index in CSV_TOPIC_NAMES (topic 1→0, …, 12→11). */
function topicColIdx(topicId: number): number {
  return topicId - 1;
}

/* ── Markdown ─────────────────────────────────────────────────────────────── */

export function renderMarkdown(
  results: SiteResult[],
  meta?: { date?: string },
): string {
  const date = meta?.date ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# LVMH Web Performance Maturity Analysis — ${date}`);
  lines.push("");
  lines.push(
    "**Scope:** LVMH brand websites audited across HP, PLP, and PDP pages.",
  );
  lines.push(
    "**Scoring:** Cumulative 0–100 per topic. N/A permitted for Slider/Video when elements absent on all pages.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Score Summary table ──────────────────────────────────────────────────
  lines.push("## Score Summary");
  lines.push("");

  // Collect all unique topic ids across results (preserve first-seen order)
  const allTopicIds: number[] = [];
  for (const r of results) {
    for (const t of r.topics) {
      if (!allTopicIds.includes(t.topicId)) allTopicIds.push(t.topicId);
    }
  }
  // Sort numerically
  allTopicIds.sort((a, b) => a - b);

  const siteNames = results.map((r) => r.site);
  const headerCols = ["Topic", ...siteNames];
  lines.push(`| ${headerCols.join(" | ")} |`);
  lines.push(`| ${headerCols.map(() => "---").join(" | ")} |`);

  for (const topicId of allTopicIds) {
    const topicName = results
      .flatMap((r) => r.topics)
      .find((t) => t.topicId === topicId)?.name ?? `Topic ${topicId}`;

    const scores = results.map((r) => {
      const t = r.topics.find((tp) => tp.topicId === topicId);
      if (!t) return "—";
      return t.score === null ? "N/A" : String(t.score);
    });
    lines.push(`| ${topicId}. ${topicName} | ${scores.join(" | ")} |`);
  }

  // Average row
  const averages = results.map((r) =>
    r.overall !== null ? String(r.overall) : "N/A",
  );
  lines.push(`| **Average** | ${averages.map((a) => `**${a}**`).join(" | ")} |`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Per-site sections ────────────────────────────────────────────────────
  for (const siteResult of results) {
    lines.push(`## ${siteResult.site}`);
    lines.push("");

    for (const topicResult of siteResult.topics) {
      const scoreLabel =
        topicResult.score === null ? "N/A" : `${topicResult.score}/100`;
      lines.push(`### ${topicResult.topicId}. ${topicResult.name} — ${scoreLabel}`);
      lines.push("");

      if (topicResult.score === null && topicResult.controls.every((c) => !c.applicable)) {
        lines.push(`No applicable elements detected on any evaluated page.`);
        lines.push("");
        continue;
      }

      lines.push("| Criterion | Pts | Result | Evidence |");
      lines.push("| --- | --- | --- | --- |");
      for (const cr of topicResult.controls) {
        const pts = cr.applicable
          ? `${cr.pointsAwarded}/${cr.maxPoints}`
          : "—";
        lines.push(
          `| ${cr.label} | ${pts} | ${resultIcon(cr)} | ${cr.evidence} |`,
        );
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/* ── CSV ─────────────────────────────────────────────────────────────────── */

export function renderCsv(results: SiteResult[]): string {
  const HEADER =
    "Website;Image management score;Slider management score;Video management score;Third parties score;TTFB/Cache score;JS management score;CSS management score;Critical path score;Fonts management score;CDN score;Technical GEO score;China Market Access score";

  const rows: string[] = [HEADER];

  for (const r of results) {
    const cols: string[] = new Array(12).fill("");

    for (const t of r.topics) {
      const idx = topicColIdx(t.topicId);
      if (idx >= 0 && idx < 12) {
        cols[idx] = t.score === null ? "N/A" : String(t.score);
      }
    }

    rows.push([r.site, ...cols].join(";"));
  }

  return rows.join("\n");
}
