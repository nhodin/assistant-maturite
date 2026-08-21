/**
 * Tests for Topic 11 — Technical GEO (standalone)
 *
 * GEO reuses controls from other topics rather than defining its own thresholds:
 *   geo.nojscontent(40)   ← js.nojsview
 *   geo.ttfb(15)          ← ttfb.ttfb800
 *   geo.htmlcache(15)     ← ttfb.cdncache
 *   geo.compressioncdn(20) ← cdn.brotli AND cdn.region
 *   geo.weight1mb(10)     — GEO's own
 *
 * The borrowed checks are covered by js/ttfbcache/cdn tests; what matters here is
 * that GEO delegates to them faithfully and that the composites are all-or-nothing.
 */
import { describe, it, expect } from "vitest"
import { geoTopic } from "../src/topics/geo"
import { jsTopic } from "../src/topics/js"
import { ttfbCacheTopic } from "../src/topics/ttfbcache"
import { cdnTopic } from "../src/topics/cdn"
import { makeEvidence } from "../src/core/fixture"
import type { EvidenceBundle } from "../src/core"

function ctrl(id: string) {
  const c = geoTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}
function foreign(topic: typeof jsTopic, id: string) {
  const c = topic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

const LONG = `<body><p>${Array.from({ length: 150 }, (_, i) => "word" + i).join(" ")}</p></body>`

/** Headers that satisfy both halves of "Compression & CDN global". */
const CDN_OK = { "content-encoding": "br", "cf-cache-status": "HIT" }

describe("geoTopic metadata", () => {
  it("id/standalone + points", () => {
    expect(geoTopic.id).toBe(11)
    expect(geoTopic.standalone).toBe(true)
    expect(geoTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })

  it("exposes exactly the five regrouped criteria, in weight order", () => {
    expect(geoTopic.controls.map((c) => [c.id, c.defaultPoints])).toEqual([
      ["geo.nojscontent", 40],
      ["geo.ttfb", 15],
      ["geo.htmlcache", 15],
      ["geo.compressioncdn", 20],
      ["geo.weight1mb", 10],
    ])
  })
})

describe("geo.nojscontent — reuses js.nojsview", () => {
  it("PASS — server HTML carries the content", () => {
    expect(ctrl("geo.nojscontent").evaluate(makeEvidence({ rawHtml: LONG })).passed).toBe(true)
  })
  it("FAIL — thin server HTML", () => {
    const e = makeEvidence({ rawHtml: `<body><div>hi</div></body>` })
    expect(ctrl("geo.nojscontent").evaluate(e).passed).toBe(false)
  })
  it("returns the same verdict as the borrowed control, on every bundle", () => {
    const cases: EvidenceBundle[] = [
      makeEvidence({ rawHtml: LONG }),
      makeEvidence({ rawHtml: `<body><div>hi</div></body>` }),
      makeEvidence(),
    ]
    for (const e of cases) {
      expect(ctrl("geo.nojscontent").evaluate(e).passed).toBe(
        foreign(jsTopic, "js.nojsview").evaluate(e).passed,
      )
    }
  })
})

describe("geo.ttfb / geo.htmlcache — the two halves of the old 30-pt composite", () => {
  const fast = { perf: { ttfbMs: 200 } }
  const slow = { perf: { ttfbMs: 2000 } }
  const cached = { mainResponseHeaders: { "cf-cache-status": "HIT" } }

  it("PASS — both halves validated, 15 + 15", () => {
    const e = makeEvidence({ ...fast, ...cached })
    expect(ctrl("geo.ttfb").evaluate(e).passed).toBe(true)
    expect(ctrl("geo.htmlcache").evaluate(e).passed).toBe(true)
    // Both borrowed controls agree.
    expect(foreign(ttfbCacheTopic, "ttfb.ttfb800").evaluate(e).passed).toBe(true)
    expect(foreign(ttfbCacheTopic, "ttfb.cdncache").evaluate(e).passed).toBe(true)
  })

  it("fast but not cached — keeps the TTFB half, loses the cache half", () => {
    const e = makeEvidence(fast)
    expect(ctrl("geo.ttfb").evaluate(e).passed).toBe(true)
    expect(ctrl("geo.htmlcache").evaluate(e).passed).toBe(false)
  })

  it("cached but slow — keeps the cache half, loses the TTFB half", () => {
    const e = makeEvidence({ ...slow, ...cached })
    expect(ctrl("geo.ttfb").evaluate(e).passed).toBe(false)
    expect(ctrl("geo.htmlcache").evaluate(e).passed).toBe(true)
  })

  it("each evidence string names the borrowed criterion it stands for", () => {
    const e = makeEvidence(fast)
    expect(ctrl("geo.ttfb").evaluate(e).evidence).toContain("TTFB")
    expect(ctrl("geo.htmlcache").evaluate(e).evidence).toContain("CDN cache")
  })
})

describe("geo.compressioncdn — Brotli AND CDN by region", () => {
  it("PASS — brotli HTML served from a known CDN", () => {
    const e = makeEvidence({ mainResponseHeaders: CDN_OK })
    expect(ctrl("geo.compressioncdn").evaluate(e).passed).toBe(true)
    expect(foreign(cdnTopic, "cdn.brotli").evaluate(e).passed).toBe(true)
    expect(foreign(cdnTopic, "cdn.region").evaluate(e).passed).toBe(true)
  })

  it("FAIL — CDN but gzip only", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "content-encoding": "gzip", "cf-cache-status": "HIT" },
    })
    expect(ctrl("geo.compressioncdn").evaluate(e).passed).toBe(false)
  })

  it("FAIL — brotli but no CDN fingerprint", () => {
    const e = makeEvidence({ mainResponseHeaders: { "content-encoding": "br" } })
    expect(ctrl("geo.compressioncdn").evaluate(e).passed).toBe(false)
  })
})

