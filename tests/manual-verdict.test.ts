/**
 * Manual correction of a criterion (pure part — no DB, no browser).
 *
 * The UI lets an operator who re-checked a test flip one criterion's verdict on
 * one captured page. `rescorePageFromVerdicts` is what turns that flip into
 * numbers: it re-derives points, topic scores and overall/GEO/China from the
 * verdicts STORED on the page instead of from its EvidenceBundle.
 *
 * What has to hold:
 *  - untouched verdicts re-score to exactly what the engine had measured, so
 *    opening the editor and changing nothing cannot move a score;
 *  - a flipped verdict propagates to its topic and to the overall;
 *  - the China page rule (first criterion carries the topic) and topic 12's
 *    derived component still apply — a correction must not bypass them.
 *
 * Fabricated topics + makeEvidence only (same discipline as engine.test.ts).
 */
import { describe, it, expect } from "vitest";
import { makeEvidence } from "../src/core/fixture";
import type { Control, PageResult, TopicModule } from "../src/core/types";
import type { EvidenceBundle } from "../src/core/schema";
import {
  countPendingConfirmations,
  defaultConfig,
  scorePage,
  scoreSiteFromPages,
  rescorePageFromVerdicts,
} from "../src/engine/index";

function makeControl(
  id: string,
  topicId: number,
  defaultPoints: number,
  passedFn: (e: EvidenceBundle) => boolean,
  extra: Partial<Control> = {},
): Control {
  return {
    id,
    topicId,
    label: id,
    description: id,
    defaultPoints,
    evaluate: (e) => ({
      passed: passedFn(e),
      evidence: passedFn(e) ? "passed" : "failed",
    }),
    ...extra,
  };
}

const topics: TopicModule[] = [
  {
    id: 1,
    name: "Images",
    hasNA: false,
    standalone: false,
    controls: [
      makeControl("t1.c1", 1, 30, () => true),
      makeControl("t1.c2", 1, 25, () => false),
    ],
  },
  {
    id: 2,
    name: "Slider",
    hasNA: true,
    standalone: false,
    controls: [makeControl("t2.c1", 2, 40, () => true, { appliesTo: () => false })],
  },
  {
    id: 11,
    name: "GEO",
    hasNA: false,
    standalone: true,
    controls: [makeControl("t11.c1", 11, 50, () => false)],
  },
  {
    id: 12,
    name: "China",
    hasNA: false,
    standalone: true,
    controls: [
      // Derived: its points come from topics 1–10, never from a stored verdict.
      makeControl("t12.basics", 12, 50, () => false, { derivedFromTopics: true }),
      makeControl("t12.c2", 12, 50, () => false),
    ],
  },
];

const cfg = defaultConfig(topics);
const bundle = makeEvidence({ url: "https://example.com/" });

/** The stored result of a page, with one criterion's verdict overridden. */
function withVerdict(
  page: PageResult,
  controlId: string,
  patch: { applicable?: boolean; passed: boolean },
): PageResult {
  const copy = structuredClone(page);
  for (const t of copy.topics) {
    for (const c of t.controls) {
      if (c.controlId !== controlId) continue;
      c.applicable = patch.applicable ?? true;
      c.passed = patch.passed;
      c.manual = true;
    }
  }
  return copy;
}

const controlOf = (page: PageResult, id: string) =>
  page.topics.flatMap((t) => t.controls).find((c) => c.controlId === id)!;
const topicOf = (page: PageResult, id: number) =>
  page.topics.find((t) => t.topicId === id)!;

