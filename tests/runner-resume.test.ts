/**
 * Resume of an interrupted run (pure parts — no DB, no browser):
 *  - which pages a resume recaptures (planResume);
 *  - that rebuilding a site from stored per-page results gives exactly the same
 *    numbers as scoring it from the live bundles. That equivalence is what lets a
 *    resume recapture ONLY the missing pages: the bundles of the pages captured
 *    before the interruption are gone, their per-page results are not.
 *
 * Uses fabricated topics + makeEvidence only (same discipline as engine.test.ts).
 */
import { describe, it, expect } from "vitest";
import { makeEvidence } from "../src/core/fixture";
import type { TopicModule, Control } from "../src/core/types";
import type { EvidenceBundle } from "../src/core/schema";
import { defaultConfig, scoreSite, scorePage, scoreSiteFromPages } from "../src/engine/index";
import { planResume, type ResumablePage } from "../src/web/runner";

/* ── planResume ──────────────────────────────────────────────────────────── */

/** Compact page factory: `p(1, "DONE")` = a page of site 1 already captured. */
function p(siteId: number, status: string, id = 0): ResumablePage & { id: number } {
  return { id, status, page: { siteId } };
}

describe("planResume", () => {
  it("recaptures only the pages that are not DONE", () => {
    const pages = [
      p(1, "DONE", 1),
      p(1, "RUNNING", 2), // interrupted mid-capture
      p(2, "DONE", 3),
      p(2, "PENDING", 4), // never started
      p(3, "FAILED", 5),
    ];
    expect(planResume(pages).map((x) => x.id)).toEqual([2, 4, 5]);
  });

  it("keeps every DONE page of a partially captured site", () => {
    // The site pays only for its missing page: its aggregate is rebuilt from the
    // per-page scores of the other two.
    const pages = [p(1, "DONE", 1), p(1, "DONE", 2), p(1, "FAILED", 3)];
    expect(planResume(pages).map((x) => x.id)).toEqual([3]);
  });

  it("returns nothing when the run is already complete", () => {
    expect(planResume([p(1, "DONE", 1), p(1, "DONE", 2)])).toEqual([]);
    expect(planResume([])).toEqual([]);
  });
});

/* ── fabricated topics (mirrors engine.test.ts) ──────────────────────────── */

function makeControl(
  id: string,
  topicId: number,
  defaultPoints: number,
  passedFn: (e: EvidenceBundle) => boolean,
  appliesToFn?: (e: EvidenceBundle) => boolean,
): Control {
  return {
    id,
    topicId,
    label: id,
    description: id,
    defaultPoints,
    appliesTo: appliesToFn,
    evaluate: (e) => ({
      passed: passedFn(e),
      evidence: passedFn(e) ? "passed" : "failed",
    }),
  };
}

const hasMarker = (e: EvidenceBundle) => e.rawHtml.includes("MARK");

const topics: TopicModule[] = [
  {
    id: 1,
    name: "Images",
    hasNA: false,
    standalone: false,
    controls: [
      makeControl("t1.c1", 1, 30, () => true), // passes on every page
      makeControl("t1.c2", 1, 25, hasMarker), // passes on one page out of two
      makeControl("t1.c3", 1, 20, () => false), // never passes
    ],
  },
  {
    id: 2,
    name: "Slider",
    hasNA: true,
    standalone: false,
    // Applicable on the marked page only → the site aggregate must ignore the
    // other page rather than counting it as a failure.
    controls: [makeControl("t2.c1", 2, 30, () => true, hasMarker)],
  },
  {
    id: 3,
    name: "Video",
    hasNA: true,
    standalone: false,
    controls: [makeControl("t3.c1", 3, 30, () => true, () => false)], // N/A everywhere
  },
  {
    id: 11,
    name: "GEO",
    hasNA: false,
    standalone: true,
    controls: [makeControl("t11.c1", 11, 50, hasMarker)],
  },
  {
    id: 12,
    name: "China",
    hasNA: false,
    standalone: true,
    controls: [makeControl("t12.c1", 12, 40, () => false)],
  },
];

/** Two pages that disagree, so the proportional average has something to average. */
const pages = [
  makeEvidence({ url: "https://example.com/", rawHtml: "<html>MARK</html>" }),
  makeEvidence({ url: "https://example.com/plp", rawHtml: "<html></html>" }),
];

/* ── equivalence ─────────────────────────────────────────────────────────── */

describe("scoreSiteFromPages", () => {
  const cfg = defaultConfig(topics);

  it("matches scoreSite down to every criterion", () => {
    const fromBundles = scoreSite("Example", pages, topics, cfg);
    const fromStored = scoreSiteFromPages(
      "Example",
      pages.map((b) => scorePage(b, topics, cfg)),
      topics,
      cfg,
    );

    expect(fromStored.overall).toBe(fromBundles.overall);
    expect(fromStored.geo).toBe(fromBundles.geo);
    expect(fromStored.china).toBe(fromBundles.china);
    expect(fromStored.topics.map((t) => [t.topicId, t.score])).toEqual(
      fromBundles.topics.map((t) => [t.topicId, t.score]),
    );

    const criteria = (r: typeof fromBundles) =>
      r.topics.flatMap((t) =>
        t.controls.map((c) => [
          c.controlId,
          c.applicable,
          c.passed,
          c.pointsAwarded,
          c.maxPoints,
          c.evidence,
        ]),
      );
    expect(criteria(fromStored)).toEqual(criteria(fromBundles));
  });

  it("keeps the proportional average of a criterion that passes on one page of two", () => {
    const r = scoreSiteFromPages(
      "Example",
      pages.map((b) => scorePage(b, topics, cfg)),
      topics,
      cfg,
    );
    const c2 = r.topics[0].controls.find((c) => c.controlId === "t1.c2")!;
    expect(c2.pointsAwarded).toBe(13); // round(25 × 1/2)
    expect(c2.passed).toBe(false); // site-level "passed" = validated on EVERY page
    expect(c2.evidence).toBe("Validé sur 1/2 page(s)");
  });

  it("keeps a criterion applicable on a single page out of its N/A pages", () => {
    const r = scoreSiteFromPages(
      "Example",
      pages.map((b) => scorePage(b, topics, cfg)),
      topics,
      cfg,
    );
    // Applicable on the marked page only, passed there → full points, not half.
    expect(r.topics.find((t) => t.topicId === 2)!.score).toBe(30);
    // N/A on every page → the topic stays out of the overall average.
    expect(r.topics.find((t) => t.topicId === 3)!.score).toBeNull();
  });

  it("aggregates a control missing from a page's stored results over the pages that have it", () => {
    // A control added to the code after a page was scored: it must not silently
    // fail the older page, it is simply N/A there.
    const scored = pages.map((b) => scorePage(b, topics, cfg));
    const stripped = {
      ...scored[1],
      topics: scored[1].topics.map((t) =>
        t.topicId === 1 ? { ...t, controls: t.controls.filter((c) => c.controlId !== "t1.c2") } : t,
      ),
    };

    const r = scoreSiteFromPages("Example", [scored[0], stripped], topics, cfg);
    const c2 = r.topics[0].controls.find((c) => c.controlId === "t1.c2")!;
    // Only the marked page knows the control, and it passes there → full points.
    expect(c2.pointsAwarded).toBe(25);
    expect(c2.evidence).toBe("Validé sur 1/1 page(s)");
  });
});
