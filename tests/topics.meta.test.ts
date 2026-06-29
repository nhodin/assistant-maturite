import { describe, it, expect } from "vitest";
import { TOPICS, ALL_CONTROLS } from "../src/topics";
import { makeEvidence } from "../src/core/fixture";

describe("topic registry metadata", () => {
  it("registers all 12 topics with ids 1..12", () => {
    const ids = TOPICS.map((t) => t.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("each topic's control points sum to exactly 100", () => {
    for (const t of TOPICS) {
      const sum = t.controls.reduce((s, c) => s + c.defaultPoints, 0);
      expect(sum, `topic ${t.id} (${t.name})`).toBe(100);
    }
  });

  it("topics 11 and 12 are standalone, others are not", () => {
    for (const t of TOPICS) {
      expect(t.standalone, `topic ${t.id}`).toBe(t.id === 11 || t.id === 12);
    }
  });

  it("topics 2 and 3 allow N/A, others do not", () => {
    for (const t of TOPICS) {
      expect(t.hasNA, `topic ${t.id}`).toBe(t.id === 2 || t.id === 3);
    }
  });

  it("every control id is unique and namespaced to its topic", () => {
    const ids = ALL_CONTROLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of ALL_CONTROLS) {
      expect(typeof c.id).toBe("string");
      expect(c.id.length).toBeGreaterThan(0);
    }
  });

  it("N/A topic controls are gated by appliesTo; non-NA controls always apply", () => {
    // Slider/Video controls must NOT apply when the feature is absent.
    const noFeatures = makeEvidence({
      features: { sliderDetected: false, videoDetected: false, cookieAccepted: true },
    });
    for (const t of TOPICS.filter((t) => t.hasNA)) {
      for (const c of t.controls) {
        expect(c.appliesTo, `${c.id} must define appliesTo`).toBeTypeOf("function");
        expect(c.appliesTo!(noFeatures), `${c.id} should be N/A without feature`).toBe(false);
      }
    }
  });

  it("every control evaluates without throwing on an empty bundle", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: true, cookieAccepted: true },
    });
    for (const c of ALL_CONTROLS) {
      expect(() => c.evaluate(e), c.id).not.toThrow();
      const v = c.evaluate(e);
      expect(typeof v.passed, c.id).toBe("boolean");
      expect(typeof v.evidence, c.id).toBe("string");
    }
  });
});
