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
  it("PASS — @font-face embedded as a data: URI (no request) is self-hosted", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      fonts: [{ family: "A", src: 'url("data:font/woff2;base64,d09GMgAB") format("woff2")' }],
    })
    const res = ctrl("fonts.selfhost").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/data:-URI @font-face/)
  })
  it("FAIL — a single external font fails, data: URI fonts notwithstanding", () => {
    // The criterion fails as soon as ONE font comes from an external domain —
    // embedded data: URI fonts never compensate, they reach no domain at all.
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      fonts: [
        { family: "A", src: 'url("data:font/woff2;base64,d09GMgAB")' },
        { family: "B", src: 'url("data:application/font-woff;base64,d09GRg")' },
      ],
      requests: [fontReq("https://fonts.gstatic.com/s/b.woff2")],
    })
    const res = ctrl("fonts.selfhost").evaluate(e)
    expect(res.passed).toBe(false)
    expect(res.evidence).toContain("fonts.gstatic.com")
  })
  it("FAIL — one external font among several first-party ones", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [
        fontReq("https://example.com/fonts/a.woff2"),
        fontReq("https://example.com/fonts/b.woff2"),
        fontReq("https://use.typekit.net/c.woff2"),
      ],
    })
    const res = ctrl("fonts.selfhost").evaluate(e)
    expect(res.passed).toBe(false)
    expect(res.evidence).toContain("use.typekit.net")
  })
  it("FAIL — external @font-face src even when the font was never requested", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      fonts: [{ family: "A", src: 'url("https://fonts.gstatic.com/s/a.woff2")' }],
    })
    expect(ctrl("fonts.selfhost").evaluate(e).passed).toBe(false)
  })
  it("PASS — relative @font-face src with no font request observed", () => {
    // A relative URL resolves against the page origin → no external domain → pass.
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      fonts: [{ family: "A", src: 'url("/fonts/a.woff2") format("woff2")' }],
    })
    expect(ctrl("fonts.selfhost").evaluate(e).passed).toBe(true)
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
  it("PASS — @font-face fallback: local()-only rule excluded from the ratio", () => {
    const e = makeEvidence({
      fonts: [
        { family: "A", src: 'url("/a.woff2") format("woff2")' },
        { family: "B", src: 'url("/b.woff2") format("woff2")' },
        { family: "A Fallback", src: 'local("Arial")' },
      ],
    })
    const res = ctrl("fonts.woff2").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/2\/2/)
    expect(res.evidence).toMatch(/1 local\(\)-only fallback/)
  })
  it("PASS — @font-face fallback: a majority of woff2 is enough (2/3)", () => {
    const e = makeEvidence({
      fonts: [
        { family: "A", src: 'url("/a.woff2") format("woff2")' },
        { family: "B", src: 'url("/b.woff2") format("woff2")' },
        { family: "C", src: 'url("/c.ttf") format("truetype")' },
      ],
    })
    const res = ctrl("fonts.woff2").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/2\/3/)
  })
  it("FAIL — @font-face fallback: minority of woff2 (1/3)", () => {
    const e = makeEvidence({
      fonts: [
        { family: "A", src: 'url("/a.woff2") format("woff2")' },
        { family: "B", src: 'url("/b.ttf") format("truetype")' },
        { family: "C", src: 'url("/c.ttf") format("truetype")' },
      ],
    })
    expect(ctrl("fonts.woff2").evaluate(e).passed).toBe(false)
  })
  it("PASS — @font-face without format() but a .woff2 URL counts as woff2", () => {
    const e = makeEvidence({ fonts: [{ family: "A", src: 'url("/fonts/a.woff2")' }] })
    const res = ctrl("fonts.woff2").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/1\/1/)
  })
  it("PASS — only local()-only @font-face → WOFF2 not applicable", () => {
    const e = makeEvidence({ fonts: [{ family: "A Fallback", src: 'local("Arial")' }] })
    const res = ctrl("fonts.woff2").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/not applicable/)
  })
})

