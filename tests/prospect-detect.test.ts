/**
 * Tests for the prospect diagnostic's SSR detection.
 * Spec: docs/DIAGNOSTIC.md — "Détection du SSR".
 */
import { describe, it, expect } from "vitest"
import { makeEvidence } from "../src/core/fixture"
import { ssrUserCheck, ssrBotCheck, detectDynamicRendering, detectVigilanceFlags } from "../src/prospect/checks"
import { SSR_MIN_WORDS } from "../src/prospect/detect"

/** SSR_MIN_WORDS words of visible text, identical between raw and rendered HTML. */
function longParagraph(words = SSR_MIN_WORDS + 20): string {
  return Array.from({ length: words }, (_, i) => `mot${i}`).join(" ")
}

function ssrPage(): string {
  return (
    `<!doctype html><html><head><title>Chaussures homme — Boutique</title>` +
    `<meta property="og:title" content="Chaussures homme"></head>` +
    `<body><h1>Nos chaussures homme</h1><p>${longParagraph()}</p>` +
    `<img src="/img/shoe.jpg" width="400" height="300"></body></html>`
  )
}

/** A "well-balised" SPA shell: rich <head>, real content only in the rendered DOM. */
function spaShell(): string {
  return `<!doctype html><html><head><title>My App</title></head><body><div id="root"></div></body></html>`
}

function spaRendered(): string {
  return (
    `<!doctype html><html><head><title>My App</title></head>` +
    `<body><div id="root"><h1>Nos chaussures homme</h1><p>${longParagraph()}</p>` +
    `<img src="/img/shoe.jpg"></div></body></html>`
  )
}

describe("ssrUserCheck", () => {
  it("PASS — a real SSR page (overlap + anchor + image all present)", () => {
    const html = ssrPage()
    const e = makeEvidence({ rawHtml: html, renderedHtml: html })
    const result = ssrUserCheck(e)
    expect(result.id).toBe("ssr.user")
    expect(result.passed).toBe(true)
    expect(result.unknown).toBeUndefined()
    expect(result.evidence).toMatch(/recouvrement du texte/)
  })

  it("FAIL — shell-only SPA: rich head, empty body (must never pass on head alone)", () => {
    const e = makeEvidence({ rawHtml: spaShell(), renderedHtml: spaRendered() })
    const result = ssrUserCheck(e)
    expect(result.passed).toBe(false)
    // Anchor and image criteria alone (title exists in the shell) must not carry it.
    expect(result.evidence).toMatch(/insuffisant/)
  })

  it("FAIL — body text present but no semantic anchor and no image", () => {
    const body = `<body><p>${longParagraph()}</p></body>`
    const html = `<!doctype html><html><head></head>${body}</html>`
    const e = makeEvidence({ rawHtml: html, renderedHtml: html })
    const result = ssrUserCheck(e)
    expect(result.passed).toBe(false)
  })

  it("FAIL — anchor and image present but not enough text overlap (SPA case guard)", () => {
    // Head carries a real anchor AND an image sits right in the raw body, but the
    // raw body text itself is far short of SSR_MIN_WORDS / mostly absent from the
    // rendered DOM — criteria 2+3 alone must not be enough.
    const raw = `<!doctype html><html><head><title>Vraie Marque</title></head><body><h1>Vraie Marque</h1><img src="/img/shoe.jpg"></body></html>`
    const rendered = `<!doctype html><html><head><title>Vraie Marque</title></head><body><h1>Vraie Marque</h1><p>${longParagraph()}</p><img src="/img/shoe.jpg"></body></html>`
    const e = makeEvidence({ rawHtml: raw, renderedHtml: rendered })
    const result = ssrUserCheck(e)
    expect(result.passed).toBe(false)
  })

  it("FAIL — image only via data-src (needs JS) does not count", () => {
    const html =
      `<!doctype html><html><head><title>Vraie Marque</title></head>` +
      `<body><h1>Vraie Marque</h1><p>${longParagraph()}</p><img data-src="/img/shoe.jpg"></body></html>`
    const e = makeEvidence({ rawHtml: html, renderedHtml: html })
    expect(ssrUserCheck(e).passed).toBe(false)
  })

  it("FAIL — base64 placeholder src does not count as a real image", () => {
    const html =
      `<!doctype html><html><head><title>Vraie Marque</title></head>` +
      `<body><h1>Vraie Marque</h1><p>${longParagraph()}</p><img src="data:image/gif;base64,R0lGOD"></body></html>`
    const e = makeEvidence({ rawHtml: html, renderedHtml: html })
    expect(ssrUserCheck(e).passed).toBe(false)
  })

  it("PASS — srcset alone counts as a real image", () => {
    const html =
      `<!doctype html><html><head><title>Vraie Marque</title></head>` +
      `<body><h1>Vraie Marque</h1><p>${longParagraph()}</p><img srcset="/img/shoe.jpg 1x"></body></html>`
    const e = makeEvidence({ rawHtml: html, renderedHtml: html })
    expect(ssrUserCheck(e).passed).toBe(true)
  })

  it("PASS — JSON-LD entity counts as a semantic anchor (no h1/title needed)", () => {
    const html =
      `<!doctype html><html><head><title>App</title>` +
      `<script type="application/ld+json">{"@type":"Product","name":"Chaussure"}</script></head>` +
      `<body><p>${longParagraph()}</p><img src="/img/shoe.jpg"></body></html>`
    const e = makeEvidence({ rawHtml: html, renderedHtml: html })
    const result = ssrUserCheck(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/JSON-LD/)
  })

  it("HTML comments are ignored by detection", () => {
    const html =
      `<!doctype html><html><head><title>App</title></head>` +
      `<body><!-- <h1>Fake</h1> --><p>${longParagraph()}</p><!-- <img src="/x.jpg"> --></body></html>`
    const e = makeEvidence({ rawHtml: html, renderedHtml: html })
    // Text overlap passes but neither anchor nor image is real (both commented out).
    expect(ssrUserCheck(e).passed).toBe(false)
  })
})

