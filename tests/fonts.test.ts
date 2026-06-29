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
  it("FAIL — no inline @font-face captured", () => {
    expect(ctrl("fonts.fontdisplay").evaluate(makeEvidence()).passed).toBe(false)
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
})

describe("fonts.fallback", () => {
  it("PASS — size-adjust present on @font-face", () => {
    const e = makeEvidence({ fonts: [{ family: "A", sizeAdjust: "105%" }] })
    expect(ctrl("fonts.fallback").evaluate(e).passed).toBe(true)
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
})
