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
  it("FAIL — GTM script in head", () => {
    const e = makeEvidence({
      rawHtml: `<head><script src="https://www.googletagmanager.com/gtm.js"></script></head>`,
    })
    expect(ctrl("china.nogfwcritical").evaluate(e).passed).toBe(false)
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

describe("china.nogfwall", () => {
  it("PASS — no GFW domains across requests", () => {
    const e = makeEvidence({ requests: [req("https://example.com/app.js")] })
    expect(ctrl("china.nogfwall").evaluate(e).passed).toBe(true)
  })
  it("FAIL — googletagmanager request", () => {
    const e = makeEvidence({
      requests: [req("https://www.googletagmanager.com/gtm.js")],
    })
    expect(ctrl("china.nogfwall").evaluate(e).passed).toBe(false)
  })
})

describe("china.icp", () => {
  it("PASS — ICP number in rendered HTML", () => {
    const e = makeEvidence({ renderedHtml: `<footer>京ICP备12345678号</footer>` })
    expect(ctrl("china.icp").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no ICP number", () => {
    expect(ctrl("china.icp").evaluate(makeEvidence()).passed).toBe(false)
  })
})

describe("china.cnanalytics", () => {
  it("PASS — Baidu analytics used", () => {
    const e = makeEvidence({ requests: [req("https://hm.baidu.com/hm.js")] })
    expect(ctrl("china.cnanalytics").evaluate(e).passed).toBe(true)
  })
  it("PASS — no blocked tracker firing", () => {
    const e = makeEvidence({ requests: [req("https://example.com/app.js")] })
    expect(ctrl("china.cnanalytics").evaluate(e).passed).toBe(true)
  })
  it("FAIL — Google Analytics firing", () => {
    const e = makeEvidence({
      requests: [req("https://www.google-analytics.com/analytics.js")],
    })
    expect(ctrl("china.cnanalytics").evaluate(e).passed).toBe(false)
  })
})
