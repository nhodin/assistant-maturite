/**
 * Criterion 3 — images resolvable WITHOUT JS.
 *
 * Regression: g-star.com serves 18 <picture> elements whose images come from
 * <source srcSet> (React's casing) while the inner <img> has no src at all. The
 * browser's source selection needs no JS, yet the page read "0 image sans JS".
 */
import { describe, it, expect } from "vitest"
import { hasRealImage, textOverlap } from "../src/prospect/detect"

const url = "https://media.example.com/i/hero?w=800"

describe("hasRealImage", () => {
  it("counts a plain <img src>", () => {
    expect(hasRealImage(`<img src="${url}">`)).toEqual({ present: true, count: 1 })
  })

  it("counts a <picture> whose image comes only from <source srcSet> (g-star.com)", () => {
    const html = `<picture><source media="(min-width: 1024px)" srcSet="${url} 800w"/>` +
      `<source srcSet="${url} 400w"/><img decoding="async" alt="a pair of jeans" loading="lazy"/></picture>`
    expect(hasRealImage(html)).toEqual({ present: true, count: 1 })
  })

  it("does not count a <picture> twice when its <img> has a src too", () => {
    const html = `<picture><source srcset="${url} 800w"><img src="${url}"></picture>`
    expect(hasRealImage(html).count).toBe(1)
  })

  it("still ignores placeholders that need JS", () => {
    const html = `<img src="data:image/gif;base64,R0lGOD" data-src="${url}">` +
      `<picture><source data-srcset="${url} 800w"><img alt=""></picture>`
    expect(hasRealImage(html)).toEqual({ present: false, count: 0 })
  })
})

describe("CSS backgrounds declared in the served HTML (opodo.fr)", () => {
  it("counts a raster background declared in a <style> block", () => {
    const html = `<html><head><style>.od-container-background { background-image: ` +
      `url(/images/mobile/opodo/backgrounds/uk/Opodo-BG-06.jpg); }</style></head><body><h1>Vols</h1></body></html>`
    expect(hasRealImage(html)).toEqual({ present: true, count: 1, cssBackgrounds: 1 })
  })

  it("counts a style attribute, and a URL used twice once", () => {
    const html = `<div style="background-image:url('https://cdn.example.com/hero.webp?w=1200')"></div>` +
      `<div style='background: url("https://cdn.example.com/hero.webp?w=1200") center'></div>`
    expect(hasRealImage(html).cssBackgrounds).toBe(1)
  })

  it("ignores data: URIs, SVG icons, fonts and external stylesheets", () => {
    const html = `<link rel="stylesheet" href="/site.css"><style>` +
      `.a{background:url(data:image/png;base64,iVBOR)} .b{background:url(/icons/sprite.svg)} ` +
      `@font-face{src:url(/f/brand.woff2)}</style>`
    expect(hasRealImage(html)).toEqual({ present: false, count: 0 })
  })
})

describe("<noscript> text is not served text", () => {
  it("is left out of the word count", () => {
    const fallback = "Veuillez activer JavaScript pour que ce site fonctionne correctement. ".repeat(20)
    const html = `<html><body><noscript><p>${fallback}</p></noscript><div id="root"></div></body></html>`
    expect(textOverlap(html, html).rawWords).toBe(0)
  })
})
