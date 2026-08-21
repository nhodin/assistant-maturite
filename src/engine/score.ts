/**
 * Scoring engine — pure functions, no I/O.
 *
 * Aggregation rules (per CLAUDE.md):
 * - Per page/control: skip disabled; N/A if appliesTo===false or naForced.
 *   A control is binary on a page: full points or 0.
 * - A page is graded in one of two MODES (see `PageScoringMode`):
 *   "standard" scores topics 1–11 fully and leaves topic 12 N/A; "china" keeps
 *   only the FIRST measured criterion of topics 1–11 — worth CHINA_TOPIC_POINTS
 *   (100), so the topic reads 0 or 100 — and scores topic 12 in full.
 * - Across pages (site): each criterion is the PROPORTIONAL AVERAGE of its
 *   per-page results — `round(points × passedPages / applicablePages)`. A control
 *   is N/A for the site only if N/A on ALL pages.
 *   The two families of page are aggregated SEPARATELY: the standard pages feed
 *   `topics`/`overall`/`geo`, the China pages feed `chinaTopics`/`chinaOverall`/
 *   `china`. They are never averaged together.
 * - Topic score: sum of (per-page) pointsAwarded for a page, or sum of the
 *   averaged criteria for the site; capped at 100. null if ALL controls N/A.
 * - Overall: average of non-standalone topics 1–10 whose score is not null.
 */
import type {
  Control,
  ControlConfig,
  ControlResult,
  PageResult,
  PageScoringMode,
  ScoredPageInput,
  SiteResult,
  TopicModule,
  TopicResult,
} from "../core/types";
import { CHINA_TOPIC_POINTS } from "../core/types";
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

/** Accept a bare bundle (standard page) or an explicit {bundle, mode} pair. */
function asPageInput(p: EvidenceBundle | ScoredPageInput): Required<ScoredPageInput> {
  return "bundle" in p
    ? { bundle: p.bundle, mode: p.mode ?? "standard" }
    : { bundle: p, mode: "standard" };
}

/** Page results carry their mode; anything captured before China pages is standard. */
function modeOf(page: Pick<PageResult, "mode">): PageScoringMode {
  return page.mode === "china" ? "china" : "standard";
}

/* ── mode plan: which criteria a mode measures, and for how many points ───── */

/**
 * Index of the first control of `topic` that the configuration still measures.
 * On a China page THIS is the criterion that carries the topic, so a control
 * disabled in Settings hands the role to the next one instead of blanking the
 * whole topic. -1 when the topic has no enabled control at all.
 */
function firstMeasuredIndex(topic: TopicModule, config: ConfigMap): number {
  return topic.controls.findIndex((c) => getConfig(config, c.id).enabled);
}

interface ControlPlan {
  /** false → the mode does not measure this criterion: N/A, no points, no max. */
  measured: boolean;
  /** Points the criterion is worth in this mode (0 when not measured). */
  points: number;
  /** Evidence string to show for a criterion the mode does not measure. */
  skipReason: string;
  /**
   * The control aggregates the OTHER topics instead of reading the bundle
   * (`Control.derivedFromTopics`). Neither `evaluate` nor any stored per-page fact
   * decides it: the slot is reserved here and filled by `applyDerivedControls`.
   * Without this, a page whose stored results predate the control — a resume across
   * a scoring change — would silently drop the component to N/A.
   */
  derived: boolean;
}

const CHINA_ONLY_TOPIC = 12;

/**
 * What `mode` does with one criterion. This is the ONLY place the China rule
 * lives: everything else (per-page evaluation, site aggregation, reports) just
 * reads `measured` / `points`.
 */