describe("rescorePageFromVerdicts", () => {
  it("is a no-op on an untouched page", () => {
    const measured = scorePage(bundle, topics, cfg);
    expect(rescorePageFromVerdicts(measured, topics, cfg)).toEqual(measured);
  });

  it("propagates a corrected verdict to its criterion, topic and overall", () => {
    const measured = scorePage(bundle, topics, cfg);
    expect(topicOf(measured, 1).score).toBe(30); // c1 passes, c2 does not
    expect(measured.overall).toBe(30); // topic 2 is N/A, so topic 1 alone

    // The operator re-checked t1.c2 and it does hold on this page.
    const fixed = rescorePageFromVerdicts(
      withVerdict(measured, "t1.c2", { passed: true }),
      topics,
      cfg,
    );
    expect(controlOf(fixed, "t1.c2").pointsAwarded).toBe(25);
    expect(topicOf(fixed, 1).score).toBe(55);
    expect(fixed.overall).toBe(55);
    // And the correction flag survives the re-score — the UI shows it.
    expect(controlOf(fixed, "t1.c2").manual).toBe(true);
  });

  it("drops a criterion to N/A, which removes its points from the topic max", () => {
    const measured = scorePage(bundle, topics, cfg);
    const fixed = rescorePageFromVerdicts(
      withVerdict(measured, "t1.c1", { applicable: false, passed: false }),
      topics,
      cfg,
    );
    const c1 = controlOf(fixed, "t1.c1");
    expect(c1.applicable).toBe(false);
    expect(c1.maxPoints).toBe(0);
    expect(topicOf(fixed, 1).score).toBe(0); // only the still-failing c2 remains
  });

  it("re-derives GEO from the corrected verdict", () => {
    const measured = scorePage(bundle, topics, cfg);
    expect(measured.geo).toBe(0);
    const fixed = rescorePageFromVerdicts(
      withVerdict(measured, "t11.c1", { passed: true }),
      topics,
      cfg,
    );
    expect(fixed.geo).toBe(50);
  });

  it("keeps the China rule: only the first criterion of a topic is measurable", () => {
    const measured = scorePage(bundle, topics, cfg, "china");
    // t1.c2 is N/A on a China page — correcting it must not award anything.
    const fixed = rescorePageFromVerdicts(
      withVerdict(measured, "t1.c2", { passed: true }),
      topics,
      cfg,
    );
    expect(controlOf(fixed, "t1.c2").applicable).toBe(false);
    expect(controlOf(fixed, "t1.c2").pointsAwarded).toBe(0);
    expect(topicOf(fixed, 1).score).toBe(topicOf(measured, 1).score);
  });

  it("recomputes topic 12's derived component after a correction", () => {
    const measured = scorePage(bundle, topics, cfg, "china");
    // Topic 1 carries 100 (its first criterion passes), topic 2 is N/A → 100.
    expect(measured.overall).toBe(100);
    expect(controlOf(measured, "t12.basics").pointsAwarded).toBe(50);

    // Correcting topic 1's carrying criterion to a failure halves nothing less
    // than the China score: the derived component follows the fundamentals.
    const fixed = rescorePageFromVerdicts(
      withVerdict(measured, "t1.c1", { passed: false }),
      topics,
      cfg,
    );
    expect(fixed.overall).toBe(0);
    expect(controlOf(fixed, "t12.basics").pointsAwarded).toBe(0);
    expect(fixed.china).toBe(0);
  });

  it("feeds the site aggregate the corrected verdicts", () => {
    const measured = scorePage(bundle, topics, cfg);
    const other = scorePage(
      makeEvidence({ url: "https://example.com/plp" }),
      topics,
      cfg,
    );
    const before = scoreSiteFromPages("Example", [measured, other], topics, cfg);
    expect(before.topics.find((t) => t.topicId === 1)!.score).toBe(30);

    const fixed = rescorePageFromVerdicts(
      withVerdict(measured, "t1.c2", { passed: true }),
      topics,
      cfg,
    );
    const after = scoreSiteFromPages("Example", [fixed, other], topics, cfg);
    // t1.c2 now passes on 1 page of 2 → proportional average: round(25 × 1/2).
    expect(after.topics.find((t) => t.topicId === 1)!.score).toBe(43);
  });
});

/* ── « à confirmer » (unknown) criteria ───────────────────────────────────── */

/**
 * Same topics, but t1.c2 is a control that CANNOT measure on this bundle: it
 * returns `unknown` with `passed:false`, so it costs its points until an
 * operator arbitrates it.
 */
const unknownTopics: TopicModule[] = [
  {
    id: 1,
    name: "Images",
    hasNA: false,
    standalone: false,
    controls: [
      makeControl("t1.c1", 1, 30, () => true),
      {
        ...makeControl("t1.c2", 1, 25, () => false),
        evaluate: () => ({
          passed: false,
          unknown: true,
          evidence: "À confirmer : not measurable",
        }),
      },
    ],
  },
];
const unknownCfg = defaultConfig(unknownTopics);

