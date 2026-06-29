/**
 * Tests for Topic 5 — TTFB/Cache
 * Controls: ttfb.cdncache(35), ttfb.browsercache(30), ttfb.ttfb800(15),
 *           ttfb.specrules(10), ttfb.bfcache(10)
 */
import { describe, it, expect } from "vitest"
import { ttfbCacheTopic, cacheControlMaxAge } from "../src/topics/ttfbcache"
import { makeEvidence } from "../src/core/fixture"

function ctrl(id: string) {
  const c = ttfbCacheTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

describe("ttfbCacheTopic metadata", () => {
  it("id + points", () => {
    expect(ttfbCacheTopic.id).toBe(5)
    expect(ttfbCacheTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })
})

describe("cacheControlMaxAge", () => {
  it("prefers s-maxage over max-age", () => {
    expect(cacheControlMaxAge("public, max-age=60, s-maxage=3600")).toBe(3600)
  })
  it("falls back to max-age", () => {
    expect(cacheControlMaxAge("public, max-age=600")).toBe(600)
  })
  it("returns null when neither present", () => {
    expect(cacheControlMaxAge("no-store")).toBeNull()
  })
})

describe("ttfb.cdncache", () => {
  it("PASS — cf-cache-status HIT", () => {
    const e = makeEvidence({ mainResponseHeaders: { "cf-cache-status": "HIT" } })
    expect(ctrl("ttfb.cdncache").evaluate(e).passed).toBe(true)
  })
  it("PASS — s-maxage > 0", () => {
    const e = makeEvidence({ mainResponseHeaders: { "cache-control": "s-maxage=3600" } })
    expect(ctrl("ttfb.cdncache").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no cache indicators", () => {
    const e = makeEvidence({ mainResponseHeaders: { "cache-control": "no-store" } })
    expect(ctrl("ttfb.cdncache").evaluate(e).passed).toBe(false)
  })
})

describe("ttfb.browsercache", () => {
  it("PASS — max-age > 0", () => {
    const e = makeEvidence({ mainResponseHeaders: { "cache-control": "max-age=600" } })
    expect(ctrl("ttfb.browsercache").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no-store", () => {
    const e = makeEvidence({ mainResponseHeaders: { "cache-control": "no-store" } })
    expect(ctrl("ttfb.browsercache").evaluate(e).passed).toBe(false)
  })
  it("FAIL — no cache-control header", () => {
    const e = makeEvidence({ mainResponseHeaders: {} })
    expect(ctrl("ttfb.browsercache").evaluate(e).passed).toBe(false)
  })
})

describe("ttfb.ttfb800", () => {
  it("PASS — lab < 800ms, no field", () => {
    const e = makeEvidence({ perf: { ttfbMs: 100 } })
    expect(ctrl("ttfb.ttfb800").evaluate(e).passed).toBe(true)
  })
  it("FAIL — lab >= 800ms", () => {
    const e = makeEvidence({ perf: { ttfbMs: 900 } })
    expect(ctrl("ttfb.ttfb800").evaluate(e).passed).toBe(false)
  })
  it("FAIL — field >= 800ms even if lab ok", () => {
    const e = makeEvidence({
      perf: { ttfbMs: 100 },
      field: { ttfbMs: 900, source: "crux" },
    })
    expect(ctrl("ttfb.ttfb800").evaluate(e).passed).toBe(false)
  })
})

describe("ttfb.specrules", () => {
  it("PASS — speculationrules script", () => {
    const e = makeEvidence({ rawHtml: `<script type="speculationrules">{}</script>` })
    expect(ctrl("ttfb.specrules").evaluate(e).passed).toBe(true)
  })
  it("FAIL — none", () => {
    expect(ctrl("ttfb.specrules").evaluate(makeEvidence()).passed).toBe(false)
  })
})

describe("ttfb.bfcache", () => {
  it("PASS — no unload handlers", () => {
    const e = makeEvidence({ rawHtml: `<body>clean</body>`, renderedHtml: `<body>clean</body>` })
    expect(ctrl("ttfb.bfcache").evaluate(e).passed).toBe(true)
  })
  it("FAIL — onunload present", () => {
    const e = makeEvidence({ rawHtml: `<body onunload="x()"></body>` })
    expect(ctrl("ttfb.bfcache").evaluate(e).passed).toBe(false)
  })
})
