/**
 * Criterion 3 — images resolvable WITHOUT JS.
 *
 * Regression: g-star.com serves 18 <picture> elements whose images come from
 * <source srcSet> (React's casing) while the inner <img> has no src at all. The
 * browser's source selection needs no JS, yet the page read "0 image sans JS".
 */
import { describe, it, expect } from "vitest"
import { hasRealImage } from "../src/prospect/detect"

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
