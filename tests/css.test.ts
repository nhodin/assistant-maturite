/**
 * Tests for Topic 7 — CSS management
 * Controls: css.noextcss(30), css.order(25), css.nosvgfonts(20),
 *           css.criticalinline(10), css.preload(10), css.unused(5)
 */
import { describe, it, expect } from "vitest"
import { cssTopic } from "../src/topics/css"
import { makeEvidence } from "../src/core/fixture"

function ctrl(id: string) {
  const c = cssTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

describe("cssTopic metadata", () => {
  it("id + points", () => {
    expect(cssTopic.id).toBe(7)
    expect(cssTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })
})

describe("css.noextcss", () => {
  it("PASS — only first-party CSS in head", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<head><link rel="stylesheet" href="/styles/app.css"></head>`,
    })
    expect(ctrl("css.noextcss").evaluate(e).passed).toBe(true)
  })
  it("FAIL — third-party CSS in head", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<head><link rel="stylesheet" href="https://cdn.other.com/a.css"></head>`,
    })
    expect(ctrl("css.noextcss").evaluate(e).passed).toBe(false)
  })
})

describe("css.order", () => {
  it("PASS — stylesheet after viewport, before script", () => {
    const e = makeEvidence({
      head: {
        order: ["meta[charset]", "meta[viewport]", "title", "link[stylesheet]", "script"],
        tags: [],
      },
    })
    expect(ctrl("css.order").evaluate(e).passed).toBe(true)
  })
  it("FAIL — stylesheet before viewport", () => {
    const e = makeEvidence({
      head: { order: ["link[stylesheet]", "meta[viewport]"], tags: [] },
    })
    expect(ctrl("css.order").evaluate(e).passed).toBe(false)
  })
})

describe("css.nosvgfonts", () => {
  it("PASS — no data URIs in inline or external CSS", () => {
    const e = makeEvidence({
      css: { hasInlinedSvgOrFontDataUri: false, externalStylesheetsParsed: 2 },
    })
    expect(ctrl("css.nosvgfonts").evaluate(e).passed).toBe(true)
  })
  it("FAIL — data:image/svg detected (inline or external stylesheet)", () => {
    const e = makeEvidence({
      css: { hasInlinedSvgOrFontDataUri: true, externalStylesheetsParsed: 1 },
    })
    const result = ctrl("css.nosvgfonts").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("external stylesheet")
  })
})

describe("css.criticalinline", () => {
  it("PASS — large inline style in head", () => {
    const e = makeEvidence({
      rawHtml: `<head><style>${"a{color:red}".repeat(60)}</style></head>`,
    })
    expect(ctrl("css.criticalinline").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no/small inline style", () => {
    const e = makeEvidence({ rawHtml: `<head></head>` })
    expect(ctrl("css.criticalinline").evaluate(e).passed).toBe(false)
  })
  it("FAIL — @import detected (even with enough inline CSS)", () => {
    const e = makeEvidence({
      rawHtml: `<head><style>${"a{color:red}".repeat(60)}</style></head>`,
      css: { hasInlinedSvgOrFontDataUri: false, externalStylesheetsParsed: 1, hasAtImport: true },
    })
    const result = ctrl("css.criticalinline").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("@import")
  })
})

describe("css.preload", () => {
  it("PASS — Link header preload as=style", () => {
    const e = makeEvidence({
      mainResponseHeaders: { link: `<a.css>; rel=preload; as=style` },
    })
    expect(ctrl("css.preload").evaluate(e).passed).toBe(true)
  })
  it("PASS — 103 Early Hints Link header preload as=style", () => {
    const e = makeEvidence({
      earlyHints: { link: `<a.css>; rel=preload; as=style` },
    })
    const result = ctrl("css.preload").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("Early Hints")
  })
  it("FAIL — no Link header", () => {
    expect(ctrl("css.preload").evaluate(makeEvidence()).passed).toBe(false)
  })
})

describe("css.unused", () => {
  it("FAIL — coverage unavailable (null)", () => {
    expect(ctrl("css.unused").evaluate(makeEvidence()).passed).toBe(false)
  })
  it("PASS — unused < 30%", () => {
    const e = makeEvidence({ coverage: { cssUnusedPct: 10, jsUnusedPct: null } })
    expect(ctrl("css.unused").evaluate(e).passed).toBe(true)
  })
  it("FAIL — unused >= 30%", () => {
    const e = makeEvidence({ coverage: { cssUnusedPct: 35, jsUnusedPct: null } })
    expect(ctrl("css.unused").evaluate(e).passed).toBe(false)
  })
})
