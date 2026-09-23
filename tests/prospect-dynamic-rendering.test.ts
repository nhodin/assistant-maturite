/**
 * Dynamic rendering — SSR served to crawlers only (prerender.io, Rendertron, a
 * CDN prerender layer). See docs/DIAGNOSTIC.md.
 *
 * Regression: the content-based signal used to REQUIRE a hydration-payload marker
 * (`__NEXT_DATA__`, `__NUXT__`…), which silently restricted it to Next/Nuxt/Remix/
 * Gatsby. Travis Perkins serves 0 words to a visitor and 3013 to a crawler —
 * textbook prerendering — and went undetected because it ships no such marker.
 * The asymmetry itself is now the signal; the marker corroborates it.
 */
import { describe, it, expect } from "vitest"
import { detectDynamicRendering } from "../src/prospect/detect"
import { makeEvidence } from "../src/core/fixture"

const RENDERED = `<html><body><h1>Staifix insulation retaining clips</h1>` +
  `<p>${"Wall and frame ties for insulation retaining, pack of 20, galvanised steel. ".repeat(20)}</p>` +
  `<img src="/p/clip.jpg"></body></html>`

/** A visitor gets the shell: no content, no framework marker at all. */
const USER_SHELL = `<html><head><title>Travis Perkins</title></head><body><div id="app"></div>` +
  `<script src="/static/app.js"></script></body></html>`

const bot = (html: string, over: Record<string, unknown> = {}) => ({
  userAgent: "Googlebot", status: 200, html, htmlBytes: html.length,
  responseHeaders: {}, blocked: false, ...over,
})

describe("detectDynamicRendering", () => {
  it("detects it from the user/crawler asymmetry alone, with no hydration marker", () => {
    const r = detectDynamicRendering(makeEvidence({
      rawHtml: USER_SHELL, renderedHtml: RENDERED, bot: bot(RENDERED),
    }))
    expect(r.detected).toBe(true)
    expect(r.evidence).toMatch(/crawler mais pas au visiteur/)
    expect(r.evidence).toMatch(/mots côté crawler/)
  })

  it("names the hydration marker as corroboration when there is one", () => {
    const userWithMarker = USER_SHELL.replace("<script", '<script>window.__NEXT_DATA__={}</script><script')
    const r = detectDynamicRendering(makeEvidence({
      rawHtml: userWithMarker, renderedHtml: RENDERED, bot: bot(RENDERED),
    }))
    expect(r.detected).toBe(true)
    expect(r.evidence).toMatch(/__NEXT_DATA__/)
  })

  it("still detects it from a prerender response header", () => {
    const r = detectDynamicRendering(makeEvidence({
      rawHtml: USER_SHELL, renderedHtml: RENDERED,
      bot: bot(USER_SHELL, { responseHeaders: { "x-prerender-requestid": "abc123" } }),
    }))
    expect(r.detected).toBe(true)
    expect(r.evidence).toMatch(/x-prerender-requestid/)
  })

  it("does not fire when both sides are server-rendered", () => {
    const r = detectDynamicRendering(makeEvidence({
      rawHtml: RENDERED, renderedHtml: RENDERED, bot: bot(RENDERED),
    }))
    expect(r.detected).toBe(false)
  })

  it("does not fire when neither side has content", () => {
    const r = detectDynamicRendering(makeEvidence({
      rawHtml: USER_SHELL, renderedHtml: RENDERED, bot: bot(USER_SHELL),
    }))
    expect(r.detected).toBe(false)
  })

  it("does not fire when the crawler fetch was blocked", () => {
    const r = detectDynamicRendering(makeEvidence({
      rawHtml: USER_SHELL, renderedHtml: RENDERED,
      bot: bot(RENDERED, { blocked: true, blockReason: "réponse HTTP 403" }),
    }))
    expect(r.detected).toBe(false)
  })

  it("does not mistake a BLOCKED VISITOR document for prerendering", () => {
    // Same shape as real dynamic rendering — empty for the visitor, full for the
    // crawler — but the cause is our own fetch being refused, not the site's
    // architecture. Claiming "dynamic rendering" here would be a confident lie.
    const datadome = `<html><head><title>kiabi.com</title></head><body>` +
      `<p id="cmsg">Please enable JS and disable any ad blocker</p>` +
      `<script src="https://ct.captcha-delivery.com/i.js"></script></body></html>`
    const r = detectDynamicRendering(makeEvidence({
      rawHtml: datadome, renderedHtml: RENDERED, bot: bot(RENDERED),
    }))
    expect(r.detected).toBe(false)
  })
})