describe("geo.weight1mb", () => {
  it("PASS — HTML document under 1 MB", () => {
    const e = makeEvidence({ rawHtml: "x".repeat(500_000) })
    expect(ctrl("geo.weight1mb").evaluate(e).passed).toBe(true)
  })
  it("FAIL — HTML document over 1 MB", () => {
    const e = makeEvidence({ rawHtml: "x".repeat(2_000_000) })
    expect(ctrl("geo.weight1mb").evaluate(e).passed).toBe(false)
  })
  it("PASS — a heavy page with a light document: only the HTML counts", () => {
    const e = makeEvidence({ rawHtml: LONG, perf: { totalBytes: 8_000_000 } })
    expect(ctrl("geo.weight1mb").evaluate(e).passed).toBe(true)
  })
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // 600k 3-byte characters = 1.8 MB of UTF-8, but a string .length of 600k.
    const e = makeEvidence({ rawHtml: "é".repeat(600_000) })
    const r = ctrl("geo.weight1mb").evaluate(e)
    expect(r.passed).toBe(false)
    expect(r.evidence).toContain("1200000 bytes")
  })
  it("reads the stamped htmlBytes, not a truncated rawHtml stub", () => {
    // What a bundle looks like once persisted: rawHtml sliced to 2 KB, the real
    // size carried by htmlBytes. Measuring the stub would wrongly PASS.
    const e = makeEvidence({ rawHtml: "x".repeat(2000), htmlBytes: 2_000_000 })
    expect(ctrl("geo.weight1mb").evaluate(e).passed).toBe(false)
  })
  it("falls back to rawHtml when htmlBytes is absent (older bundles)", () => {
    const e = makeEvidence({ rawHtml: "x".repeat(2_000_000) })
    expect(ctrl("geo.weight1mb").evaluate(e).passed).toBe(false)
  })
  it("FAIL — HTML payload not measured (raw fetch returned nothing)", () => {
    const r = ctrl("geo.weight1mb").evaluate(makeEvidence({ rawHtml: "" }))
    expect(r.passed).toBe(false)
    expect(r.evidence).toContain("unavailable")
  })
})

describe("GEO scores from the reused criteria", () => {
  it("a page passing everything scores 100", () => {
    const e = makeEvidence({
      rawHtml: LONG,
      perf: { ttfbMs: 200, totalBytes: 500_000 },
      mainResponseHeaders: CDN_OK,
    })
    const total = geoTopic.controls.reduce(
      (s, c) => s + (c.evaluate(e).passed ? c.defaultPoints : 0),
      0,
    )
    expect(total).toBe(100)
  })

  it("a JS-only page loses the 40 points of the no-JS criterion", () => {
    const e = makeEvidence({
      rawHtml: `<body><div id="root"></div></body>`,
      perf: { ttfbMs: 200, totalBytes: 500_000 },
      mainResponseHeaders: CDN_OK,
    })
    const total = geoTopic.controls.reduce(
      (s, c) => s + (c.evaluate(e).passed ? c.defaultPoints : 0),
      0,
    )
    expect(total).toBe(60)
  })

  it("a fast page with no HTML cache keeps half of the TTFB/cache weight", () => {
    const e = makeEvidence({
      rawHtml: LONG,
      perf: { ttfbMs: 200, totalBytes: 500_000 },
      mainResponseHeaders: { "content-encoding": "br", "cf-cache-status": "MISS" },
    })
    // 40 (no-JS) + 15 (TTFB) + 0 (no HTML cache) + 20 (brotli + CDN region) + 10 (weight)
    const total = geoTopic.controls.reduce(
      (s, c) => s + (c.evaluate(e).passed ? c.defaultPoints : 0),
      0,
    )
    expect(total).toBe(85)
  })
})
