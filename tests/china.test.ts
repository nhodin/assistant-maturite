/**
 * Tests for Topic 12 — China Market Access (standalone)
 * Controls: china.nogfwcritical(30), china.cdnchinapop(25), china.nogfwall(20),
 *           china.icp(15), china.cnanalytics(10)
 */
import { describe, it, expect } from "vitest"
import { chinaTopic } from "../src/topics/china"
import { makeEvidence } from "../src/core/fixture"
import type { NetworkRequest } from "../src/core"

function ctrl(id: string) {
  const c = chinaTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

function req(url: string): NetworkRequest {
  return {
    url,
    resourceType: "script",
    status: 200,
    fromCache: false,
    encodedBytes: 1000,
    decodedBytes: 1000,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "application/javascript",
  }
}

describe("chinaTopic metadata", () => {
  it("id/standalone + points", () => {
    expect(chinaTopic.id).toBe(12)
    expect(chinaTopic.standalone).toBe(true)
    expect(chinaTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })
})

describe("china.nogfwcritical", () => {
  it("PASS — clean head", () => {
    const e = makeEvidence({ rawHtml: `<head><script src="/app.js"></script></head>` })
    expect(ctrl("china.nogfwcritical").evaluate(e).passed).toBe(true)
  })
  it("FAIL — synchronous GTM script in head (render-blocking)", () => {
    const e = makeEvidence({
      rawHtml: `<head><script src="https://www.googletagmanager.com/gtm.js"></script></head>`,
    })
    const r = ctrl("china.nogfwcritical").evaluate(e)
    expect(r.passed).toBe(false)
    expect(r.evidence).toContain("www.googletagmanager.com")
  })
  it("PASS — async GTM script in head (not render-blocking) but mentioned in evidence", () => {
    const e = makeEvidence({
      rawHtml: `<head><script async src="https://www.googletagmanager.com/gtm.js"></script></head>`,
    })
    const r = ctrl("china.nogfwcritical").evaluate(e)
    expect(r.passed).toBe(true)
    expect(r.evidence).toContain("non-blocking")
    expect(r.evidence).toContain("www.googletagmanager.com")
  })
  it("PASS — defer / type=module GFW scripts in head", () => {
    const deferred = makeEvidence({
      rawHtml: `<head><script defer src="https://www.google-analytics.com/analytics.js"></script></head>`,
    })
    expect(ctrl("china.nogfwcritical").evaluate(deferred).passed).toBe(true)
    const mod = makeEvidence({
      rawHtml: `<head><script type="module" src="https://www.googletagmanager.com/gtm.js"></script></head>`,
    })
    expect(ctrl("china.nogfwcritical").evaluate(mod).passed).toBe(true)
  })
  it("FAIL — a sync GFW script still fails even alongside an async one", () => {
    const e = makeEvidence({
      rawHtml: `<head><script async src="https://www.googletagmanager.com/gtm.js"></script><script src="https://ajax.googleapis.com/lib.js"></script></head>`,
    })
    const r = ctrl("china.nogfwcritical").evaluate(e)
    expect(r.passed).toBe(false)
    expect(r.evidence).toContain("ajax.googleapis.com")
    expect(r.evidence).toContain("non-blocking")
  })
  it("FAIL — @import of fonts.googleapis.com in inline <style>", () => {
    const e = makeEvidence({
      rawHtml: `<head><style>@import url(https://fonts.googleapis.com/css?family=Roboto);</style></head>`,
    })
    const r = ctrl("china.nogfwcritical").evaluate(e)
    expect(r.passed).toBe(false)
    expect(r.evidence).toContain("fonts.googleapis.com")
  })
  it("FAIL — url() of fonts.gstatic.com in inline <style>", () => {
    const e = makeEvidence({
      rawHtml: `<head><style>@font-face{src:url('https://fonts.gstatic.com/s/roboto.woff2')}</style></head>`,
    })
    expect(ctrl("china.nogfwcritical").evaluate(e).passed).toBe(false)
  })
  it("FAIL — Link header preload of a gstatic URL", () => {
    const e = makeEvidence({
      rawHtml: `<head></head>`,
      mainResponseHeaders: {
        link: "<https://fonts.gstatic.com/s/roboto.woff2>; rel=preload; as=font",
      },
    })
    const r = ctrl("china.nogfwcritical").evaluate(e)
    expect(r.passed).toBe(false)
    expect(r.evidence).toContain("fonts.gstatic.com")
  })
  it("PASS — clean inline <style> + first-party Link preload", () => {
    const e = makeEvidence({
      rawHtml: `<head><style>@font-face{src:url('/fonts/local.woff2')}</style></head>`,
      mainResponseHeaders: {
        link: "</app.css>; rel=preload; as=style",
      },
    })
    expect(ctrl("china.nogfwcritical").evaluate(e).passed).toBe(true)
  })
})

describe("china.cdnchinapop", () => {
  it("PASS — Tencent CDN header", () => {
    const e = makeEvidence({ mainResponseHeaders: { "x-nws-log-uuid": "abc" } })
    expect(ctrl("china.cdnchinapop").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no CN CDN signal", () => {
    expect(ctrl("china.cdnchinapop").evaluate(makeEvidence()).passed).toBe(false)
  })
})
