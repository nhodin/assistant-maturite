/**
 * Tests for Topic 2 — Slider management
 * Controls: slider.firstimgnojs (30), slider.reservedspace (25),
 *           slider.lazyloadrest (20), slider.delaynext (15), slider.preloadnext (10)
 *
 * Every markup control is scoped to the slider markup (`sliderWindows`), so fixtures
 * wrap their slides in a slider-named container.
 */
import { describe, it, expect } from "vitest"
import { sliderTopic, sliderWindows, lcpIsSliderImage } from "../src/topics/slider"
import { makeEvidence } from "../src/core/fixture"

// Helper: grab a control by id
function ctrl(id: string) {
  const c = sliderTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

const FEATURES = { sliderDetected: true, videoDetected: false, cookieAccepted: false }

/** Wrap markup in a slider container so it lands inside a slider window. */
const slider = (inner: string) => `<div class="swiper">${inner}</div>`

const lcpImg = (src: string) => ({
  cls: null,
  lcpMs: null,
  lcpElement: { tagName: "IMG", src },
  ttfbMs: null,
  longTasks: [],
  totalBytes: 0,
})

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

// ── sliderWindows / lcpIsSliderImage helpers ──────────────────────────────────

describe("sliderWindows", () => {
  it("returns a window for a slider-named container", () => {
    const wins = sliderWindows(`<header><img src="/logo.png"></header>${slider(
      `<img src="/slide1.jpg">`,
    )}`)
    expect(wins).toHaveLength(1)
    expect(wins[0]).toContain("slide1.jpg")
    expect(wins[0]).not.toContain("logo.png")
  })

  it("ignores slider words appearing in free text only", () => {
    expect(sliderWindows(`<p>our carousel of products</p>`)).toHaveLength(0)
  })

  it("merges nested slider containers into a single window", () => {
    const html = `<div class="swiper"><div class="swiper-wrapper"><div class="swiper-slide"><img src="/s.jpg"></div></div></div>`
    expect(sliderWindows(html)).toHaveLength(1)
  })

  it("matches id and data-* attributes too", () => {
    expect(sliderWindows(`<div id="hero-carousel"><img src="/a.jpg"></div>`)).toHaveLength(1)
    expect(sliderWindows(`<div data-glide-el="track"><img src="/a.jpg"></div>`)).toHaveLength(1)
  })
})

describe("lcpIsSliderImage", () => {
  it("null when there is no LCP element", () => {
    expect(lcpIsSliderImage(makeEvidence({ features: FEATURES }))).toBeNull()
  })

  it("null when the LCP element carries no src", () => {
    const e = makeEvidence({
      features: FEATURES,
      perf: { cls: null, lcpMs: null, lcpElement: { tagName: "H1" }, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    expect(lcpIsSliderImage(e)).toBeNull()
  })

  it("true when the LCP src matches a slider image (loose match on filename)", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(`<img src="/img/slide1.jpg">`)}</body></html>`,
      perf: lcpImg("https://cdn.example.com/img/slide1.jpg?w=800"),
    })
    expect(lcpIsSliderImage(e)).toBe(true)
  })

  it("true when the slide URL only lives in srcset / data-src", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(`<img src="data:image/gif;base64,R0l" data-src="/img/slide9.jpg">`)}</body></html>`,
      perf: lcpImg("https://cdn.example.com/img/slide9.jpg"),
    })
    expect(lcpIsSliderImage(e)).toBe(true)
  })

  it("false when the LCP image is outside the slider", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><img src="/hero.jpg">${slider(`<img src="/slide1.jpg">`)}</body></html>`,
      perf: lcpImg("https://example.com/hero.jpg"),
    })
    expect(lcpIsSliderImage(e)).toBe(false)
  })
})

// ── N/A gate ──────────────────────────────────────────────────────────────────

describe("N/A — sliderDetected:false", () => {
  const noSlider = makeEvidence({
    features: { sliderDetected: false, videoDetected: false, cookieAccepted: false },
  })

  it("all controls return appliesTo===false when no slider detected", () => {
    for (const c of sliderTopic.controls) {
      expect(c.appliesTo).toBeDefined()
      expect(c.appliesTo!(noSlider)).toBe(false)
    }
  })
})

describe("slider gate", () => {
  it("APPLIES — slider detected but no server markup (JS-built slider)", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><div id="app"></div></body></html>`,
    })
    for (const c of sliderTopic.controls) expect(c.appliesTo!(e)).toBe(true)
  })

  it("APPLIES — LCP unknown (not measured)", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(`<img src="/slide1.jpg">`)}</body></html>`,
    })
    for (const c of sliderTopic.controls) expect(c.appliesTo!(e)).toBe(true)
  })

  it("APPLIES — LCP is a slider image", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(`<img src="/slide1.jpg">`)}</body></html>`,
      perf: lcpImg("https://example.com/slide1.jpg"),
    })
    for (const c of sliderTopic.controls) expect(c.appliesTo!(e)).toBe(true)
  })

  it("N/A — LCP is an image outside the slider (slider is not the main display)", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><img src="/hero.jpg">${slider(`<img src="/slide1.jpg">`)}</body></html>`,
      perf: lcpImg("https://example.com/hero.jpg"),
    })
    for (const c of sliderTopic.controls) expect(c.appliesTo!(e)).toBe(false)
  })
})

// ── slider.firstimgnojs (30 pts) ─────────────────────────────────────────────

describe("slider.firstimgnojs", () => {
  const control = ctrl("slider.firstimgnojs")
  expect(control.defaultPoints).toBe(30)

  it("PASS — <img> with https src inside the slider markup", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(
        `<img src="https://cdn.example.com/slide1.jpg" alt="slide">`,
      )}</body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/1.*real src/i)
  })

  it("PASS — <img> with root-relative src inside the slider markup", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(`<img src="/images/slide.jpg">`)}</body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(true)
  })

  it("FAIL — only data: placeholder src in the slider", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(
        `<img src="data:image/gif;base64,R0lGODlh" data-src="https://cdn.example.com/slide.jpg">`,
      )}</body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no.*real.*src/i)
  })

  it("FAIL — only data-src, no real src", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(
        `<img data-src="https://cdn.example.com/slide.jpg">`,
      )}</body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("FAIL — empty slider container", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><div class="slider"></div></body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("FAIL — the only real <img> is the header logo, slider is JS-built", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><header><img src="/logo.svg" alt="logo"></header><div id="app"></div></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no slider markup in server HTML/i)
  })

  it("FAIL — real <img> exists on the page but outside the slider markup", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><header><img src="/logo.svg"></header>${slider(
        `<img data-src="/slide1.jpg">`,
      )}</body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(false)
  })
})

// ── slider.reservedspace (25 pts) ────────────────────────────────────────────

describe("slider.reservedspace", () => {
  const control = ctrl("slider.reservedspace")
  expect(control.defaultPoints).toBe(25)

  it("PASS — CLS = 0.02 (< 0.05)", () => {
    const e = makeEvidence({
      features: FEATURES,
      perf: { cls: 0.02, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/0\.02/)
  })

  it("PASS — CLS = 0.0 (exactly 0)", () => {
    const e = makeEvidence({
      features: FEATURES,
      perf: { cls: 0.0, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    expect(control.evaluate(e).passed).toBe(true)
  })

  it("FAIL — CLS = 0.05 (exactly on threshold)", () => {
    const e = makeEvidence({
      features: FEATURES,
      perf: { cls: 0.05, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/0\.05/)
  })

  it("FAIL — CLS = 0.12", () => {
    const e = makeEvidence({
      features: FEATURES,
      perf: { cls: 0.12, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("À CONFIRMER — CLS null (not measured) → unknown, still not passed", () => {
    const e = makeEvidence({
      features: FEATURES,
      perf: { cls: null, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.unknown).toBe(true)
    expect(result.evidence).toMatch(/not measured/i)
  })

  it("no unknown flag when CLS is measured", () => {
    const e = makeEvidence({
      features: FEATURES,
      perf: { cls: 0.12, lcpMs: null, lcpElement: null, ttfbMs: null, longTasks: [], totalBytes: 0 },
    })
    expect(control.evaluate(e).unknown).toBeUndefined()
  })
})

// ── slider.lazyloadrest (20 pts) ─────────────────────────────────────────────

describe("slider.lazyloadrest", () => {
  const control = ctrl("slider.lazyloadrest")
  expect(control.defaultPoints).toBe(20)

  it("PASS — <img loading=lazy> found in the slider markup", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(`
        <img src="/slide1.jpg">
        <img src="/slide2.jpg" loading="lazy">
      `)}</body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/loading="lazy"/i)
  })

  it("PASS — <img data-src> found (lazy via JS)", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(`
        <img src="/slide1.jpg">
        <img data-src="/slide2.jpg">
      `)}</body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/data-src/i)
  })

  it("PASS — <img data-lazy> found", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(
        `<img data-lazy="https://cdn.example.com/img.jpg">`,
      )}</body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(true)
  })

  it("FAIL — no lazy loading attribute in the slider markup", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body>${slider(`
        <img src="/slide1.jpg">
        <img src="/slide2.jpg">
      `)}</body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no.*lazy/i)
  })

  it("FAIL — the lazy image sits before the slider (page thumbnail, not a slide)", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><nav><img src="/thumb.jpg" loading="lazy"></nav>${slider(
        `<img src="/slide1.jpg">`,
      )}</body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("FAIL — no slider markup in server HTML", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><div id="app"></div></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no slider markup in server HTML/i)
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

  const html = `<html><body>${slider(`
    <img src="https://example.com/slide-1.webp">
    <img data-srcset="https://example.com/slide-2.webp 800w">
  `)}</body></html>`

  it("PASS — a next-slide image loads only after interaction", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: html,
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
      features: FEATURES,
      rawHtml: html,
      requests: [
        mkImg("https://example.com/slide-1.webp", "load"),
        mkImg("https://example.com/slide-2.webp", "load"),
      ],
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("FAIL — the deferred image does not belong to the slider", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: html,
      requests: [
        mkImg("https://example.com/slide-1.webp", "load"),
        mkImg("https://example.com/tracking-pixel.gif", "interaction"),
      ],
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("FAIL — no slider markup in server HTML", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><body><div id="app"></div></body></html>`,
      requests: [mkImg("https://example.com/slide-2.webp", "interaction")],
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no slider markup in server HTML/i)
  })
})

