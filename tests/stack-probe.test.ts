/**
 * Tests for the JS stack fingerprint (src/collector/stack-probe.ts) — informational
 * only (docs/DIAGNOSTIC.md), never part of the diagnostic verdict.
 */
import { describe, it, expect } from "vitest"
import { detectStack } from "../src/collector/stack-probe"

describe("detectStack — per-framework fingerprints", () => {
  it("detects Next.js from __NEXT_DATA__", () => {
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>`
    const r = detectStack(html, [])
    expect(r.frameworks).toContain("next")
    expect(r.signals.some((s) => s.startsWith("Next.js"))).toBe(true)
  })

  it("detects Next.js from a /_next/ request URL", () => {
    const r = detectStack("<html></html>", ["https://example.com/_next/static/chunk.js"])
    expect(r.frameworks).toContain("next")
  })

  it("detects Nuxt from __NUXT__", () => {
    const html = `<script>window.__NUXT__={}</script>`
    expect(detectStack(html, []).frameworks).toContain("nuxt")
  })

  it("detects Angular from ng-version", () => {
    const html = `<app-root ng-version="17.0.0"></app-root>`
    expect(detectStack(html, []).frameworks).toContain("angular")
  })

  it("detects Angular from _nghost", () => {
    const html = `<div _nghost-abc="">hi</div>`
    expect(detectStack(html, []).frameworks).toContain("angular")
  })

  it("detects React from data-reactroot", () => {
    const html = `<div id="root" data-reactroot="">hi</div>`
    expect(detectStack(html, []).frameworks).toContain("react")
  })

  it("detects React from the DevTools hook window global", () => {
    const r = detectStack("<html></html>", [], ["__REACT_DEVTOOLS_GLOBAL_HOOK__"])
    expect(r.frameworks).toContain("react")
  })

  it("detects React from a __reactContainer$ property name", () => {
    const r = detectStack("<html></html>", [], ["__reactContainer$abc123"])
    expect(r.frameworks).toContain("react")
    expect(r.signals.some((s) => s.includes("__reactContainer$abc123"))).toBe(true)
  })

  it("detects Vue from data-v- scoped attributes", () => {
    const html = `<div data-v-7ba5bd90="">hi</div>`
    expect(detectStack(html, []).frameworks).toContain("vue")
  })

  it("detects Vue from the __vue_app__ window global", () => {
    const r = detectStack("<html></html>", [], ["__vue_app__"])
    expect(r.frameworks).toContain("vue")
  })

  it("detects SvelteKit from __sveltekit", () => {
    expect(detectStack(`<script>window.__sveltekit_xyz = {}</script>`, []).frameworks).toContain(
      "sveltekit",
    )
  })

  it("detects Remix from __remixContext", () => {
    expect(detectStack(`<script>window.__remixContext = {}</script>`, []).frameworks).toContain(
      "remix",
    )
  })

  it("detects Gatsby from ___gatsby", () => {
    expect(detectStack(`<div id="___gatsby"></div>`, []).frameworks).toContain("gatsby")
  })

  it("detects Qwik from q:container", () => {
    expect(detectStack(`<div q:container="paused"></div>`, []).frameworks).toContain("qwik")
  })

  it("detects Astro from astro-island", () => {
    expect(detectStack(`<astro-island></astro-island>`, []).frameworks).toContain("astro")
  })

  it("detects nothing on a plain static page", () => {
    const r = detectStack(`<html><body><h1>Bonjour</h1></body></html>`, [])
    expect(r.frameworks).toEqual([])
    expect(r.signals).toEqual([])
  })
})

describe("detectStack — ordering, most specific first", () => {
  it("orders Next.js before React when both match", () => {
    const html = `<script id="__NEXT_DATA__">{}</script><div data-reactroot="">hi</div>`
    const r = detectStack(html, [])
    expect(r.frameworks).toEqual(["next", "react"])
  })

  it("orders Nuxt before Vue when both match", () => {
    const html = `<script>window.__NUXT__={}</script><div data-v-abc123="">hi</div>`
    const r = detectStack(html, [])
    expect(r.frameworks).toEqual(["nuxt", "vue"])
  })
})

describe("detectStack — service worker", () => {
  it("omits serviceWorker when not provided", () => {
    const r = detectStack("<html></html>", [])
    expect(r.serviceWorker).toBeUndefined()
  })

  it("passes through a registered service worker", () => {
    const r = detectStack("<html></html>", [], [], true)
    expect(r.serviceWorker).toBe(true)
  })

  it("passes through the absence of a service worker", () => {
    const r = detectStack("<html></html>", [], [], false)
    expect(r.serviceWorker).toBe(false)
  })
})

describe("third-party widget noise", () => {
  // chantelle.com was fingerprinted "next + vue" off 310 `data-v-…` occurrences
  // that ALL belonged to Yotpo's reviews widget, injected as <style> blocks. A
  // scoped-CSS selector says some component uses Vue, not that the page does.
  const YOTPO_STYLE =
    `<style type="text/css">.yotpo-reviewer-verified-icon-standalone[data-v-4c2f4803]{display:flex}` +
    `.yotpo-reviewer[data-v-1ac5f7d8]{display:flex}</style>`

  it("does not report Vue for a Next page carrying a Vue widget's scoped CSS", () => {
    const html = `<html><head>${YOTPO_STYLE}</head><body><div id="__next">contenu</div></body></html>`
    const stack = detectStack(html, ["https://chantelle.com/fr/_next/static/media/x.woff2"])
    expect(stack.frameworks).toContain("next")
    expect(stack.frameworks).not.toContain("vue")
  })

  it("still reports Vue when the attribute is on the page's own markup", () => {
    const html = `<html><body><div data-v-4c2f4803 id="app">contenu</div></body></html>`
    expect(detectStack(html, []).frameworks).toContain("vue")
  })

  it("still reports Vue from the window global whatever the markup says", () => {
    expect(detectStack("<html></html>", [], ["__vue_app__"]).frameworks).toContain("vue")
  })
})
