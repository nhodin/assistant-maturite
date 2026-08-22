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

  it("passes on JS-lazyload pattern (data-src with no eager src)", () => {
    const e = makeEvidence({ rawHtml: '<img data-src="hero.jpg" class="lazyload">' })
    const result = ctrl("images.lazyload").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("data-src/data-lazy")
  })

  it("passes on data-lazy attribute with no eager src", () => {
    const e = makeEvidence({ rawHtml: '<img data-lazy="hero.jpg">' })
    expect(ctrl("images.lazyload").evaluate(e).passed).toBe(true)
  })

  it("does NOT count data-src when an eager src is also present", () => {
    const e = makeEvidence({ rawHtml: '<img src="placeholder.jpg" data-src="hero.jpg">' })
    const result = ctrl("images.lazyload").evaluate(e)
    expect(result.passed).toBe(false)
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

  it("excludes SVGs and tiny pixels, flipping the ratio to a pass", () => {
    // Raw counts: 1 webp / 3 total = 33% (would fail). After excluding the 2 SVGs
    // and the sub-1KB tracking pixel, the set is a single webp = 100% (pass).
    const e = makeEvidence({
      requests: [
        { url: "hero.webp", resourceType: "image", status: 200, fromCache: false, encodedBytes: 40000, decodedBytes: 60000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
        { url: "icon.svg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 3000, decodedBytes: 3000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/svg+xml" },
        { url: "logo.svg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 2000, decodedBytes: 2000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/svg+xml" },
        { url: "px.gif", resourceType: "image", status: 200, fromCache: false, encodedBytes: 43, decodedBytes: 43, requestHeaders: {}, responseHeaders: {}, mimeType: "image/gif" },
      ],
    })
    const result = ctrl("images.modernformat").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("1/1")
    expect(result.evidence).toContain("content image")
  })

  it("falls back to the unfiltered set when every image is svg/tiny", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.svg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 2000, decodedBytes: 2000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/svg+xml" },
        { url: "px.gif", resourceType: "image", status: 200, fromCache: false, encodedBytes: 43, decodedBytes: 43, requestHeaders: {}, responseHeaders: {}, mimeType: "image/gif" },
      ],
    })
    const result = ctrl("images.modernformat").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/fallback/i)
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

  it("matches LCP image loosely by filename despite CDN/query variance", () => {
    const e = makeEvidence({
      rawHtml: '<html><head><link rel="preload" as="image" href="/cdn/x/hero.jpg?w=800" fetchpriority="high"></head></html>',
      perf: { lcpElement: { tagName: "IMG", src: "https://img.example.com/hero.jpg" } },
    })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("preloads the LCP image")
  })

  it("fails when a high-priority image preload does NOT match the known LCP image", () => {
    const e = makeEvidence({
      rawHtml: '<html><head><link rel="preload" as="image" href="banner.jpg" fetchpriority="high"></head></html>',
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg" } },
    })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/none match/i)
  })

  it("is « à confirmer » (unknown, not passed) when preloads exist but the LCP src is unknown", () => {
    const e = makeEvidence({
      rawHtml: '<html><head><link rel="preload" as="image" href="hero.jpg" fetchpriority="high"></head></html>',
      perf: { lcpElement: { tagName: "IMG" } }, // no src
    })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.unknown).toBe(true)
    expect(result.evidence).toMatch(/À confirmer/i)
  })

  it("does NOT flag unknown when the LCP is known (measurable case)", () => {
    const e = makeEvidence({
      rawHtml: '<html><head><link rel="preload" as="image" href="hero.jpg" fetchpriority="high"></head></html>',
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg" } },
    })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.unknown).toBeUndefined()
  })

  it("stays a plain failure (no unknown) when there is no image preload at all", () => {
    const e = makeEvidence({
      rawHtml: "<html><head></head><body></body></html>",
      perf: { lcpElement: { tagName: "IMG" } }, // no src either
    })
    const result = ctrl("images.lcppreload").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.unknown).toBeUndefined()
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

  it("counts inline CSS width/height (style attribute) as reserved dimensions", () => {
    const e = makeEvidence({
      rawHtml: [
        '<img src="a.jpg" style="width:400px;height:300px">',
        '<img src="b.jpg" style="width: 200px; height: 150px;">',
        '<img src="c.jpg" width="100" height="80">',
        '<img src="d.jpg">',
      ].join(""),
    })
    const result = ctrl("images.fixedheight").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("3/4")
  })

  it("counts inline aspect-ratio CSS (with colon) as reserved dimensions", () => {
    const e = makeEvidence({
      rawHtml: [
        '<img src="a.jpg" style="aspect-ratio: 16 / 9">',
        '<img src="b.jpg" style="aspect-ratio:1/1">',
        '<img src="c.jpg" width="100" height="80">',
        '<img src="d.jpg">',
      ].join(""),
    })
    const result = ctrl("images.fixedheight").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("3/4")
  })

  it("passes on CLS < 0.01 even when no img has explicit dimensions", () => {
    const e = makeEvidence({
      rawHtml: ['<img src="a.jpg">', '<img src="b.jpg">'].join(""),
      perf: { cls: 0.005 },
    })
    const result = ctrl("images.fixedheight").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/CLS = 0\.005 \(< 0\.01\)/)
  })

  it("falls back to the width/height check when CLS ≥ 0.01", () => {
    const e = makeEvidence({
      rawHtml: ['<img src="a.jpg">', '<img src="b.jpg">'].join(""),
      perf: { cls: 0.03 },
    })
    const result = ctrl("images.fixedheight").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("CLS = 0.03 (≥ 0.01)")
    expect(result.evidence).toContain("0/2")
  })

  it("does NOT count a class name merely containing the substring aspect-ratio", () => {
    const e = makeEvidence({
      rawHtml: [
        '<img src="a.jpg" class="aspect-ratio-container">',
        '<img src="b.jpg">',
      ].join(""),
    })
    const result = ctrl("images.fixedheight").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("0/2")
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

  it("is « à confirmer » (unknown) when no LCP element is identified", () => {
    const e = makeEvidence({ perf: { lcpElement: null } })
    const result = ctrl("images.lcpnotlazy").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.unknown).toBe(true)
    expect(result.evidence).toMatch(/À confirmer/i)
  })

  it("does NOT flag unknown when the LCP is identified (measurable case)", () => {
    const e = makeEvidence({
      perf: { lcpElement: { tagName: "IMG", src: "hero.jpg", loadingAttr: "lazy" } },
    })
    expect(ctrl("images.lcpnotlazy").evaluate(e).unknown).toBeUndefined()
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

  // Art-direction via <picture>: the responsive candidates live on <source>, the
  // <img> carries only the mobile fallback src. The parser resolves it without JS.
  it("passes on a <picture> whose art-direction lives on <source srcset>", () => {
    const e = makeEvidence({
      rawHtml: `<picture>
        <source srcset="/styles/hero_d/public/media/image/717a17.png?itok=i3pOZOe4 1x" media="(min-width: 1024px)" type="image/png" width="2477" height="1400">
        <img loading="eager" fetchpriority="high" width="700" height="1260" src="/styles/hero_m/public/media/image/717a17.png?itok=qkhEDj4t" alt="">
      </picture>`,
    })
    const result = ctrl("images.responsive").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("<picture><source>")
  })

  it("does not count a <video><source src> as responsive", () => {
    const e = makeEvidence({
      rawHtml: '<video poster="p.jpg"><source src="clip.mp4" type="video/mp4"></video><img src="a.jpg">',
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

  it("is « à confirmer » (unknown) when all image responses are cached (0 bytes)", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.webp", resourceType: "image", status: 200, fromCache: true, encodedBytes: 0, decodedBytes: 80000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
        { url: "b.webp", resourceType: "image", status: 200, fromCache: true, encodedBytes: 0, decodedBytes: 90000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
      ],
    })
    const result = ctrl("images.compressed").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.unknown).toBe(true)
    expect(result.evidence).toMatch(/À confirmer/i)
  })

  it("does NOT flag unknown when at least one transfer size is observed", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.webp", resourceType: "image", status: 200, fromCache: false, encodedBytes: 50000, decodedBytes: 80000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
      ],
    })
    expect(ctrl("images.compressed").evaluate(e).unknown).toBeUndefined()
  })

  it("ignores cached 0-byte images and still fails on a heavy transferred image", () => {
    const e = makeEvidence({
      requests: [
        { url: "cached.webp", resourceType: "image", status: 200, fromCache: true, encodedBytes: 0, decodedBytes: 80000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/webp" },
        { url: "heavy.jpg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 512000, decodedBytes: 800000, requestHeaders: {}, responseHeaders: {}, mimeType: "image/jpeg" },
      ],
    })
    const result = ctrl("images.compressed").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("500 KB")
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

  it("passes when only a 103 Early Hints response has the image preload", () => {
    const e = makeEvidence({
      earlyHints: { link: "</hero.avif>; rel=preload; as=image" },
    })
    const result = ctrl("images.earlyhint").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("Early Hints")
  })

  it("fails when no Link header present", () => {
    const e = makeEvidence({ mainResponseHeaders: {} })
    const result = ctrl("images.earlyhint").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no link/i)
  })

  it("splits directives correctly when a URL contains a comma", () => {
    const e = makeEvidence({
      mainResponseHeaders: {
        link: '</img/w_800,h_600/hero.avif>; rel=preload; as=image, </style.css>; rel=preload; as=style',
      },
    })
    const result = ctrl("images.earlyhint").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("hero.avif")
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