function planControl(
  topic: TopicModule,
  control: Control,
  index: number,
  cfg: ControlConfig,
  mode: PageScoringMode,
  firstIdx: number,
): ControlPlan {
  const base = resolvePoints(control, cfg);
  const derived = control.derivedFromTopics === true;

  if (mode === "china") {
    // Topic 12 is the point of a China page — scored in full, as declared.
    if (topic.id === CHINA_ONLY_TOPIC) {
      return { measured: true, points: base, skipReason: "", derived };
    }
    // Every other topic is reduced to its foundational criterion, which carries
    // the whole topic so the score stays on the 0–100 scale.
    return index === firstIdx
      ? { measured: true, points: CHINA_TOPIC_POINTS, skipReason: "", derived }
      : {
          measured: false,
          points: 0,
          skipReason: "N/A — page China : seul le 1er critère du sujet est évalué",
          derived,
        };
  }

  // Standard page: topic 12 means nothing here.
  if (topic.id === CHINA_ONLY_TOPIC) {
    return {
      measured: false,
      points: 0,
      skipReason: "N/A — sujet évalué uniquement sur les pages China",
      derived,
    };
  }
  return { measured: true, points: base, skipReason: "", derived };
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

function naEval(controlId: string, evidence: string): PageControlEval {
  return {
    controlId,
    applicable: false,
    passed: false,
    pointsAwarded: 0,
    maxPoints: 0,
    evidence,
  };
}

function evalControlOnPage(
  control: Control,
  page: EvidenceBundle,
  cfg: ControlConfig,
  plan: ControlPlan,
): PageControlEval {
  // Disabled: skip entirely (callers filter these out)
  if (!cfg.enabled) return naEval(control.id, "disabled");

  // The scoring mode does not measure this criterion on this page.
  if (!plan.measured) return naEval(control.id, plan.skipReason);

  // N/A gate
  const isNA =
    cfg.naForced ||
    (control.appliesTo !== undefined && control.appliesTo(page) === false);

  if (isNA) return naEval(control.id, "N/A");

  // Derived: reserve the slot, points come from applyDerivedControls. `evaluate`
  // is deliberately not called — it cannot know the other topics.
  if (plan.derived) {
    return {
      controlId: control.id,
      applicable: true,
      passed: false,
      pointsAwarded: 0,
      maxPoints: plan.points,
      evidence: "",
    };
  }

  const verdict = control.evaluate(page);
  return {
    controlId: control.id,
    applicable: true,
    passed: verdict.passed,
    pointsAwarded: verdict.passed ? plan.points : 0,
    maxPoints: plan.points,
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

/**
 * The only per-page facts a site aggregate needs. They can come from evaluating a
 * live EvidenceBundle OR from a ControlResult persisted earlier — which is what
 * lets a resumed run aggregate pages captured before the interruption together
 * with the ones captured after it.
 */
export interface PageControlFacts {
  applicable: boolean;
  passed: boolean;
  evidence: string;
}

function aggregateFacts(
  facts: PageControlFacts[],
  cfg: ControlConfig,
  plan: ControlPlan,
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
  if (!plan.measured) {
    return {
      applicable: false,
      passed: false,
      pointsAwarded: 0,
      maxPoints: 0,
      evidence: plan.skipReason,
    };
  }

  // Derived: same reservation at site level. Its stored per-page facts are
  // irrelevant (and absent on pages scored before the control existed).
  if (plan.derived) {
    return {
      applicable: true,
      passed: false,
      pointsAwarded: 0,
      maxPoints: plan.points,
      evidence: "",
    };
  }

  const pageEvals = facts;
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

  // Proportional average: criterion is worth points × (passed pages / applicable pages).
  const passedCount = applicableEvals.filter((e) => e.passed).length;
  const total = applicableEvals.length;
  const pointsAwarded = Math.round((plan.points * passedCount) / total);

  return {
    applicable: true,
    // "passed" at site level means: validated on EVERY applicable page.
    passed: passedCount === total,
    pointsAwarded,
    maxPoints: plan.points,
    evidence: `Validé sur ${passedCount}/${total} page(s)`,
  };
}

/* ── shared overall/geo/china computation ─────────────────────────────────── */

interface Aggregates {
  overall: number | null;
  geo: number | null;
  china: number | null;
}

function computeAggregates(
  topicResults: TopicResult[],
  topics: TopicModule[],
): Aggregates {
  const mainTopics = topicResults.filter((t) => {
    const topic = topics.find((tp) => tp.id === t.topicId);
    return topic !== undefined && !topic.standalone && t.score !== null;
  });
  const overall =
    mainTopics.length > 0
      ? Math.round(
          mainTopics.reduce((s, t) => s + (t.score as number), 0) /
            mainTopics.length,
        )
      : null;

  return {
    overall,
    geo: topicResults.find((t) => t.topicId === 11)?.score ?? null,
    china: topicResults.find((t) => t.topicId === CHINA_ONLY_TOPIC)?.score ?? null,
  };
}

/* ── derived controls (topic 12's "sitespeed basics") ─────────────────────── */

/**
 * Fill in the controls flagged `derivedFromTopics`, whose result is a function of
 * the OTHER topics' scores rather than of the bundle. Today that is topic 12's
 * 50-point "sitespeed basics" component: on a China page every topic 1–10 is
 * already reduced to its first criterion (0 or 100), and `basis` is their average
 * — so the component is simply `round(maxPoints × basis / 100)`.
 *
 * Runs on the CHINA block only (it is the only place topic 12 is measured), after
 * `computeAggregates` produced `basis`, and rewrites the owning topic's score.
 * Mutates the freshly-built results in place.
 */
function applyDerivedControls(
  topics: TopicModule[],
  topicResults: TopicResult[],
  basis: number | null,
): void {
  for (const topic of topics) {
    const derived = topic.controls.filter((c) => c.derivedFromTopics === true);
    if (derived.length === 0) continue;

    const tr = topicResults.find((t) => t.topicId === topic.id);
    if (!tr) continue;

    let touched = false;
    for (const control of derived) {
      const cr = tr.controls.find((c) => c.controlId === control.id);
      // Untouched when the mode did not measure it, or it is disabled/N/A: those
      // decisions are the engine's and stay authoritative.
      if (!cr || !cr.applicable) continue;

      if (basis === null) {
        cr.applicable = false;
        cr.passed = false;
        cr.pointsAwarded = 0;
        cr.maxPoints = 0;
        cr.evidence = "N/A — aucun sujet 1–10 mesurable sur cette page";
      } else {
        cr.pointsAwarded = Math.round((cr.maxPoints * basis) / 100);
        cr.passed = cr.pointsAwarded === cr.maxPoints;
        cr.evidence =
          `Sujets 1–10 sur leur 1er critère : ${basis}/100 → ` +
          `${cr.pointsAwarded}/${cr.maxPoints} pts`;
      }
      touched = true;
    }
    if (!touched) continue;

    // The topic's score has to be recomputed from the rewritten control.
    const anyApplicable = tr.controls.some((c) => c.applicable);
    tr.score = anyApplicable
      ? Math.min(
          100,
          tr.controls.reduce((sum, c) => sum + c.pointsAwarded, 0),
        )
      : null;
  }
}

/**
 * Score the CHINA block: the topic results, then the derived controls that depend
 * on them, then the aggregates — topic 12's score changes under our feet, so it is
 * re-read after the patch.
 */
function chinaBlock(
  topicResults: TopicResult[],
  topics: TopicModule[],
): { topics: TopicResult[]; agg: Aggregates } {
  const agg = computeAggregates(topicResults, topics);
  applyDerivedControls(topics, topicResults, agg.overall);
  return {
    topics: topicResults,
    agg: {
      ...agg,
      china: topicResults.find((t) => t.topicId === CHINA_ONLY_TOPIC)?.score ?? null,
    },
  };
}

/* ── topic scoring ────────────────────────────────────────────────────────── */

/**
 * Site-level topic scoring, parameterised by where the per-page facts come from:
 * freshly evaluated bundles (`scoreTopic`) or stored per-page ControlResults
 * (`scoreSiteFromPages`). One implementation of the aggregation rule, two sources.
 *
 * All the pages feeding one call MUST share the same `mode` — the China pages and
 * the standard pages of a site are aggregated in two separate passes.
 */
function scoreTopicWith(
  topic: TopicModule,
  config: ConfigMap,
  mode: PageScoringMode,
  factsFor: (control: Control, cfg: ControlConfig) => PageControlFacts[],
): TopicResult {
  const controlResults: ControlResult[] = [];
  const firstIdx = firstMeasuredIndex(topic, config);

  topic.controls.forEach((control, index) => {
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
      return;
    }

    const plan = planControl(topic, control, index, cfg, mode, firstIdx);
    const agg = aggregateFacts(factsFor(control, cfg), cfg, plan);
    controlResults.push({
      controlId: control.id,
      label: control.label,
      applicable: agg.applicable,
      passed: agg.passed,
      pointsAwarded: agg.pointsAwarded,
      maxPoints: agg.maxPoints,
      evidence: agg.evidence,
    });
  });

  // All N/A → topic score null
  const anyApplicable = controlResults.some((c) => c.applicable);
  if (!anyApplicable) {
    return { topicId: topic.id, name: topic.name, score: null, controls: controlResults };
  }

  const raw = controlResults.reduce((sum, c) => sum + c.pointsAwarded, 0);
  const score = Math.min(100, raw);
  return { topicId: topic.id, name: topic.name, score, controls: controlResults };
}

function scoreTopic(
  topic: TopicModule,
  pages: EvidenceBundle[],
  config: ConfigMap,
  mode: PageScoringMode,
): TopicResult {
  const firstIdx = firstMeasuredIndex(topic, config);
  const indexOf = new Map(topic.controls.map((c, i) => [c.id, i]));
  return scoreTopicWith(topic, config, mode, (control, cfg) => {
    const plan = planControl(
      topic,
      control,
      indexOf.get(control.id) ?? -1,
      cfg,
      mode,
      firstIdx,
    );
    return pages.map((p) => evalControlOnPage(control, p, cfg, plan));
  });
}

/* ── single-page topic scoring (binary per control) ──────────────────────── */

function scoreTopicOnPage(
  topic: TopicModule,
  page: EvidenceBundle,
  config: ConfigMap,
  mode: PageScoringMode,
): TopicResult {
  const firstIdx = firstMeasuredIndex(topic, config);
  const controlResults: ControlResult[] = topic.controls.map((control, index) => {
    const cfg = getConfig(config, control.id);
    const plan = planControl(topic, control, index, cfg, mode, firstIdx);
    const ev = evalControlOnPage(control, page, cfg, plan);
    return {
      controlId: control.id,
      label: control.label,
      applicable: ev.applicable,
      passed: ev.passed,
      pointsAwarded: ev.pointsAwarded,
      maxPoints: ev.maxPoints,
      evidence: ev.evidence,
    };
  });

  const anyApplicable = controlResults.some((c) => c.applicable);
  if (!anyApplicable) {
    return { topicId: topic.id, name: topic.name, score: null, controls: controlResults };
  }

  const raw = controlResults.reduce((sum, c) => sum + c.pointsAwarded, 0);
  return {
    topicId: topic.id,
    name: topic.name,
    score: Math.min(100, raw),
    controls: controlResults,
  };
}

/* ── public ───────────────────────────────────────────────────────────────── */

/**
 * Score a single page (one EvidenceBundle) across all topics.
 * `mode` decides which criteria are measured — see `PageScoringMode`.
 */
export function scorePage(
  page: EvidenceBundle,
  topics: TopicModule[],
  config: ConfigMap,
  mode: PageScoringMode = "standard",
): PageResult {
  const topicResults = topics.map((t) => scoreTopicOnPage(t, page, config, mode));
  const { overall, geo, china } =
    mode === "china"
      ? chinaBlock(topicResults, topics).agg
      : computeAggregates(topicResults, topics);
  return { url: page.url, mode, topics: topicResults, overall, geo, china };
}

/**
 * Re-score a page from the verdicts ALREADY STORED on it, instead of from its
 * EvidenceBundle. Same rule as `scorePage` — only the source of each verdict
 * differs: `applicable` / `passed` / `evidence` are taken verbatim from the
 * stored ControlResults, everything derived from them (points, topic scores,
 * overall/GEO/China, the derived "sitespeed basics" component) is recomputed.
 *
 * This is what makes a manual correction cheap: flip one stored verdict, call
 * this, and the page's numbers follow — no browser, no bundle. It is also why a
 * correction is transient: it lives in the stored result, so recapturing the
 * page overwrites it.
 *
 * A control with no stored result (added to the code after the page was scored)
 * counts as N/A, exactly as in `scoreSiteFromPages`.
 */
export function rescorePageFromVerdicts(
  page: PageResult,
  topics: TopicModule[],
  config: ConfigMap,
): PageResult {
  const mode = modeOf(page);
  const stored = new Map<string, ControlResult>();
  for (const t of page.topics) for (const c of t.controls) stored.set(c.controlId, c);

  const topicResults = topics.map((topic): TopicResult => {
    const firstIdx = firstMeasuredIndex(topic, config);
    const controls: ControlResult[] = topic.controls.map((control, index) => {
      const cfg = getConfig(config, control.id);
      const prev = stored.get(control.id);
      // Carried across untouched: they describe the correction, not the score.
      const kept = { manual: prev?.manual, auto: prev?.auto };
      const na = (evidence: string): ControlResult => ({
        controlId: control.id,
        label: control.label,
        applicable: false,
        passed: false,
        pointsAwarded: 0,
        maxPoints: 0,
        evidence,
        ...kept,
      });

      if (!cfg.enabled) return na("disabled");
      const plan = planControl(topic, control, index, cfg, mode, firstIdx);
      if (!plan.measured) return na(plan.skipReason);
      if (!prev) return na("Non évalué");
      // Derived: the slot is reserved here and filled by applyDerivedControls.
      if (plan.derived) {
        return {
          controlId: control.id,
          label: control.label,
          applicable: true,
          passed: false,
          pointsAwarded: 0,
          maxPoints: plan.points,
          evidence: "",
          ...kept,
        };
      }
      if (!prev.applicable) return na(prev.evidence);

      return {
        controlId: control.id,
        label: control.label,
        applicable: true,
        passed: prev.passed,
        pointsAwarded: prev.passed ? plan.points : 0,
        maxPoints: plan.points,
        evidence: prev.evidence,
        ...kept,
      };
    });

    const anyApplicable = controls.some((c) => c.applicable);
    return {
      topicId: topic.id,
      name: topic.name,
      score: anyApplicable
        ? Math.min(100, controls.reduce((sum, c) => sum + c.pointsAwarded, 0))
        : null,
      controls,
    };
  });

  const { overall, geo, china } =
    mode === "china"
      ? chinaBlock(topicResults, topics).agg
      : computeAggregates(topicResults, topics);
  return { ...page, mode, topics: topicResults, overall, geo, china };
}

/** Assemble a SiteResult from the two per-mode aggregates. */
function combineBlocks(
  site: string,
  standard: { topics: TopicResult[]; agg: Aggregates } | null,
  china: { topics: TopicResult[]; agg: Aggregates } | null,
  pages: PageResult[],
  topics: TopicModule[],
): SiteResult {
  // A site with no standard page still needs a shaped (all-N/A) topic list, so the
  // reports and the UI can render it without special-casing every access.
  const standardTopics =
    standard?.topics ?? topics.map((t) => emptyTopicResult(t));
  return {
    site,
    topics: standardTopics,
    overall: standard?.agg.overall ?? null,
    geo: standard?.agg.geo ?? null,
    // Topic 12 lives on the China pages only.
    china: china?.agg.china ?? null,
    chinaTopics: china?.topics ?? null,
    chinaOverall: china?.agg.overall ?? null,
    pages,
  };
}

function emptyTopicResult(topic: TopicModule): TopicResult {
  return {
    topicId: topic.id,
    name: topic.name,
    score: null,
    controls: topic.controls.map((c) => ({
      controlId: c.id,
      label: c.label,
      applicable: false,
      passed: false,
      pointsAwarded: 0,
      maxPoints: 0,
      evidence: "Aucune page évaluée",
    })),
  };
}

/**
 * Aggregate a site from per-page results computed EARLIER, instead of from live
 * EvidenceBundles. Same rule, same numbers as `scoreSite` — the aggregation only
 * ever reads `applicable`/`passed` per page, and those are exactly what a stored
 * ControlResult carries.
 *
 * This is what makes a resumed run cheap: the pages captured before the
 * interruption keep their stored results and only the missing pages are
 * recaptured, even though their (large) bundles are long gone.
 *
 * A control with no stored result on a given page (a control added to the code
 * after that page was scored) counts as N/A on that page, so the aggregate is
 * computed from the pages that actually know about it rather than silently
 * failing them.
 *
 * Pages are split by `PageResult.mode` first: China pages never contribute to the
 * standard aggregate, and vice versa.
 */
export function scoreSiteFromPages(
  site: string,
  pages: PageResult[],
  topics: TopicModule[],
  config: ConfigMap,
): SiteResult {
  const blockFor = (mode: PageScoringMode) => {
    const ofMode = pages.filter((p) => modeOf(p) === mode);
    if (ofMode.length === 0) return null;

    // controlId → its result on each page of this family, in page order.
    const byControl = new Map<string, PageControlFacts[]>();
    for (const page of ofMode) {
      for (const topic of page.topics) {
        for (const c of topic.controls) {
          const list = byControl.get(c.controlId) ?? [];
          list.push({ applicable: c.applicable, passed: c.passed, evidence: c.evidence });
          byControl.set(c.controlId, list);
        }
      }
    }

    const topicResults = topics.map((t) =>
      scoreTopicWith(t, config, mode, (control) => byControl.get(control.id) ?? []),
    );
    return mode === "china"
      ? chinaBlock(topicResults, topics)
      : { topics: topicResults, agg: computeAggregates(topicResults, topics) };
  };

  return combineBlocks(site, blockFor("standard"), blockFor("china"), pages, topics);
}

/**
 * Score a whole site from live bundles. Pages may be passed as bare
 * `EvidenceBundle`s (all standard) or as `{ bundle, mode }` pairs when the site
 * mixes standard and China pages.
 */
export function scoreSite(
  site: string,
  pages: (EvidenceBundle | ScoredPageInput)[],
  topics: TopicModule[],
  config: ConfigMap,
): SiteResult {
  const inputs = pages.map(asPageInput);

  // Per-page breakdown (binary), in input order.
  const pageResults: PageResult[] = inputs.map((p) =>
    scorePage(p.bundle, topics, config, p.mode),
  );

  const blockFor = (mode: PageScoringMode) => {
    const bundles = inputs.filter((p) => p.mode === mode).map((p) => p.bundle);
    if (bundles.length === 0) return null;
    const topicResults = topics.map((t) => scoreTopic(t, bundles, config, mode));
    return mode === "china"
      ? chinaBlock(topicResults, topics)
      : { topics: topicResults, agg: computeAggregates(topicResults, topics) };
  };

  return combineBlocks(
    site,
    blockFor("standard"),
    blockFor("china"),
    pageResults,
    topics,
  );
}