// ── slider.preloadnext (10 pts) ──────────────────────────────────────────────

describe("slider.preloadnext", () => {
  const control = ctrl("slider.preloadnext")
  expect(control.defaultPoints).toBe(10)

  it("PASS — preload href matches a slider image", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><head>
        <link rel="preload" as="image" href="/slide2.jpg">
      </head><body>${slider(
        `<img src="/slide1.jpg"><img data-src="/slide2.jpg">`,
      )}</body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/slider image/i)
  })

  it("FAIL — preload targets the hero image, not a slide", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><head>
        <link rel="preload" as="image" href="/hero.jpg">
      </head><body><img src="/hero.jpg">${slider(
        `<img src="/slide1.jpg">`,
      )}</body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/none targets an image of the slider markup/i)
  })

  it("FAIL — <link rel=preload> in body is ignored (not in head)", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><head></head><body>
        <link rel="preload" as="image" href="/slide2.jpg">
        ${slider(`<img src="/slide2.jpg">`)}
      </body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("FAIL — only preload for stylesheet, not image", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><head>
        <link rel="preload" as="style" href="/main.css">
      </head><body>${slider(`<img src="/slide1.jpg">`)}</body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("FAIL — no preload links at all", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><head><title>Test</title></head><body>${slider(
        `<img src="/slide1.jpg">`,
      )}</body></html>`,
    })
    expect(control.evaluate(e).passed).toBe(false)
  })

  it("FAIL — image preload but slider is JS-built (no server markup)", () => {
    const e = makeEvidence({
      features: FEATURES,
      rawHtml: `<html><head>
        <link rel="preload" as="image" href="/hero.jpg">
      </head><body><div id="app"></div></body></html>`,
    })
    const result = control.evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no slider markup in server HTML/i)
  })
})