describe("ssrBotCheck", () => {
  it("unknown — no bot fetch in this capture", () => {
    const e = makeEvidence({ rawHtml: ssrPage(), renderedHtml: ssrPage() })
    const result = ssrBotCheck(e)
    expect(result.passed).toBe(false)
    expect(result.unknown).toBe(true)
    expect(result.evidence).toMatch(/aucune capture crawler/)
  })

  it("unknown, never false — bot fetch blocked by a WAF", () => {
    const e = makeEvidence({
      rawHtml: ssrPage(),
      renderedHtml: ssrPage(),
      bot: {
        userAgent: "Googlebot",
        status: 403,
        html: "",
        htmlBytes: 0,
        responseHeaders: {},
        blocked: true,
        blockReason: "challenge Akamai",
      },
    })
    const result = ssrBotCheck(e)
    expect(result.passed).toBe(false)
    expect(result.unknown).toBe(true)
    expect(result.evidence).toMatch(/challenge Akamai/)
  })

  it("PASS — bot html measured like the user html", () => {
    const html = ssrPage()
    const e = makeEvidence({
      rawHtml: spaShell(),
      renderedHtml: html,
      bot: {
        userAgent: "Googlebot",
        status: 200,
        html,
        htmlBytes: html.length,
        responseHeaders: {},
        blocked: false,
      },
    })
    const result = ssrBotCheck(e)
    expect(result.id).toBe("ssr.bot")
    expect(result.passed).toBe(true)
  })

  it("FAIL — bot served the same empty shell as the user", () => {
    const e = makeEvidence({
      rawHtml: spaShell(),
      renderedHtml: spaRendered(),
      bot: {
        userAgent: "Googlebot",
        status: 200,
        html: spaShell(),
        htmlBytes: spaShell().length,
        responseHeaders: {},
        blocked: false,
      },
    })
    expect(ssrBotCheck(e).passed).toBe(false)
  })
})

