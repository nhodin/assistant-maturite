/**
 * Scoring engine — pure functions, no I/O.
 *
 * Aggregation rules (per CLAUDE.md):
 * - Per page/control: skip disabled; N/A if appliesTo===false or naForced.
 * - Across pages: a control is PASSED if it passed on ≥1 applicable page.
 *                 a control is N/A for the site only if N/A on ALL pages.
 * - Topic score: sum of pointsAwarded, capped at 100. null if ALL controls N/A.
 * - Overall: average of non-standalone topics 1–10 whose score is not null.
 */
import type {
  Control,
  ControlConfig,
  ControlResult,
  SiteResult,
  TopicModule,
  TopicResult,
} from "../core/types";
import type { EvidenceBundle } from "../core/schema";
import type { ConfigMap } from "./index";

/* ── helpers ──────────────────────────────────────────────────────────────── */

function getConfig(config: ConfigMap, id: string): ControlConfig {
  return (
    config[id] ?? {
      enabled: true,
      pointsOverride: null,
      naForced: false,
    }
  );
}

function resolvePoints(control: Control, cfg: ControlConfig): number {
  return cfg.pointsOverride ?? control.defaultPoints;
}

/* ── per-page evaluation ──────────────────────────────────────────────────── */

interface PageControlEval {
  controlId: string;
  applicable: boolean;
  passed: boolean;
  pointsAwarded: number;
  maxPoints: number;
  evidence: string;
}

function evalControlOnPage(
  control: Control,
  page: EvidenceBundle,
  cfg: ControlConfig,
): PageControlEval {
  const pts = resolvePoints(control, cfg);

  // Disabled: skip entirely (callers filter these out)
  if (!cfg.enabled) {
    return {
      controlId: control.id,
      applicable: false,
      passed: false,
      pointsAwarded: 0,
      maxPoints: 0,
      evidence: "disabled",
    };
  }

  // N/A gate
  const isNA =
    cfg.naForced ||
    (control.appliesTo !== undefined && control.appliesTo(page) === false);

  if (isNA) {
    return {
      controlId: control.id,
      applicable: false,
      passed: false,
      pointsAwarded: 0,
      maxPoints: 0,
      evidence: "N/A",
    };
  }

  const verdict = control.evaluate(page);
  return {
    controlId: control.id,
    applicable: true,
    passed: verdict.passed,
    pointsAwarded: verdict.passed ? pts : 0,
    maxPoints: pts,
    evidence: verdict.evidence,
  };
}

/* ── site-level aggregation for a single control ─────────────────────────── */

interface SiteControlAgg {
  applicable: boolean; // true if applicable on ≥1 page
  passed: boolean;
  pointsAwarded: number;
  maxPoints: number;
  evidence: string;
}

function aggregateControl(
  control: Control,
  pages: EvidenceBundle[],
  cfg: ControlConfig,
): SiteControlAgg {
  if (!cfg.enabled) {
    return {
      applicable: false,
      passed: false,
      pointsAwarded: 0,
      maxPoints: 0,
      evidence: "disabled",
    };
  }

  const pageEvals = pages.map((p) => evalControlOnPage(control, p, cfg));
  const applicableEvals = pageEvals.filter((e) => e.applicable);

  // N/A on ALL pages → N/A for the site
  if (applicableEvals.length === 0) {
    return {
      applicable: false,
      passed: false,
      pointsAwarded: 0,
      maxPoints: 0,
      evidence: pageEvals[0]?.evidence ?? "N/A",
    };
  }

  const pts = resolvePoints(control, cfg);

  // Passed if at least one applicable page passed
  const passedEval = applicableEvals.find((e) => e.passed);
  const passed = passedEval !== undefined;

  // For evidence: use first passing page's evidence, or first applicable page's
  const evidenceSource = passedEval ?? applicableEvals[0];

  return {
    applicable: true,
    passed,
    pointsAwarded: passed ? pts : 0,
    maxPoints: pts,
    evidence: evidenceSource.evidence,
  };
}

/* ── topic scoring ────────────────────────────────────────────────────────── */

function scoreTopic(
  topic: TopicModule,
  pages: EvidenceBundle[],
  config: ConfigMap,
): TopicResult {
  const controlResults: ControlResult[] = [];

  for (const control of topic.controls) {
    const cfg = getConfig(config, control.id);

    if (!cfg.enabled) {
      // Omit disabled controls from results entirely (or include as N/A)
      controlResults.push({
        controlId: control.id,
        label: control.label,
        applicable: false,
        passed: false,
        pointsAwarded: 0,
        maxPoints: resolvePoints(control, cfg),
        evidence: "disabled",
      });
      continue;
    }

    const agg = aggregateControl(control, pages, cfg);
    controlResults.push({
      controlId: control.id,
      label: control.label,
      applicable: agg.applicable,
      passed: agg.passed,
      pointsAwarded: agg.pointsAwarded,
      maxPoints: agg.maxPoints,
      evidence: agg.evidence,
    });
  }

  // All N/A → topic score null
  const anyApplicable = controlResults.some((c) => c.applicable);
  if (!anyApplicable) {
    return { topicId: topic.id, name: topic.name, score: null, controls: controlResults };
  }

  const raw = controlResults.reduce((sum, c) => sum + c.pointsAwarded, 0);
  const score = Math.min(100, raw);
  return { topicId: topic.id, name: topic.name, score, controls: controlResults };
}

/* ── public ───────────────────────────────────────────────────────────────── */

export function scoreSite(
  site: string,
  pages: EvidenceBundle[],
  topics: TopicModule[],
  config: ConfigMap,
): SiteResult {
  const topicResults: TopicResult[] = topics.map((t) =>
    scoreTopic(t, pages, config),
  );

  // Overall: average of non-standalone topics (1–10) with non-null score
  const mainTopics = topicResults.filter(
    (t) => {
      const topic = topics.find((tp) => tp.id === t.topicId);
      return topic !== undefined && !topic.standalone && t.score !== null;
    },
  );
  const overall =
    mainTopics.length > 0
      ? Math.round(
          mainTopics.reduce((s, t) => s + (t.score as number), 0) /
            mainTopics.length,
        )
      : null;

  const geoResult = topicResults.find((t) => t.topicId === 11);
  const chinaResult = topicResults.find((t) => t.topicId === 12);

  return {
    site,
    topics: topicResults,
    overall,
    geo: geoResult?.score ?? null,
    china: chinaResult?.score ?? null,
  };
}
