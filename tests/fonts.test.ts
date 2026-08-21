/**
 * Tests for Topic 9 — Fonts management
 * Controls: fonts.selfhost(30), fonts.fallback(20), fonts.woff2(10),
 *           fonts.fontdisplay(10), fonts.noiconfonts(10), fonts.max2(10), fonts.subsetting(10)
 */
import { describe, it, expect } from "vitest"
import { fontsTopic } from "../src/topics/fonts"
import { makeEvidence } from "../src/core/fixture"
import type { NetworkRequest } from "../src/core"

function ctrl(id: string) {
  const c = fontsTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

function fontReq(url: string): NetworkRequest {
  return {
    url,
    resourceType: "font",
    status: 200,
    fromCache: false,
    encodedBytes: 10_000,
    decodedBytes: 10_000,
    requestHeaders: {},
    responseHeaders: {},
    // Derive a realistic mime from the extension so woff vs woff2 differs.
    mimeType: /\.woff2(\?|$)/i.test(url) ? "font/woff2" : "font/woff",
  }
}

describe("fontsTopic metadata", () => {
  it("id + points", () => {
    expect(fontsTopic.id).toBe(9)
    expect(fontsTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })
})

describe("fonts.selfhost", () => {
  it("PASS — first-party font requests", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [fontReq("https://example.com/fonts/a.woff2")],
    })
    expect(ctrl("fonts.selfhost").evaluate(e).passed).toBe(true)
  })
  it("PASS — no web fonts loaded", () => {
    expect(ctrl("fonts.selfhost").evaluate(makeEvidence()).passed).toBe(true)
  })
  it("FAIL — third-party Google Fonts", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [fontReq("https://fonts.gstatic.com/s/a.woff2")],
    })
    expect(ctrl("fonts.selfhost").evaluate(e).passed).toBe(false)
  })
})

describe("fonts.woff2", () => {
  it("PASS — woff2 requests", () => {
    const e = makeEvidence({ requests: [fontReq("https://example.com/a.woff2")] })
    expect(ctrl("fonts.woff2").evaluate(e).passed).toBe(true)
  })
  it("FAIL — legacy woff", () => {
    const e = makeEvidence({ requests: [fontReq("https://example.com/a.woff")] })
    expect(ctrl("fonts.woff2").evaluate(e).passed).toBe(false)
  })
})

describe("fonts.fontdisplay", () => {
  it("PASS — all inline @font-face swap", () => {
    const e = makeEvidence({ fonts: [{ family: "A", fontDisplay: "swap" }] })
    expect(ctrl("fonts.fontdisplay").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no @font-face captured (inline or external)", () => {
    expect(ctrl("fonts.fontdisplay").evaluate(makeEvidence()).passed).toBe(false)
  })
  it("PASS — @font-face sourced from an external stylesheet", () => {
    // e.fonts combines inline <style> and fetched external stylesheet @font-face
    // rules — the fixture doesn't distinguish the source, only the parsed result.
    const e = makeEvidence({ fonts: [{ family: "A", fontDisplay: "optional" }] })
    expect(ctrl("fonts.fontdisplay").evaluate(e).passed).toBe(true)
  })
  it("PASS — local()-only fallback without font-display is ignored", () => {
    const e = makeEvidence({
      fonts: [
        { family: "A", fontDisplay: "swap", src: 'url("/a.woff2") format("woff2")' },
        { family: "A Fallback", src: 'local("Arial")' },
      ],
    })
    const res = ctrl("fonts.fontdisplay").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/1 local\(\)-only fallback/)
  })
  it("FAIL — downloaded @font-face without font-display, alongside a fallback", () => {
    const e = makeEvidence({
      fonts: [
        { family: "A", src: 'url("/a.woff2") format("woff2")' },
        { family: "A Fallback", src: 'local("Arial")' },
      ],
    })
    expect(ctrl("fonts.fontdisplay").evaluate(e).passed).toBe(false)
  })
})

describe("fonts.noiconfonts", () => {
  it("PASS — no icon font", () => {
    expect(ctrl("fonts.noiconfonts").evaluate(makeEvidence()).passed).toBe(true)
  })
  it("FAIL — FontAwesome referenced", () => {
    const e = makeEvidence({ rawHtml: `<link href="/fontawesome.css">` })
    expect(ctrl("fonts.noiconfonts").evaluate(e).passed).toBe(false)
  })
})

