/**
 * Tests for Topic 4 — Third parties
 * One pass + one fail per control. tp.limit also tests the 2-analytics-provider case.
 */
import { describe, it, expect } from "vitest"
import { makeEvidence } from "../src/core/fixture"
import { thirdPartiesTopic } from "../src/topics/thirdparties"

const ctrl = Object.fromEntries(
  thirdPartiesTopic.controls.map((c) => [c.id, c]),
)

// ─────────────────────────────────────────────────────────────────────────────
// tp.deferasync  (30 pts)
// ─────────────────────────────────────────────────────────────────────────────
describe("tp.deferasync", () => {
  it("PASS — no third-party scripts in HTML", () => {
    const e = makeEvidence({
      rawHtml: `<!doctype html><html><head>
        <script src="/js/app.js" defer></script>
      </head><body></body></html>`,
    })
    const { passed, evidence } = ctrl["tp.deferasync"]!.evaluate(e)
    expect(passed).toBe(true)
    expect(evidence).toMatch(/no third-party scripts/)
  })

  it("PASS — all third-party scripts have defer/async", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <script src="https://www.googletagmanager.com/gtag/js" async></script>
        <script src="https://cdn.hotjar.com/hotjar.js" defer></script>
      </head><body></body></html>`,
    })
    const { passed, evidence } = ctrl["tp.deferasync"]!.evaluate(e)
    expect(passed).toBe(true)
    expect(evidence).toMatch(/2\/2/)
  })

  it("FAIL — third-party script without defer/async", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <script src="https://www.googletagmanager.com/gtag/js"></script>
      </head><body></body></html>`,
    })
    const { passed, evidence } = ctrl["tp.deferasync"]!.evaluate(e)
    expect(passed).toBe(false)
    expect(evidence).toMatch(/0\/1/)
  })

  it("PASS — type=module counts as deferred", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <script src="https://cdn.vimeo.com/player.js" type="module"></script>
      </head><body></body></html>`,
    })
    const { passed } = ctrl["tp.deferasync"]!.evaluate(e)
    expect(passed).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tp.preconnect  (25 pts)
// ─────────────────────────────────────────────────────────────────────────────
describe("tp.preconnect", () => {
  it("PASS — preconnect to external domain in <head>", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <link rel="preconnect" href="https://fonts.googleapis.com">
      </head><body></body></html>`,
    })
    const { passed, evidence } = ctrl["tp.preconnect"]!.evaluate(e)
    expect(passed).toBe(true)
    expect(evidence).toMatch(/1/)
  })

  it("PASS — dns-prefetch also counts", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <link rel="dns-prefetch" href="//www.google-analytics.com">
      </head><body></body></html>`,
    })
    const { passed } = ctrl["tp.preconnect"]!.evaluate(e)
    expect(passed).toBe(true)
  })

  it("FAIL — no preconnect in <head>", () => {
    const e = makeEvidence({
      rawHtml: `<!doctype html><html><head></head><body></body></html>`,
    })
    const { passed, evidence } = ctrl["tp.preconnect"]!.evaluate(e)
    expect(passed).toBe(false)
    expect(evidence).toMatch(/0/)
  })

  it("FAIL — preconnect only points to same-site domain", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <link rel="preconnect" href="https://static.example.com">
      </head><body></body></html>`,
    })
    const { passed } = ctrl["tp.preconnect"]!.evaluate(e)
    expect(passed).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tp.selfhost  (20 pts)
