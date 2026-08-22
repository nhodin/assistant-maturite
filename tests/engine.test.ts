/**
 * Engine unit tests — use fabricated topics + makeEvidence only.
 * Never imports from ../src/topics or ../src/collector.
 */
import { describe, it, expect } from "vitest";
import { makeEvidence } from "../src/core/fixture";
import type { TopicModule, Control } from "../src/core/types";
import type { EvidenceBundle } from "../src/core/schema";
import {
  defaultConfig,
  countPendingConfirmations,
  scorePage,
  scoreSite,
  scoreSiteFromPages,
  renderCsv,
  renderMarkdown,
  type ConfigMap,
} from "../src/engine/index";

/* ── fabricated controls ─────────────────────────────────────────────────── */

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

/** A control that always passes */
const alwaysPass = (e: EvidenceBundle) => true;
/** A control that always fails */
const alwaysFail = (e: EvidenceBundle) => false;
/** A control that passes when rawHtml contains a marker */
const passIfMarker = (marker: string) => (e: EvidenceBundle) =>
  e.rawHtml.includes(marker);

/* ── fabricated topics ───────────────────────────────────────────────────── */

/** Non-standalone topic id=1, two controls: 30pts + 20pts */
const topic1: TopicModule = {
  id: 1,
  name: "Images",
  hasNA: false,
  standalone: false,
  controls: [
    makeControl("t1.c1", 1, 30, alwaysPass),
    makeControl("t1.c2", 1, 20, alwaysFail),
  ],
};

/** Non-standalone topic id=10, one control: 20pts */
const topic10: TopicModule = {
  id: 10,
  name: "CDN",
  hasNA: false,
  standalone: false,
  controls: [makeControl("t10.c1", 10, 20, alwaysPass)],
};

/** Standalone topic id=11 */
const topic11: TopicModule = {
  id: 11,
  name: "GEO",
  hasNA: false,
  standalone: true,
  controls: [makeControl("t11.c1", 11, 50, alwaysPass)],
};

/** Standalone topic id=12 */
const topic12: TopicModule = {
  id: 12,
  name: "China",
  hasNA: false,
  standalone: true,
  controls: [makeControl("t12.c1", 12, 40, alwaysFail)],
};