describe("fonts.max2", () => {
  it("PASS — 2 families", () => {
    const e = makeEvidence({ fonts: [{ family: "A" }, { family: "B" }] })
    expect(ctrl("fonts.max2").evaluate(e).passed).toBe(true)
  })
  it("FAIL — 3 families", () => {
    const e = makeEvidence({ fonts: [{ family: "A" }, { family: "B" }, { family: "C" }] })
    expect(ctrl("fonts.max2").evaluate(e).passed).toBe(false)
  })
  it("PASS — same font as @font-face family AND request stem counts once", () => {
    // "Louis Vuitton Web" family + louisvuittonweb-regular.woff2 stem must not
    // be counted as 2 distinct families. Two real families → still passes at 2.
    const e = makeEvidence({
      fonts: [{ family: "Louis Vuitton Web" }, { family: "LV Serif" }],
      requests: [
        fontReq("https://example.com/fonts/louisvuittonweb-regular.woff2"),
        fontReq("https://example.com/fonts/lvserif-bold.woff2"),
      ],
    })
    const res = ctrl("fonts.max2").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/@font-face families/)
  })
  it("FAIL — 3 @font-face families even with matching request stems", () => {
    const e = makeEvidence({
      fonts: [{ family: "A" }, { family: "B" }, { family: "C" }],
      requests: [
        fontReq("https://example.com/a-regular.woff2"),
        fontReq("https://example.com/b-regular.woff2"),
        fontReq("https://example.com/c-regular.woff2"),
      ],
    })
    expect(ctrl("fonts.max2").evaluate(e).passed).toBe(false)
  })
  it("PASS — local()-only fallback @font-face is not counted", () => {
    // "Louis Vuitton Web Fallback" with src: local("Arial") is an adjusted
    // system fallback, not a downloaded family → 2 real families, passes.
    const e = makeEvidence({
      fonts: [
        { family: "Louis Vuitton Web", src: 'url("/f/lvweb.woff2") format("woff2")' },
        { family: "LV Serif", src: 'url("/f/lvserif.woff2") format("woff2")' },
        { family: "Louis Vuitton Web Fallback", src: 'local("Arial")' },
      ],
    })
    const res = ctrl("fonts.max2").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/1 local\(\)-only fallback/)
  })
  it("counts a family whose src mixes local() and url()", () => {
    const e = makeEvidence({
      fonts: [
        { family: "A", src: 'local("A"), url("/a.woff2") format("woff2")' },
        { family: "B", src: 'url("/b.woff2")' },
        { family: "C", src: 'url("/c.woff2")' },
      ],
    })
    expect(ctrl("fonts.max2").evaluate(e).passed).toBe(false)
  })
  it("PASS — falls back to URL stems when no @font-face family captured", () => {
    // Multi-token weight/style stems collapse: foo-bold-italic + foo-regular
    // are one family; bar-700 is a second. → 2 families, passes.
    const e = makeEvidence({
      requests: [
        fontReq("https://example.com/foo-bold-italic.woff2"),
        fontReq("https://example.com/foo-regular.woff2"),
        fontReq("https://example.com/bar-700.woff2"),
      ],
    })
    const res = ctrl("fonts.max2").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/URL stems/)
  })
})

describe("fonts.fallback", () => {
  it("PASS — size-adjust present on @font-face", () => {
    const e = makeEvidence({ fonts: [{ family: "A", sizeAdjust: "105%" }] })
    expect(ctrl("fonts.fallback").evaluate(e).passed).toBe(true)
  })
  it("PASS — ascent-override only (external CSS metric)", () => {
    const e = makeEvidence({ fonts: [{ family: "A", ascentOverride: "90%" }] })
    expect(ctrl("fonts.fallback").evaluate(e).passed).toBe(true)
  })
  it("PASS — local() fallback source only, no size settings", () => {
    const e = makeEvidence({
      fonts: [{ family: "A", src: 'local("Arial"), url(/a.woff2) format("woff2")' }],
    })
    const res = ctrl("fonts.fallback").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/local/)
  })
  it("FAIL — no fallback metrics", () => {
    expect(ctrl("fonts.fallback").evaluate(makeEvidence()).passed).toBe(false)
  })
})

describe("fonts.subsetting", () => {
  it("PASS — unicode-range present", () => {
    const e = makeEvidence({ fonts: [{ family: "A", unicodeRange: "U+0000-00FF" }] })
    expect(ctrl("fonts.subsetting").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no subsetting", () => {
    expect(ctrl("fonts.subsetting").evaluate(makeEvidence()).passed).toBe(false)
  })
  it("PASS — delimited locale/subset token in URL (latin-ext)", () => {
    const e = makeEvidence({
      requests: [
        fontReq("https://example.com/noto-latin-ext.woff2"),
        fontReq("https://example.com/noto-cyrillic.woff2"),
      ],
    })
    expect(ctrl("fonts.subsetting").evaluate(e).passed).toBe(true)
  })
  it("FAIL — 'ext' substring in filename must not match (next.woff2)", () => {
    const e = makeEvidence({
      requests: [
        fontReq("https://example.com/next.woff2"),
        fontReq("https://example.com/text-icons.woff2"),
      ],
    })
    expect(ctrl("fonts.subsetting").evaluate(e).passed).toBe(false)
  })
})
