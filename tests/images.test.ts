/**
 * Unit tests for Topic 1 — Images management
 * One passing + one failing case per control, using makeEvidence() fixtures.
 */
import { describe, it, expect } from "vitest"
import { makeEvidence } from "../src/core/fixture"
import { imagesTopic } from "../src/topics/images"

function ctrl(id: string) {
  const c = imagesTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control not found: ${id}`)
  return c
}

// ── images.lazyload ───────────────────────────────────────────────────────────
describe("images.lazyload", () => {
  it("passes when rawHtml contains at least one <img loading=lazy>", () => {
    const e = makeEvidence({ rawHtml: '<html><body><img src="hero.jpg" loading="lazy"></body></html>' })
    const result = ctrl("images.lazyload").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("1")
  })

  it("fails when no <img loading=lazy> found", () => {
    const e = makeEvidence({ rawHtml: '<html><body><img src="hero.jpg"></body></html>' })
    const result = ctrl("images.lazyload").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no/i)
  })

  it("counts multiple lazy images correctly", () => {
    const e = makeEvidence({
      rawHtml: '<img src="a.jpg" loading="lazy"><img src="b.jpg" loading="lazy"><img src="c.jpg">',
    })
    const result = ctrl("images.lazyload").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("2")
  })
})

// ── images.modernformat ───────────────────────────────────────────────────────
describe("images.modernformat", () => {
  it("passes when majority of image responses are webp", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.webp", resourceType: "image", status: 200, fromCache: false, encodedBytes: 10000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
        { url: "b.webp", resourceType: "image", status: 200, fromCache: false, encodedBytes: 8000, decodedBytes: 16000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
        { url: "c.jpg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 12000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/jpeg" },
      ],
    })
    const result = ctrl("images.modernformat").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("2/3")
  })

  it("passes when majority of image responses are avif", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.avif", resourceType: "image", status: 200, fromCache: false, encodedBytes: 10000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/avif" },
        { url: "b.avif", resourceType: "image", status: 200, fromCache: false, encodedBytes: 8000, decodedBytes: 16000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/avif" },
        { url: "c.jpg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 12000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/jpeg" },
      ],
    })
    const result = ctrl("images.modernformat").evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("fails when majority of image responses are jpeg", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.jpg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 12000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/jpeg" },
        { url: "b.jpg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 12000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/jpeg" },
        { url: "c.webp", resourceType: "image", status: 200, fromCache: false, encodedBytes: 10000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
      ],
    })
    const result = ctrl("images.modernformat").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("1/3")
  })

  it("fails when there are no image requests", () => {
    const e = makeEvidence({ requests: [] })
    const result = ctrl("images.modernformat").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no image/i)
  })
})

// ── images.lcppreload ─────────────────────────────────────────────────────────
describe("images.lcppreload", () => {
  it("passes when LCP element has fetchpriority=high attribute", () => {
    const e = makeEvidence({
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg", fetchPriorityAttr: "high" } },
    })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("fetchpriority")
  })

  it("passes when a <link rel=preload as=image fetchpriority=high> is present in rawHtml", () => {
    const e = makeEvidence({
      rawHtml: '<html><head><link rel="preload" as="image" href="hero.jpg" fetchpriority="high"></head></html>',
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg" } },
    })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("preload")
  })

  it("fails when LCP element has no fetchpriority and no preload link", () => {
    const e = makeEvidence({
      rawHtml: "<html><head></head><body><img src='hero.jpg'></body></html>",
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg" } },
    })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(false)
  })

  it("fails when no LCP element and no preload link", () => {
    const e = makeEvidence({ perf: { lcpElement: null } })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(false)
  })
})

// ── images.fixedheight ────────────────────────────────────────────────────────
describe("images.fixedheight", () => {
  it("passes when ≥60% of imgs have width and height", () => {
    const e = makeEvidence({
      rawHtml: [
        '<img src="a.jpg" width="400" height="300">',
        '<img src="b.jpg" width="200" height="150">',
        '<img src="c.jpg" width="100" height="80">',
        '<img src="d.jpg">',  // no dimensions
      ].join(""),
    })
    const result = ctrl("images.fixedheight").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("3/4")
  })

  it("fails when fewer than 60% of imgs have dimensions", () => {
    const e = makeEvidence({
      rawHtml: [
        '<img src="a.jpg" width="400" height="300">',
        '<img src="b.jpg">',
        '<img src="c.jpg">',
        '<img src="d.jpg">',
      ].join(""),
    })
    const result = ctrl("images.fixedheight").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("1/4")
  })

  it("passes vacuously when no img tags present", () => {
    const e = makeEvidence({ rawHtml: "<html><body>no images here</body></html>" })
    const result = ctrl("images.fixedheight").evaluate(e)
    expect(result.passed).toBe(true)
  })
})

// ── images.lcpnotlazy ────────────────────────────────────────────────────────
describe("images.lcpnotlazy", () => {
  it("passes when LCP element is an IMG without loading=lazy", () => {
    const e = makeEvidence({
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg", loadingAttr: "eager" } },
    })
    const result = ctrl("images.lcpnotlazy").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("not lazy")
  })

  it("passes when LCP element has no loadingAttr", () => {
    const e = makeEvidence({
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg" } },
    })
    const result = ctrl("images.lcpnotlazy").evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("fails when LCP element has loading=lazy", () => {
    const e = makeEvidence({
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg", loadingAttr: "lazy" } },
    })
    const result = ctrl("images.lcpnotlazy").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("lazy")
  })

  it("fails when no LCP element identified", () => {
    const e = makeEvidence({ perf: { lcpElement: null } })
    const result = ctrl("images.lcpnotlazy").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("not identified")
  })
})

// ── images.responsive ────────────────────────────────────────────────────────
describe("images.responsive", () => {
  it("passes when at least one img has srcset", () => {
    const e = makeEvidence({
      rawHtml: '<img src="small.jpg" srcset="medium.jpg 800w, large.jpg 1200w" sizes="100vw">',
    })
    const result = ctrl("images.responsive").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("1")
  })

  it("passes when an img has sizes attribute", () => {
    const e = makeEvidence({
      rawHtml: '<img src="img.jpg" sizes="(max-width: 768px) 100vw, 50vw">',
    })
    const result = ctrl("images.responsive").evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("fails when no img has srcset or sizes", () => {
    const e = makeEvidence({
      rawHtml: '<img src="hero.jpg" width="800" height="600"><img src="thumb.jpg">',
    })
    const result = ctrl("images.responsive").evaluate(e)
    expect(result.passed).toBe(false)
  })
})

// ── images.compressed ────────────────────────────────────────────────────────
describe("images.compressed", () => {
  it("passes when all image requests are under 250 KB", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.webp", resourceType: "image", status: 200, fromCache: false, encodedBytes: 50000, decodedBytes: 80000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
        { url: "b.webp", resourceType: "image", status: 200, fromCache: false, encodedBytes: 100000, decodedBytes: 150000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
      ],
    })
    const result = ctrl("images.compressed").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("98 KB")
  })

  it("fails when one image exceeds 250 KB", () => {
    const e = makeEvidence({
      requests: [
        { url: "heavy.jpg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 512000, decodedBytes: 800000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/jpeg" },
      ],
    })
    const result = ctrl("images.compressed").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("500 KB")
  })

  it("passes vacuously when no image requests", () => {
    const e = makeEvidence({ requests: [] })
    const result = ctrl("images.compressed").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/no image/i)
  })
})

// ── images.earlyhint ─────────────────────────────────────────────────────────
describe("images.earlyhint", () => {
  it("passes when Link header contains rel=preload; as=image", () => {
    const e = makeEvidence({
      mainResponseHeaders: {
        link: '</hero.jpg>; rel=preload; as=image; fetchpriority=high',
      },
    })
    const result = ctrl("images.earlyhint").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("preload")
  })

  it("passes with multiple link directives including an image preload", () => {
    const e = makeEvidence({
      mainResponseHeaders: {
        link: '</font.woff2>; rel=preload; as=font, </hero.avif>; rel=preload; as=image',
      },
    })
    const result = ctrl("images.earlyhint").evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("fails when no Link header present", () => {
    const e = makeEvidence({ mainResponseHeaders: {} })
    const result = ctrl("images.earlyhint").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no link/i)
  })

  it("fails when Link header exists but has no image preload", () => {
    const e = makeEvidence({
      mainResponseHeaders: {
        link: '</font.woff2>; rel=preload; as=font',
      },
    })
    const result = ctrl("images.earlyhint").evaluate(e)
    expect(result.passed).toBe(false)
  })
})

// ── meta: verify total points sum to 100 ─────────────────────────────────────
describe("imagesTopic metadata", () => {
  it("has topicId 1", () => {
    expect(imagesTopic.id).toBe(1)
  })

  it("has 8 controls", () => {
    expect(imagesTopic.controls).toHaveLength(8)
  })

  it("total defaultPoints sum to 100", () => {
    const total = imagesTopic.controls.reduce((sum, c) => sum + c.defaultPoints, 0)
    expect(total).toBe(100)
  })

  it("has hasNA=false and standalone=false", () => {
    expect(imagesTopic.hasNA).toBe(false)
    expect(imagesTopic.standalone).toBe(false)
  })
})