// ─────────────────────────────────────────────────────────────────────────────
describe("tp.selfhost", () => {
  it("PASS — no third-party resources in <head>", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <link rel="stylesheet" href="/styles/main.css">
        <script src="/js/app.js" defer></script>
      </head><body></body></html>`,
    })
    const { passed, evidence } = ctrl["tp.selfhost"]!.evaluate(e)
    expect(passed).toBe(true)
    expect(evidence).toMatch(/no third-party/)
  })

  it("FAIL — third-party stylesheet in <head>", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">
        <script src="/js/app.js" defer></script>
      </head><body></body></html>`,
    })
    const { passed, evidence } = ctrl["tp.selfhost"]!.evaluate(e)
    expect(passed).toBe(false)
    expect(evidence).toMatch(/1 third-party resource/)
  })

  it("FAIL — third-party script in <head>", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<!doctype html><html><head>
        <script src="https://www.googletagmanager.com/gtag/js"></script>
      </head><body></body></html>`,
    })
    const { passed } = ctrl["tp.selfhost"]!.evaluate(e)
    expect(passed).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tp.limit  (15 pts)
// ─────────────────────────────────────────────────────────────────────────────
describe("tp.limit", () => {
  it("PASS — clean: only 1 provider per category", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [
        {
          url: "https://www.googletagmanager.com/gtag/js",
          resourceType: "script",
          status: 200,
          fromCache: false,
          encodedBytes: 50000,
          decodedBytes: 100000,
          requestHeaders: {},
          responseHeaders: {},
          mimeType: "text/javascript",
        },
        {
          url: "https://connect.facebook.net/en_US/fbevents.js",
          resourceType: "script",
          status: 200,
          fromCache: false,
          encodedBytes: 30000,
          decodedBytes: 60000,
          requestHeaders: {},
          responseHeaders: {},
          mimeType: "text/javascript",
        },
      ],
    })
    const { passed, evidence } = ctrl["tp.limit"]!.evaluate(e)
    expect(passed).toBe(true)
    expect(evidence).toMatch(/no category exceeds 1/)
  })

  it("FAIL — 2 analytics providers (google-analytics + googletagmanager are same category → 1 provider, need different categories)", () => {
    // Use 2 different analytics providers in the SAME category:
    // hotjar AND clarity are both "session-replay"
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [
        {
          url: "https://static.hotjar.com/c/hotjar.js",
          resourceType: "script",
          status: 200,
          fromCache: false,
          encodedBytes: 20000,
          decodedBytes: 40000,
          requestHeaders: {},
          responseHeaders: {},
          mimeType: "text/javascript",
        },
        {
          url: "https://www.clarity.ms/tag/abc123",
          resourceType: "script",
          status: 200,
          fromCache: false,
          encodedBytes: 15000,
          decodedBytes: 30000,
          requestHeaders: {},
          responseHeaders: {},
          mimeType: "text/javascript",
        },
      ],
    })
    const { passed, evidence } = ctrl["tp.limit"]!.evaluate(e)
    expect(passed).toBe(false)
    expect(evidence).toMatch(/session-replay/)
  })

  it("FAIL — 2 analytics/tagmgr providers", () => {
    // Simulate 2 distinct analytics-tagmgr providers by using GA + GTM from different
    // subdomains (both match analytics-tagmgr). In practice same company but
    // our heuristic groups by host.
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [
        {
          url: "https://www.google-analytics.com/analytics.js",
          resourceType: "script",
          status: 200,
          fromCache: false,
          encodedBytes: 40000,
          decodedBytes: 80000,
          requestHeaders: {},
          responseHeaders: {},
          mimeType: "text/javascript",
        },
        {
          url: "https://www.googletagmanager.com/gtag/js",
          resourceType: "script",
          status: 200,
          fromCache: false,
          encodedBytes: 50000,
          decodedBytes: 100000,
          requestHeaders: {},
          responseHeaders: {},
          mimeType: "text/javascript",
        },
      ],
    })
    const { passed, evidence } = ctrl["tp.limit"]!.evaluate(e)
    // Both are "analytics-tagmgr" — 2 distinct hosts → FAIL
    expect(passed).toBe(false)
    expect(evidence).toMatch(/analytics-tagmgr/)
  })

  it("PASS — no requests", () => {
    const e = makeEvidence({ requests: [] })
    const { passed } = ctrl["tp.limit"]!.evaluate(e)
    expect(passed).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// tp.eventbased  (10 pts) — always fails (POC limitation)
// ─────────────────────────────────────────────────────────────────────────────
describe("tp.eventbased", () => {
  it("FAIL always — POC limitation", () => {
    const e = makeEvidence()
    const { passed, evidence } = ctrl["tp.eventbased"]!.evaluate(e)
    expect(passed).toBe(false)
    expect(evidence).toMatch(/POC limitation/)
  })

  it("FAIL even with rich bundle", () => {
    const e = makeEvidence({
      rawHtml: `<html><head></head><body>
        <script>window.addEventListener('load', () => { /* load analytics */ })</script>
      </body></html>`,
    })
    const { passed } = ctrl["tp.eventbased"]!.evaluate(e)
    expect(passed).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Topic-level sanity
// ─────────────────────────────────────────────────────────────────────────────
describe("thirdPartiesTopic structure", () => {
  it("has correct id and 5 controls", () => {
    expect(thirdPartiesTopic.id).toBe(4)
    expect(thirdPartiesTopic.hasNA).toBe(false)
    expect(thirdPartiesTopic.standalone).toBe(false)
    expect(thirdPartiesTopic.controls).toHaveLength(5)
  })

  it("total default points sum to 100", () => {
    const total = thirdPartiesTopic.controls.reduce(
      (sum, c) => sum + c.defaultPoints,
      0,
    )
    expect(total).toBe(100)
  })

  it("control ids are namespaced with tp.", () => {
    for (const c of thirdPartiesTopic.controls) {
      expect(c.id).toMatch(/^tp\./)
    }
  })
})