/**
 * The mutation the correction route performs on the stored result, before
 * handing it to `rescorePageFromVerdicts`. Mirrors
 * `POST /runs/:id/pages/:runPageId/criteria/:controlId`.
 */
function applyRouteVerdict(
  page: PageResult,
  controlId: string,
  verdict: "pass" | "fail" | "na" | "auto",
): PageResult {
  const copy = structuredClone(page);
  const c = controlOf(copy, controlId);
  if (verdict === "auto") {
    if (!c.auto) throw new Error("nothing to restore");
    c.applicable = c.auto.applicable;
    c.passed = c.auto.passed;
    c.evidence = c.auto.evidence;
    if (c.auto.unknown === true) c.unknown = true;
    else delete c.unknown;
    delete c.manual;
    delete c.auto;
  } else {
    c.auto ??= {
      applicable: c.applicable,
      passed: c.passed,
      evidence: c.evidence,
      ...(c.unknown === true ? { unknown: true } : {}),
    };
    c.applicable = verdict !== "na";
    c.passed = verdict === "pass";
    c.manual = true;
    c.evidence = "Corrigé manuellement";
  }
  return copy;
}

/** Criteria still waiting for a human verdict on this page. */
const pending = (page: PageResult) => countPendingConfirmations(page.topics);

describe("manual arbitration of an « à confirmer » criterion", () => {
  it("scores it as a failure and queues it for confirmation", () => {
    const measured = scorePage(bundle, unknownTopics, unknownCfg);
    const c2 = controlOf(measured, "t1.c2");
    expect(c2.unknown).toBe(true);
    expect(c2.passed).toBe(false);
    expect(c2.pointsAwarded).toBe(0);
    expect(topicOf(measured, 1).score).toBe(30);
    expect(pending(measured)).toBe(1);
  });

  it("a manual verdict wins and takes it out of the queue", () => {
    const measured = scorePage(bundle, unknownTopics, unknownCfg);
    const fixed = rescorePageFromVerdicts(
      applyRouteVerdict(measured, "t1.c2", "pass"),
      unknownTopics,
      unknownCfg,
    );
    const c2 = controlOf(fixed, "t1.c2");
    expect(c2.passed).toBe(true);
    expect(c2.pointsAwarded).toBe(25);
    expect(c2.manual).toBe(true);
    // The flag stays on the record (it says HOW the engine had judged it), but
    // an arbitrated criterion is no longer pending.
    expect(c2.unknown).toBe(true);
    expect(pending(fixed)).toBe(0);
    expect(topicOf(fixed, 1).score).toBe(55);
  });

  it("« ↺ mesuré » puts it back to « à confirmer »", () => {
    const measured = scorePage(bundle, unknownTopics, unknownCfg);
    const fixed = rescorePageFromVerdicts(
      applyRouteVerdict(measured, "t1.c2", "pass"),
      unknownTopics,
      unknownCfg,
    );
    const restored = rescorePageFromVerdicts(
      applyRouteVerdict(fixed, "t1.c2", "auto"),
      unknownTopics,
      unknownCfg,
    );
    const c2 = controlOf(restored, "t1.c2");
    expect(c2.manual).toBeUndefined();
    expect(c2.unknown).toBe(true);
    expect(c2.passed).toBe(false);
    expect(pending(restored)).toBe(1);
    expect(topicOf(restored, 1).score).toBe(30);
  });

  it("propagates to the site aggregate, which is provisional too", () => {
    const measured = scorePage(bundle, unknownTopics, unknownCfg);
    const site = scoreSiteFromPages("Example", [measured], unknownTopics, unknownCfg);
    expect(countPendingConfirmations(site.topics)).toBe(1);

    const fixed = rescorePageFromVerdicts(
      applyRouteVerdict(measured, "t1.c2", "fail"),
      unknownTopics,
      unknownCfg,
    );
    const after = scoreSiteFromPages("Example", [fixed], unknownTopics, unknownCfg);
    // Same score as before (it was already counted as a failure) but no longer
    // provisional: a human decided it.
    expect(after.topics.find((t) => t.topicId === 1)!.score).toBe(30);
    expect(countPendingConfirmations(after.topics)).toBe(0);
  });
});