describe("fonts.fontdisplay", () => {
  it("PASS — all inline @font-face swap", () => {
    const e = makeEvidence({ fonts: [{ family: "A", fontDisplay: "swap" }] })
    expect(ctrl("fonts.fontdisplay").evaluate(e).passed).toBe(true)
  })
  it("PASS — no web font at all (no @font-face, no font request)", () => {
    const res = ctrl("fonts.fontdisplay").evaluate(makeEvidence())
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/No web font loaded/)
  })
  it("FAIL — fonts downloaded but no @font-face captured → not measurable", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [fontReq("https://example.com/fonts/a.woff2")],
    })
    const res = ctrl("fonts.fontdisplay").evaluate(e)
    expect(res.passed).toBe(false)
    // Not measurable → « à confirmer », arbitrated by hand rather than guessed.
    expect(res.unknown).toBe(true)
    expect(res.evidence).toMatch(/not measurable/)
  })
  it("PASS — @font-face sourced from an external stylesheet", () => {
    // e.fonts combines inline <style> and fetched external stylesheet @font-face
    // rules — the fixture doesn't distinguish the source, only the parsed result.
    const e = makeEvidence({ fonts: [{ family: "A", fontDisplay: "optional" }] })
    const res = ctrl("fonts.fontdisplay").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.unknown).toBeUndefined()
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
  it("FAIL — evidence names the offending family and its font-display value", () => {
    const e = makeEvidence({
      fonts: [
        { family: "Good Sans", fontDisplay: "swap", src: 'url("/good.woff2") format("woff2")' },
        { family: "LV Serif", src: 'url("/serif.woff2") format("woff2")' },
        { family: '"LV Sans"', fontDisplay: "auto", src: 'url("/lvsans.woff2") format("woff2")' },
      ],
    })
    const res = ctrl("fonts.fontdisplay").evaluate(e)
    expect(res.passed).toBe(false)
    expect(res.evidence).toContain("LV Serif (font-display: absent)")
    expect(res.evidence).toContain("LV Sans (font-display: auto)")
    expect(res.evidence).not.toContain("Good Sans")
  })
  it("PASS — an icon font without swap/optional is out of scope", () => {
    // font-display: swap on an icon font would flash a fallback letter in place
    // of the glyph — not the recommended value, so icon fonts are excluded here
    // (they are penalized by fonts.noiconfonts instead).
    const e = makeEvidence({
      fonts: [
        { family: "Good Sans", fontDisplay: "swap", src: 'url("/good.woff2") format("woff2")' },
        { family: "FontAwesome", fontDisplay: "block", src: 'url("/fa.woff2") format("woff2")' },
        { family: "Glyphs", src: 'url("/icomoon.woff2") format("woff2")' },
      ],
    })
    const res = ctrl("fonts.fontdisplay").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/2 icon font @font-face ignored/)
    expect(res.evidence).not.toContain("FontAwesome")
  })
  it("PASS — only icon fonts on the page → criterion not applicable", () => {
    const e = makeEvidence({
      fonts: [{ family: "FontAwesome", src: 'url("/fa.woff2") format("woff2")' }],
    })
    expect(ctrl("fonts.fontdisplay").evaluate(e).passed).toBe(true)
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
  it("PASS — 'feather' in editorial copy is not an icon font", () => {
    // Fashion/luxury wording ("feather-light", "ostrich feather") must not be
    // read as an icon-font signature in free text.
    const e = makeEvidence({
      rawHtml: `<h1>Feather-light down jacket</h1><p>Trimmed with ostrich feather.</p>`,
    })
    expect(ctrl("fonts.noiconfonts").evaluate(e).passed).toBe(true)
  })
  it("FAIL — feather-icons font request", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [fontReq("https://example.com/fonts/feather-icons.woff2")],
    })
    const res = ctrl("fonts.noiconfonts").evaluate(e)
    expect(res.passed).toBe(false)
    expect(res.evidence).toContain("feather-icons.woff2")
  })
  it("PASS — ambiguous feather.woff2 font request is no longer flagged", () => {
    // A font file simply named "feather" may well be a real decorative typeface.
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [fontReq("https://example.com/fonts/feather.woff2")],
    })
    expect(ctrl("fonts.noiconfonts").evaluate(e).passed).toBe(true)
  })
  it("FAIL — material-icons class in raw HTML", () => {
    const e = makeEvidence({ rawHtml: `<i class="material-icons">search</i>` })
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
  it("PASS — dedicated local()-only fallback @font-face, no size settings", () => {
    const e = makeEvidence({
      fonts: [
        { family: "A", src: 'url("/a.woff2") format("woff2")' },
        { family: "A Fallback", src: 'local("Arial")' },
      ],
    })
    const res = ctrl("fonts.fallback").evaluate(e)
    expect(res.passed).toBe(true)
    expect(res.evidence).toMatch(/dedicated local\(\)-only fallback/)
  })
  it("FAIL — idiomatic local() + url() src is not a fallback strategy", () => {
    // `src: local("Foo"), url(foo.woff2)` only means "use the installed copy if
    // present" — no adjusted system fallback is declared.
    const e = makeEvidence({
      fonts: [{ family: "Foo", src: 'local("Foo"), url(/foo.woff2) format("woff2")' }],
    })
    expect(ctrl("fonts.fallback").evaluate(e).passed).toBe(false)
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
