/**
 * Tests for Topic 11 — Technical GEO (standalone)
 * Controls: geo.ttfb200(15), geo.weight1mb(15), geo.lcp25(10), geo.cls01(10),
 *           geo.ssrcontent(30), geo.ssrratio(15), geo.display2s(5)
 */
import { describe, it, expect } from "vitest"
import { geoTopic } from "../src/topics/geo"
import { makeEvidence } from "../src/core/fixture"

function ctrl(id: string) {
  const c = geoTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

const LONG = `<body><p>${Array.from({ length: 150 }, (_, i) => "word" + i).join(" ")}</p></body>`

describe("geoTopic metadata", () => {
  it("id/standalone + points", () => {
    expect(geoTopic.id).toBe(11)
    expect(geoTopic.standalone).toBe(true)
    expect(geoTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })
})

describe("geo.ttfb200", () => {
  it("PASS — field TTFB < 200ms", () => {
    const e = makeEvidence({ field: { ttfbMs: 150, source: "crux" } })
    expect(ctrl("geo.ttfb200").evaluate(e).passed).toBe(true)
  })
  it("FAIL — lab TTFB >= 200ms (no field)", () => {
    const e = makeEvidence({ perf: { ttfbMs: 500 } })
    expect(ctrl("geo.ttfb200").evaluate(e).passed).toBe(false)
  })
})

describe("geo.weight1mb", () => {
  it("PASS — under 1 MB", () => {
    const e = makeEvidence({ perf: { totalBytes: 500_000 } })
    expect(ctrl("geo.weight1mb").evaluate(e).passed).toBe(true)
  })
  it("FAIL — over 1 MB", () => {
    const e = makeEvidence({ perf: { totalBytes: 2_000_000 } })
    expect(ctrl("geo.weight1mb").evaluate(e).passed).toBe(false)
  })
})

describe("geo.lcp25", () => {
  it("PASS — field LCP < 2.5s", () => {
    const e = makeEvidence({ field: { lcpMs: 2000, source: "crux" } })
    expect(ctrl("geo.lcp25").evaluate(e).passed).toBe(true)
  })
  it("FAIL — lab LCP >= 2.5s", () => {
    const e = makeEvidence({ perf: { lcpMs: 4000 } })
    expect(ctrl("geo.lcp25").evaluate(e).passed).toBe(false)
  })
})

describe("geo.cls01", () => {
  it("PASS — field CLS < 0.1", () => {
    const e = makeEvidence({ field: { cls: 0.05, source: "crux" } })
    expect(ctrl("geo.cls01").evaluate(e).passed).toBe(true)
  })
  it("FAIL — lab CLS >= 0.1", () => {
    const e = makeEvidence({ perf: { cls: 0.3 } })
    expect(ctrl("geo.cls01").evaluate(e).passed).toBe(false)
  })
})

describe("geo.ssrcontent", () => {
  it("PASS — >= 100 words in raw HTML body", () => {
    expect(ctrl("geo.ssrcontent").evaluate(makeEvidence({ rawHtml: LONG })).passed).toBe(true)
  })
  it("FAIL — thin server HTML", () => {
    const e = makeEvidence({ rawHtml: `<body><div>hi</div></body>` })
    expect(ctrl("geo.ssrcontent").evaluate(e).passed).toBe(false)
  })
})

describe("geo.ssrratio", () => {
  it("PASS — raw/rendered ratio > 70%", () => {
    const e = makeEvidence({ rawHtml: LONG, renderedHtml: LONG })
    expect(ctrl("geo.ssrratio").evaluate(e).passed).toBe(true)
  })
  it("FAIL — rendered DOM empty", () => {
    const e = makeEvidence({ rawHtml: LONG })
    expect(ctrl("geo.ssrratio").evaluate(e).passed).toBe(false)
  })
})

describe("geo.display2s", () => {
  it("PASS — lab LCP < 2000ms", () => {
    const e = makeEvidence({ perf: { lcpMs: 1500 } })
    expect(ctrl("geo.display2s").evaluate(e).passed).toBe(true)
  })
  it("FAIL — lab LCP >= 2000ms", () => {
    const e = makeEvidence({ perf: { lcpMs: 3000 } })
    expect(ctrl("geo.display2s").evaluate(e).passed).toBe(false)
  })
})