/** Topic with appliesTo that returns false (slider-like) */
const topicNA: TopicModule = {
  id: 2,
  name: "Slider",
  hasNA: true,
  standalone: false,
  controls: [
    makeControl("t2.c1", 2, 30, alwaysPass, () => false),
  ],
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

const singlePage = [makeEvidence()];

/* ══════════════════════════════════════════════════════════════════════════ */

describe("1. Points = override ?? default, only when passed", () => {
  it("awards defaultPoints when passed and no override", () => {
    const topics = [topic1];
    const cfg = defaultConfig(topics);
    const result = scoreSite("site", singlePage, topics, cfg);
    const t1 = result.topics[0];

    const c1 = t1.controls.find((c) => c.controlId === "t1.c1")!;
    expect(c1.passed).toBe(true);
    expect(c1.pointsAwarded).toBe(30);
    expect(c1.maxPoints).toBe(30);

    const c2 = t1.controls.find((c) => c.controlId === "t1.c2")!;
    expect(c2.passed).toBe(false);
    expect(c2.pointsAwarded).toBe(0);
    expect(c2.maxPoints).toBe(20);
  });

  it("uses pointsOverride when set", () => {
    const topics = [topic1];
    const cfg = defaultConfig(topics);
    cfg["t1.c1"] = { enabled: true, pointsOverride: 99, naForced: false };

    const result = scoreSite("site", singlePage, topics, cfg);
    const c1 = result.topics[0].controls.find((c) => c.controlId === "t1.c1")!;
    expect(c1.pointsAwarded).toBe(99);
    expect(c1.maxPoints).toBe(99);
  });

  it("pointsOverride on a failing control yields 0 awarded but maxPoints=override", () => {
    const topics = [topic1];
    const cfg = defaultConfig(topics);
    cfg["t1.c2"] = { enabled: true, pointsOverride: 50, naForced: false };

    const result = scoreSite("site", singlePage, topics, cfg);
    const c2 = result.topics[0].controls.find((c) => c.controlId === "t1.c2")!;
    expect(c2.passed).toBe(false);
    expect(c2.pointsAwarded).toBe(0);
    expect(c2.maxPoints).toBe(50);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("2. Topic score capped at 100", () => {
  it("caps topic score at 100 when controls sum > 100", () => {
    const bigTopic: TopicModule = {
      id: 5,
      name: "BigTopic",
      hasNA: false,
      standalone: false,
      controls: [
        makeControl("big.c1", 5, 60, alwaysPass),
        makeControl("big.c2", 5, 60, alwaysPass),
      ],
    };
    const cfg = defaultConfig([bigTopic]);
    const result = scoreSite("site", singlePage, [bigTopic], cfg);
    expect(result.topics[0].score).toBe(100);
  });

  it("does not cap when sum is exactly 100", () => {
    const exactTopic: TopicModule = {
      id: 6,
      name: "ExactTopic",
      hasNA: false,
      standalone: false,
      controls: [
        makeControl("ex.c1", 6, 50, alwaysPass),
        makeControl("ex.c2", 6, 50, alwaysPass),
      ],
    };
    const cfg = defaultConfig([exactTopic]);
    const result = scoreSite("site", singlePage, [exactTopic], cfg);
    expect(result.topics[0].score).toBe(100);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("3. N/A topic → score null, excluded from overall", () => {
  it("returns null score when all controls are N/A (appliesTo=false)", () => {
    const topics = [topicNA];
    const cfg = defaultConfig(topics);
    const result = scoreSite("site", singlePage, topics, cfg);
    expect(result.topics[0].score).toBeNull();
  });

  it("N/A topic is excluded from overall average", () => {
    // topic1 scores 30 (only c1 passes), topicNA is null
    // overall = average of non-standalone non-null → just topic1 = 30
    const topics = [topic1, topicNA];
    const cfg = defaultConfig(topics);
    const result = scoreSite("site", singlePage, topics, cfg);

    const naTopicResult = result.topics.find((t) => t.topicId === 2)!;
    expect(naTopicResult.score).toBeNull();

    // overall should be 30 (only topic1 counts)
    expect(result.overall).toBe(30);
  });

  it("naForced config makes a topic N/A even if controls would pass", () => {
    const topics = [topic1];
    const cfg = defaultConfig(topics);
    // Force N/A on both controls of topic1
    cfg["t1.c1"] = { enabled: true, pointsOverride: null, naForced: true };
    cfg["t1.c2"] = { enabled: true, pointsOverride: null, naForced: true };

    const result = scoreSite("site", singlePage, topics, cfg);
    expect(result.topics[0].score).toBeNull();
    expect(result.overall).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("4. Site aggregation: proportional average per criterion", () => {
  it("awards proportional points when a control passes on 1 of 2 pages", () => {
    // Control passes only if rawHtml contains "MAGIC"
    const conditionalTopic: TopicModule = {
      id: 7,
      name: "Conditional",
      hasNA: false,
      standalone: false,
      controls: [makeControl("cond.c1", 7, 30, passIfMarker("MAGIC"))],
    };

    const page1 = makeEvidence({ rawHtml: "<!doctype html><body>nothing</body>" });
    const page2 = makeEvidence({ rawHtml: "<!doctype html><body>MAGIC</body>" });

    const cfg = defaultConfig([conditionalTopic]);
    const result = scoreSite("site", [page1, page2], [conditionalTopic], cfg);

    const ctrl = result.topics[0].controls[0];
    // passes on 1 of 2 applicable pages → round(30 × 1/2) = 15
    expect(ctrl.pointsAwarded).toBe(15);
    // "passed" at site level means validated on EVERY applicable page
    expect(ctrl.passed).toBe(false);
    expect(result.topics[0].score).toBe(15);
  });

  it("rounds the proportional average (2 of 3 pages → 20)", () => {
    const conditionalTopic: TopicModule = {
      id: 7,
      name: "Conditional",
      hasNA: false,
      standalone: false,
      controls: [makeControl("cond.c1", 7, 30, passIfMarker("MAGIC"))],
    };

    const page1 = makeEvidence({ rawHtml: "<!doctype html><body>MAGIC</body>" });
    const page2 = makeEvidence({ rawHtml: "<!doctype html><body>MAGIC</body>" });
    const page3 = makeEvidence({ rawHtml: "<!doctype html><body>nothing</body>" });

    const cfg = defaultConfig([conditionalTopic]);
    const result = scoreSite("site", [page1, page2, page3], [conditionalTopic], cfg);

    // round(30 × 2/3) = 20
    expect(result.topics[0].controls[0].pointsAwarded).toBe(20);
  });

  it("awards full points when the control passes on every page", () => {
    const conditionalTopic: TopicModule = {
      id: 7,
      name: "Conditional",
      hasNA: false,
      standalone: false,
      controls: [makeControl("cond.c1", 7, 30, passIfMarker("MAGIC"))],
    };
    const page1 = makeEvidence({ rawHtml: "<!doctype html><body>MAGIC</body>" });
    const page2 = makeEvidence({ rawHtml: "<!doctype html><body>MAGIC</body>" });

    const cfg = defaultConfig([conditionalTopic]);
    const result = scoreSite("site", [page1, page2], [conditionalTopic], cfg);

    const ctrl = result.topics[0].controls[0];
    expect(ctrl.passed).toBe(true);
    expect(ctrl.pointsAwarded).toBe(30);
  });

  it("fails when control fails on all pages", () => {
    const conditionalTopic: TopicModule = {
      id: 8,
      name: "Conditional2",
      hasNA: false,
      standalone: false,
      controls: [makeControl("cond2.c1", 8, 30, passIfMarker("MAGIC"))],
    };

    const page1 = makeEvidence({ rawHtml: "<!doctype html><body>nothing</body>" });
    const page2 = makeEvidence({ rawHtml: "<!doctype html><body>also nothing</body>" });

    const cfg = defaultConfig([conditionalTopic]);
    const result = scoreSite("site", [page1, page2], [conditionalTopic], cfg);

    const ctrl = result.topics[0].controls[0];
    expect(ctrl.passed).toBe(false);
    expect(ctrl.pointsAwarded).toBe(0);
  });

  it("exposes a per-page breakdown with binary control scores", () => {
    const conditionalTopic: TopicModule = {
      id: 7,
      name: "Conditional",
      hasNA: false,
      standalone: false,
      controls: [makeControl("cond.c1", 7, 30, passIfMarker("MAGIC"))],
    };
    const page1 = makeEvidence({ rawHtml: "<!doctype html><body>nothing</body>" });
    const page2 = makeEvidence({ rawHtml: "<!doctype html><body>MAGIC</body>" });

    const cfg = defaultConfig([conditionalTopic]);
    const result = scoreSite("site", [page1, page2], [conditionalTopic], cfg);

    expect(result.pages).toHaveLength(2);
    // page 1: control fails → 0 pts (binary)
    expect(result.pages[0].topics[0].controls[0].pointsAwarded).toBe(0);
    expect(result.pages[0].topics[0].score).toBe(0);
    // page 2: control passes → full 30 pts (binary)
    expect(result.pages[1].topics[0].controls[0].pointsAwarded).toBe(30);
    expect(result.pages[1].topics[0].score).toBe(30);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("5. overall average of non-standalone topics; standalone 11/12 → geo/china", () => {
  it("overall = average of topic1 (30) and topic10 (20) = 25", () => {
    const topics = [topic1, topic10];
    const cfg = defaultConfig(topics);
    const result = scoreSite("site", singlePage, topics, cfg);

    // topic1 = 30 (c1 passes for 30pts, c2 fails)
    // topic10 = 20 (c1 passes)
    // overall = round((30 + 20) / 2) = 25
    expect(result.overall).toBe(25);
    expect(result.geo).toBeNull();
    expect(result.china).toBeNull();
  });

  it("standalone topic 11 goes to geo, not overall; topic 12 is China-pages only", () => {
    const topics = [topic1, topic10, topic11, topic12];
    const cfg = defaultConfig(topics);
    const result = scoreSite("site", singlePage, topics, cfg);

    // topic11 standalone, c1 passes → geo=50
    expect(result.geo).toBe(50);
    // topic12 is only measured on China pages — there are none here.
    expect(result.china).toBeNull();
    expect(result.chinaTopics).toBeNull();
    expect(result.chinaOverall).toBeNull();

    // overall still only 25 (topics 1 and 10)
    expect(result.overall).toBe(25);
  });

  it("returns overall=null when all non-standalone topics are N/A", () => {
    const topics = [topicNA]; // id=2, non-standalone, N/A
    const cfg = defaultConfig(topics);
    const result = scoreSite("site", singlePage, topics, cfg);
    expect(result.overall).toBeNull();
  });

  it("rounds overall to nearest integer", () => {
    // Need three non-standalone topics to get a non-round average
    const t1: TopicModule = {
      id: 1,
      name: "T1",
      hasNA: false,
      standalone: false,
      controls: [makeControl("rnd.c1", 1, 30, alwaysPass)],
    };
    const t3: TopicModule = {
      id: 3,
      name: "T3",
      hasNA: false,
      standalone: false,
      controls: [makeControl("rnd.c2", 3, 20, alwaysPass)],
    };
    // average of 30, 20 = 25 exactly — pick different values
    // 30 + 25 + 20 = 75 / 3 = 25 (round)
    // Use 30, 20, 10 → 20 (round)
    // Use a case where rounding matters: 10, 10, 11 → 10.33 → 10
    const t4: TopicModule = {
      id: 4,
      name: "T4",
      hasNA: false,
      standalone: false,
      controls: [makeControl("rnd.c3", 4, 11, alwaysPass)],
    };

    const cfg = defaultConfig([t1, t3, t4]);
    const result = scoreSite("site", singlePage, [t1, t3, t4], cfg);
    // (30 + 20 + 11) / 3 = 20.33... → rounds to 20
    expect(result.overall).toBe(20);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("renderMarkdown and renderCsv smoke tests", () => {
  it("renderMarkdown includes site name and topic name", () => {
    const topics = [topic1, topic10];
    const cfg = defaultConfig(topics);
    const results = [scoreSite("TESTSITE", singlePage, topics, cfg)];
    const md = renderMarkdown(results, { date: "2026-01-01" });

    expect(md).toContain("TESTSITE");
    expect(md).toContain("Images");
    expect(md).toContain("CDN");
    expect(md).toContain("2026-01-01");
  });

  it("renderCsv produces fixed header as first line", () => {
    const topics = [topic1, topic10];
    const cfg = defaultConfig(topics);
    const results = [scoreSite("TESTSITE", singlePage, topics, cfg)];
    const csv = renderCsv(results);

    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Website;Image management score;Slider management score;Video management score;Third parties score;TTFB/Cache score;JS management score;CSS management score;Critical path score;Fonts management score;CDN score;Technical GEO score;China Market Access score;China pages overall score",
    );
    // Second line should contain TESTSITE and scores for topic1 and topic10
    expect(lines[1]).toContain("TESTSITE");
  });

  it("renderCsv uses N/A for null scores", () => {
    const topics = [topicNA];
    const cfg = defaultConfig(topics);
    const results = [scoreSite("NASITE", singlePage, topics, cfg)];
    const csv = renderCsv(results);
    expect(csv).toContain("N/A");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("loadConfig merges file overrides", () => {
  it("defaultConfig sets all controls to DEFAULT_CONTROL_CONFIG", () => {
    const topics = [topic1];
    const cfg = defaultConfig(topics);
    expect(cfg["t1.c1"]).toEqual({
      enabled: true,
      pointsOverride: null,
      naForced: false,
    });
    expect(cfg["t1.c2"]).toEqual({
      enabled: true,
      pointsOverride: null,
      naForced: false,
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("China pages: first criterion only, topic 12 only there", () => {
  /** Topic whose FIRST criterion fails and whose second one passes. */
  const topicFirstFails: TopicModule = {
    id: 4,
    name: "Third parties",
    hasNA: false,
    standalone: false,
    controls: [
      makeControl("t4.c1", 4, 30, alwaysFail),
      makeControl("t4.c2", 4, 25, alwaysPass),
    ],
  };

  const chinaPage = [{ bundle: makeEvidence(), mode: "china" as const }];

  it("keeps only the first criterion of a topic, worth 100", () => {
    const topics = [topic1];
    const cfg = defaultConfig(topics);
    const result = scoreSite("site", chinaPage, topics, cfg);

    // Standard block is empty: nothing was audited outside China.
    expect(result.overall).toBeNull();

    const t1 = result.chinaTopics!.find((t) => t.topicId === 1)!;
    expect(t1.score).toBe(100); // t1.c1 passes and carries the whole topic

    const c1 = t1.controls.find((c) => c.controlId === "t1.c1")!;
    expect(c1.applicable).toBe(true);
    expect(c1.maxPoints).toBe(100);
    expect(c1.pointsAwarded).toBe(100);

    const c2 = t1.controls.find((c) => c.controlId === "t1.c2")!;
    expect(c2.applicable).toBe(false);
    expect(c2.maxPoints).toBe(0);
    expect(c2.evidence).toContain("1er critère");
  });

  it("scores 0 when the first criterion fails, whatever the others do", () => {
    const topics = [topicFirstFails];
    const cfg = defaultConfig(topics);
    const result = scoreSite("site", chinaPage, topics, cfg);

    const t4 = result.chinaTopics!.find((t) => t.topicId === 4)!;
    expect(t4.score).toBe(0);
    expect(result.chinaOverall).toBe(0);
  });

  it("hands the topic to the next criterion when the first one is disabled", () => {
    const topics = [topicFirstFails];
    const cfg: ConfigMap = {
      ...defaultConfig(topics),
      "t4.c1": { enabled: false, pointsOverride: null, naForced: false },
    };
    const result = scoreSite("site", chinaPage, topics, cfg);

    // t4.c2 passes → the topic is validated on its first ENABLED criterion.
    const t4 = result.chinaTopics!.find((t) => t.topicId === 4)!;
    expect(t4.score).toBe(100);
    expect(t4.controls.find((c) => c.controlId === "t4.c2")!.maxPoints).toBe(100);
  });

  it("scores topic 12 in full on a China page and N/A elsewhere", () => {
    const topics = [topic1, topic12];
    const cfg = defaultConfig(topics);

    const chinaOnly = scoreSite("site", chinaPage, topics, cfg);
    // topic12's single control fails → 0, but it IS measured.
    expect(chinaOnly.china).toBe(0);
    const t12 = chinaOnly.chinaTopics!.find((t) => t.topicId === 12)!;
    expect(t12.controls[0].applicable).toBe(true);
    expect(t12.controls[0].maxPoints).toBe(40); // its declared points, not 100

    const standardOnly = scoreSite("site", singlePage, topics, cfg);
    expect(standardOnly.china).toBeNull();
    const std12 = standardOnly.topics.find((t) => t.topicId === 12)!;
    expect(std12.score).toBeNull();
    expect(std12.controls[0].applicable).toBe(false);
    expect(std12.controls[0].evidence).toContain("pages China");
  });

  it("keeps the two families apart on a mixed site", () => {
    const topics = [topic1, topic10, topic11, topic12];
    const cfg = defaultConfig(topics);
    const result = scoreSite(
      "site",
      [makeEvidence(), { bundle: makeEvidence(), mode: "china" as const }],
      topics,
      cfg,
    );

    // Standard block: unchanged rules (topic1 = 30, topic10 = 20 → overall 25).
    expect(result.overall).toBe(25);
    expect(result.geo).toBe(50);
    expect(result.topics.find((t) => t.topicId === 1)!.score).toBe(30);

    // China block: each topic on its first criterion only.
    expect(result.chinaTopics!.find((t) => t.topicId === 1)!.score).toBe(100);
    expect(result.chinaOverall).toBe(100); // topics 1 and 10 both pass their first criterion
    expect(result.china).toBe(0); // topic 12 fails

    expect(result.pages.map((p) => p.mode)).toEqual(["standard", "china"]);
  });

  it("aggregates from stored page results exactly like from bundles", () => {
    const topics = [topic1, topic10, topic11, topic12];
    const cfg = defaultConfig(topics);
    const inputs = [
      makeEvidence({ url: "https://x/a" }),
      { bundle: makeEvidence({ url: "https://x/cn" }), mode: "china" as const },
    ];
    const fromBundles = scoreSite("site", inputs, topics, cfg);
    const fromStored = scoreSiteFromPages("site", fromBundles.pages, topics, cfg);

    expect(fromStored.overall).toBe(fromBundles.overall);
    expect(fromStored.geo).toBe(fromBundles.geo);
    expect(fromStored.china).toBe(fromBundles.china);
    expect(fromStored.chinaOverall).toBe(fromBundles.chinaOverall);
    expect(fromStored.chinaTopics).toEqual(fromBundles.chinaTopics);
  });

  it("puts the China block in its own CSV columns", () => {
    const topics = [topic1, topic12];
    const cfg = defaultConfig(topics);
    const result = scoreSite(
      "MIXED",
      [makeEvidence(), { bundle: makeEvidence(), mode: "china" as const }],
      topics,
      cfg,
    );
    const line = renderCsv([result]).split("\n")[1].split(";");

    expect(line[0]).toBe("MIXED");
    expect(line[1]).toBe("30"); // topic 1, standard pages
    expect(line[12]).toBe("0"); // topic 12, China pages
    expect(line[13]).toBe("100"); // China pages overall (topic 1 first criterion)
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */

describe("derived control: topic 12's sitespeed-basics component", () => {
  /** 50-pt component computed by the engine from the other topics of the page. */
  const basics: Control = {
    id: "t12.basics",
    topicId: 12,
    label: "Fondamentaux sitespeed",
    description: "derived",
    defaultPoints: 50,
    derivedFromTopics: true,
    evaluate: () => ({ passed: false, evidence: "placeholder" }),
  };
  const topic12d: TopicModule = {
    id: 12,
    name: "China",
    hasNA: false,
    standalone: true,
    controls: [basics, makeControl("t12.c2", 12, 50, alwaysPass)],
  };
  /** Non-standalone topic whose FIRST criterion fails. */
  const topicFirstFails: TopicModule = {
    id: 4,
    name: "Third parties",
    hasNA: false,
    standalone: false,
    controls: [makeControl("t4.c1", 4, 30, alwaysFail)],
  };

  const chinaPage = [{ bundle: makeEvidence(), mode: "china" as const }];

  it("scales the component with the average of topics 1–10", () => {
    // topic1 and topic10 both pass their first criterion → 100/100 average.
    const topics = [topic1, topic10, topic12d];
    const result = scoreSite("site", chinaPage, topics, defaultConfig(topics));

    expect(result.chinaOverall).toBe(100);
    const t12 = result.chinaTopics!.find((t) => t.topicId === 12)!;
    const c = t12.controls.find((x) => x.controlId === "t12.basics")!;
    expect(c.pointsAwarded).toBe(50);
    expect(c.passed).toBe(true);
    expect(c.evidence).toContain("100/100");
    // 50 (derived) + 50 (the other control passes) → topic 12 = 100
    expect(t12.score).toBe(100);
    expect(result.china).toBe(100);
  });

  it("awards half the component when half the topics pass", () => {
    // topic1 passes its first criterion, topicFirstFails does not → average 50.
    const topics = [topic1, topicFirstFails, topic12d];
    const result = scoreSite("site", chinaPage, topics, defaultConfig(topics));

    expect(result.chinaOverall).toBe(50);
    const t12 = result.chinaTopics!.find((t) => t.topicId === 12)!;
    const c = t12.controls.find((x) => x.controlId === "t12.basics")!;
    expect(c.pointsAwarded).toBe(25);
    expect(c.passed).toBe(false); // partial: not the full component
    expect(t12.score).toBe(75); // 25 + 50
    expect(result.china).toBe(75);
  });

  it("ignores its own evaluate() — the engine decides", () => {
    // basics.evaluate says "failed"; the engine still awards the full component.
    const topics = [topic1, topic10, topic12d];
    const result = scoreSite("site", chinaPage, topics, defaultConfig(topics));
    const c = result
      .chinaTopics!.find((t) => t.topicId === 12)!
      .controls.find((x) => x.controlId === "t12.basics")!;
    expect(c.evidence).not.toContain("placeholder");
  });

  it("is N/A when no topic 1–10 is measurable", () => {
    const topics = [topicNA, topic12d]; // topicNA is N/A on every page
    const result = scoreSite("site", chinaPage, topics, defaultConfig(topics));

    expect(result.chinaOverall).toBeNull();
    const t12 = result.chinaTopics!.find((t) => t.topicId === 12)!;
    const c = t12.controls.find((x) => x.controlId === "t12.basics")!;
    expect(c.applicable).toBe(false);
    expect(c.maxPoints).toBe(0);
    // Only the remaining 50-pt control still counts.
    expect(t12.score).toBe(50);
  });

  it("is not measured at all on a standard page", () => {
    const topics = [topic1, topic12d];
    const result = scoreSite("site", singlePage, topics, defaultConfig(topics));
    const t12 = result.topics.find((t) => t.topicId === 12)!;
    expect(t12.score).toBeNull();
    expect(t12.controls.every((c) => !c.applicable)).toBe(true);
  });

  it("survives the stored-results round trip", () => {
    const topics = [topic1, topic10, topic12d];
    const cfg = defaultConfig(topics);
    const fromBundles = scoreSite("site", chinaPage, topics, cfg);
    const fromStored = scoreSiteFromPages("site", fromBundles.pages, topics, cfg);
    expect(fromStored.china).toBe(fromBundles.china);
    expect(fromStored.chinaTopics).toEqual(fromBundles.chinaTopics);
  });
  it("survives page results stored BEFORE the derived control existed", () => {
    // A resume across a scoring change: the page was scored when topic 12 had no
    // basics component, so no fact for it was ever persisted. The component must
    // still be computed from the other topics, not silently dropped to N/A.
    const topics = [topic1, topic10, topic12d];
    const cfg = defaultConfig(topics);
    const fresh = scoreSite("site", chinaPage, topics, cfg);
    const legacyPages = fresh.pages.map((p) => ({
      ...p,
      topics: p.topics.map((t) => ({
        ...t,
        controls: t.controls.filter((c) => c.controlId !== "t12.basics"),
      })),
    }));

    const result = scoreSiteFromPages("site", legacyPages, topics, cfg);
    const c = result
      .chinaTopics!.find((t) => t.topicId === 12)!
      .controls.find((x) => x.controlId === "t12.basics")!;
    expect(c.applicable).toBe(true);
    expect(c.pointsAwarded).toBe(50);
    expect(result.china).toBe(100);
  });
});


/* ══════════════════════════════════════════════════════════════════════════ */

describe("« à confirmer » (unknown) criteria", () => {
  /** A control that cannot measure: unknown + passed:false, per the contract. */
  const unmeasurable = (id: string, topicId: number, points: number): Control => ({
    id,
    topicId,
    label: id,
    description: id,
    defaultPoints: points,
    evaluate: () => ({ passed: false, unknown: true, evidence: "À confirmer : not measurable" }),
  });

  const topicU: TopicModule = {
    id: 1,
    name: "Images",
    hasNA: false,
    standalone: false,
    controls: [
      makeControl("tu.c1", 1, 30, alwaysPass),
      unmeasurable("tu.c2", 1, 20),
      // N/A on this page: applicable=false, so it never counts as pending.
      { ...unmeasurable("tu.c3", 1, 10), appliesTo: () => false },
    ],
  };

  it("propagates unknown into the page result without changing the points", () => {
    const cfg = defaultConfig([topicU]);
    const page = scorePage(makeEvidence(), [topicU], cfg);
    const controls = page.topics[0]!.controls;
    const c2 = controls.find((c) => c.controlId === "tu.c2")!;
    expect(c2.unknown).toBe(true);
    expect(c2.passed).toBe(false);
    expect(c2.pointsAwarded).toBe(0);
    // A measured criterion carries no flag at all (back-compat: absent = false).
    expect(controls.find((c) => c.controlId === "tu.c1")!.unknown).toBeUndefined();
    expect(page.topics[0]!.score).toBe(30);
  });

  it("countPendingConfirmations counts applicable, unarbitrated criteria only", () => {
    const cfg = defaultConfig([topicU]);
    const page = scorePage(makeEvidence(), [topicU], cfg);
    expect(countPendingConfirmations(page.topics)).toBe(1); // tu.c3 is N/A

    // A manual arbitration takes it out of the queue, unknown flag or not.
    const arbitrated = page.topics.map((t) => ({
      ...t,
      controls: t.controls.map((c) =>
        c.controlId === "tu.c2" ? { ...c, manual: true } : c,
      ),
    }));
    expect(countPendingConfirmations(arbitrated)).toBe(0);
  });

  it("counts 0 on a stored result predating the field, and on empty input", () => {
    const cfg = defaultConfig([topic1]);
    expect(countPendingConfirmations(scorePage(makeEvidence(), [topic1], cfg).topics)).toBe(0);
    expect(countPendingConfirmations(null)).toBe(0);
    expect(countPendingConfirmations([])).toBe(0);
  });

  it("surfaces at site level while a page is still unarbitrated", () => {
    const cfg = defaultConfig([topicU]);
    const site = scoreSite("site", [makeEvidence()], [topicU], cfg);
    const c2 = site.topics[0]!.controls.find((c) => c.controlId === "tu.c2")!;
    expect(c2.unknown).toBe(true);
    expect(countPendingConfirmations(site.topics)).toBe(1);

    // …and disappears once every page's verdict has been decided by hand.
    const pages = scoreSite("site", [makeEvidence()], [topicU], cfg).pages.map((p) => ({
      ...p,
      topics: p.topics.map((t) => ({
        ...t,
        controls: t.controls.map((c) =>
          c.controlId === "tu.c2" ? { ...c, manual: true, passed: true } : c,
        ),
      })),
    }));
    const rebuilt = scoreSiteFromPages("site", pages, [topicU], cfg);
    expect(countPendingConfirmations(rebuilt.topics)).toBe(0);
  });
});
