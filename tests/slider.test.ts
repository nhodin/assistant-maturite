/**
 * Tests for Topic 2 — Slider management
 * Controls: slider.firstimgnojs (30), slider.reservedspace (25),
 *           slider.lazyloadrest (20), slider.delaynext (15), slider.preloadnext (10)
 */
import { describe, it, expect } from "vitest"
import { sliderTopic } from "../src/topics/slider"
import { makeEvidence } from "../src/core/fixture"

// Helper: grab a control by id
function ctrl(id: string) {
  const c = sliderTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

// ── Topic metadata ────────────────────────────────────────────────────────────

describe("sliderTopic metadata", () => {
  it("has correct id, name, hasNA, standalone", () => {
    expect(sliderTopic.id).toBe(2)
    expect(sliderTopic.name).toBe("Slider management")
    expect(sliderTopic.hasNA).toBe(true)
    expect(sliderTopic.standalone).toBe(false)
  })

  it("has 5 controls", () => {
    expect(sliderTopic.controls).toHaveLength(5)
  })

  it("all controls have correct topicId", () => {
    for (const c of sliderTopic.controls) {
      expect(c.topicId).toBe(2)
    }
  })

  it("defaultPoints total is 100", () => {
    const total = sliderTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)
    expect(total).toBe(100)
  })
})

// ── N/A gate: sliderDetected:false makes every control non-applicable ─────────

describe("N/A — sliderDetected:false", () => {
  const noSlider = makeEvidence({ features: { sliderDetected: false, videoDetected: false, cookieAccepted: false } })

  it("all controls return appliesTo===false when no slider detected", () => {
    for (const c of sliderTopic.controls) {
      expect(c.appliesTo).toBeDefined()
      expect(c.appliesTo!(noSlider)).toBe(false)
    }
  })
})

describe("appliesTo returns true when slider detected", () => {
  const withSlider = makeEvidence({ features: { sliderDetected: true, videoDetected: false, cookieAccepted: false } })

  it("all controls are applicable when sliderDetected:true", () => {
    for (const c of sliderTopic.controls) {
      expect(c.appliesTo!(withSlider)).toBe(true)
    }
  })
})

// ── slider.firstimgnojs (30 pts) ─────────────────────────────────────────────

describe("slider.firstimgnojs", () => {
  const control = ctrl("slider.firstimgnojs")
  expect(control.defaultPoints).toBe(30)

  it("PASS — <img> with https src found in raw HTML", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body><img src="https://cdn.example.com/slide1.jpg" alt="slide"></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/1.*real src/i)
  })

  it("PASS — <img> with root-relative src", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body><img src="/images/slide.jpg"></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("FAIL — only data: placeholder src (no real img)", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body><img src="data:image/gif;base64,R0lGODlh" data-src="https://cdn.example.com/slide.jpg"></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no.*real.*src/i)
  })

  it("FAIL — only data-src, no real src", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body><img data-src="https://cdn.example.com/slide.jpg"></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
  })

  it("FAIL — no img tags at all", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body><div class="slider"></div></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
  })
})

// ── slider.reservedspace (25 pts) ────────────────────────────────────────────

describe("slider.reservedspace", () => {
  const control = ctrl("slider.reservedspace")
  expect(control.defaultPoints).toBe(25)

  it("PASS — CLS = 0.02 (< 0.05)", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      perf: { cls: 0.02, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/0\.02/)
  })

  it("PASS — CLS = 0.0 (exactly 0)", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      perf: { cls: 0.0, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("FAIL — CLS = 0.05 (exactly on threshold)", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      perf: { cls: 0.05, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/0\.05/)
  })

  it("FAIL — CLS = 0.12", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      perf: { cls: 0.12, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
  })

  it("FAIL — CLS null (not measured)", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      perf: { cls: null, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/not measured/i)
  })
})

// ── slider.lazyloadrest (20 pts) ─────────────────────────────────────────────

describe("slider.lazyloadrest", () => {
  const control = ctrl("slider.lazyloadrest")
  expect(control.defaultPoints).toBe(20)

  it("PASS — <img loading=lazy> found", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body>
        <img src="/slide1.jpg">
        <img src="/slide2.jpg" loading="lazy">
      </body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/loading="lazy"/i)
  })

  it("PASS — <img data-src> found (lazy via JS)", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body>
        <img src="/slide1.jpg">
        <img data-src="/slide2.jpg">
      </body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/data-src/i)
  })

  it("PASS — <img data-lazy> found", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body><img data-lazy="https://cdn.example.com/img.jpg"></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("FAIL — no lazy loading attributes found", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><body>
        <img src="/slide1.jpg">
        <img src="/slide2.jpg">
      </body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no.*lazy/i)
  })
})

// ── slider.delaynext (15 pts) ────────────────────────────────────────────────

describe("slider.delaynext", () => {
  const control = ctrl("slider.delaynext")
  expect(control.defaultPoints).toBe(15)

  const mkImg = (url: string, phase: "load" | "interaction") => ({
    url,
    resourceType: "image",
    status: 200,
    fromCache: false,
    encodedBytes: 5000,
    decodedBytes: 5000,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "image/webp",
    phase,
  })

  it("PASS — a next-slide image loads only after interaction", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      requests: [
        mkImg("https://example.com/slide-1.webp", "load"),
        mkImg("https://example.com/slide-2.webp", "interaction"),
      ],
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/deferred next-slide/i)
  })

  it("FAIL — all slider images loaded during initial load", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      requests: [
        mkImg("https://example.com/slide-1.webp", "load"),
        mkImg("https://example.com/slide-2.webp", "load"),
      ],
    })
    expect(control.evaluate(e).passed).toBe(false)
  })
})

// ── slider.preloadnext (10 pts) ──────────────────────────────────────────────

describe("slider.preloadnext", () => {
  const control = ctrl("slider.preloadnext")
  expect(control.defaultPoints).toBe(10)

  it("PASS — <link rel=preload as=image> in <head>", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><head>
        <link rel="preload" as="image" href="/slide2.jpg">
      </head><body></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/preload.*image/i)
  })

  it("FAIL — <link rel=preload> in body is ignored (not in head)", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><head></head><body>
        <link rel="preload" as="image" href="/slide2.jpg">
      </body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
  })

  it("FAIL — only preload for stylesheet, not image", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><head>
        <link rel="preload" as="style" href="/main.css">
      </head><body></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
  })

  it("FAIL — no preload links at all", () => {
    const e = makeEvidence({
      features: { sliderDetected: true, videoDetected: false, cookieAccepted: false },
      rawHtml: `<html><head><title>Test</title></head><body></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
  })
})