describe("detectDynamicRendering", () => {
  it("not detected — no bot fetch", () => {
    const e = makeEvidence({ rawHtml: ssrPage(), renderedHtml: ssrPage() })
    expect(detectDynamicRendering(e).detected).toBe(false)
  })

  it("detected — x-prerender* header on the bot response", () => {
    const e = makeEvidence({
      rawHtml: spaShell(),
      renderedHtml: spaRendered(),
      bot: {
        userAgent: "Googlebot",
        status: 200,
        html: ssrPage(),
        htmlBytes: 10,
        responseHeaders: { "x-prerender-status-code": "200" },
        blocked: false,
      },
    })
    const result = detectDynamicRendering(e)
    expect(result.detected).toBe(true)
    expect(result.evidence).toMatch(/x-prerender/)
  })

  it("detected — via header names a prerender service", () => {
    const e = makeEvidence({
      rawHtml: spaShell(),
      renderedHtml: spaRendered(),
      bot: {
        userAgent: "Googlebot",
        status: 200,
        html: ssrPage(),
        htmlBytes: 10,
        responseHeaders: { via: "1.1 prerender" },
        blocked: false,
      },
    })
    const result = detectDynamicRendering(e)
    expect(result.detected).toBe(true)
    expect(result.evidence).toMatch(/prerender/)
  })

  it("detected — meta fragment on the bot HTML", () => {
    const e = makeEvidence({
      rawHtml: spaShell(),
      renderedHtml: spaRendered(),
      bot: {
        userAgent: "Googlebot",
        status: 200,
        html: `<html><head><meta name="fragment" content="!"></head><body></body></html>`,
        htmlBytes: 10,
        responseHeaders: {},
        blocked: false,
      },
    })
    expect(detectDynamicRendering(e).detected).toBe(true)
  })

  it("detected — ?_escaped_fragment_ in the URL", () => {
    const e = makeEvidence({
      url: "https://example.com/?_escaped_fragment_=/page",
      finalUrl: "https://example.com/?_escaped_fragment_=/page",
      rawHtml: spaShell(),
      renderedHtml: spaRendered(),
      bot: {
        userAgent: "Googlebot",
        status: 200,
        html: ssrPage(),
        htmlBytes: 10,
        responseHeaders: {},
        blocked: false,
      },
    })
    expect(detectDynamicRendering(e).detected).toBe(true)
  })

  it("detected — bot HTML has full content, user has hydration payload, bot has none and no app scripts", () => {
    const userRendered = `<html><body><script>window.__NEXT_DATA__={}</script>${spaRendered()}</body></html>`
    const e = makeEvidence({
      rawHtml: spaShell(),
      renderedHtml: userRendered,
      bot: {
        userAgent: "Googlebot",
        status: 200,
        html: ssrPage(),
        htmlBytes: 10,
        responseHeaders: {},
        blocked: false,
      },
    })
    const result = detectDynamicRendering(e)
    expect(result.detected).toBe(true)
    expect(result.evidence).toMatch(/__NEXT_DATA__/)
  })

  it("not detected — bot blocked, content-based signal is skipped", () => {
    const userRendered = `<html><body><script>window.__NEXT_DATA__={}</script>${spaRendered()}</body></html>`
    const e = makeEvidence({
      rawHtml: spaShell(),
      renderedHtml: userRendered,
      bot: {
        userAgent: "Googlebot",
        status: 403,
        html: "",
        htmlBytes: 0,
        responseHeaders: {},
        blocked: true,
        blockReason: "challenge",
      },
    })
    expect(detectDynamicRendering(e).detected).toBe(false)
  })
})

describe("detectVigilanceFlags", () => {
  it("flags a strict CSP (nonce, no unsafe-inline)", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "content-security-policy": "script-src 'self' 'nonce-abc123'" },
    })
    const flags = detectVigilanceFlags(e)
    expect(flags.some((f) => f.id === "csp.strict")).toBe(true)
  })

  it("does not flag a CSP that allows unsafe-inline alongside a nonce", () => {
    const e = makeEvidence({
      mainResponseHeaders: {
        "content-security-policy": "script-src 'self' 'nonce-abc123' 'unsafe-inline'",
      },
    })
    const flags = detectVigilanceFlags(e)
    expect(flags.some((f) => f.id === "csp.strict")).toBe(false)
  })

  it("flags Set-Cookie on the HTML response", () => {
    const e = makeEvidence({ mainResponseHeaders: { "set-cookie": "session=abc; Path=/" } })
    const flags = detectVigilanceFlags(e)
    expect(flags.some((f) => f.id === "html.setcookie")).toBe(true)
  })

  it("flags a CDN/anti-bot fingerprint header", () => {
    const e = makeEvidence({ mainResponseHeaders: { "cf-ray": "abcdef-CDG" } })
    const flags = detectVigilanceFlags(e)
    expect(flags.some((f) => f.id === "cdn.frontend")).toBe(true)
  })

  it("flags a registered service worker", () => {
    const e = makeEvidence({ stack: { frameworks: [], signals: [], serviceWorker: true } })
    const flags = detectVigilanceFlags(e)
    expect(flags.some((f) => f.id === "sw.registered")).toBe(true)
  })

  it("no flags on a plain page", () => {
    const e = makeEvidence({})
    expect(detectVigilanceFlags(e)).toEqual([])
  })
})
