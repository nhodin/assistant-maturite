/**
 * Tests for Topic 8 — Critical path
 * Controls: cp.headorder(30), cp.limitresources(25), cp.preloadprio(20),
 *           cp.preloadheader(15), cp.earlyhints(10)
 */
import { describe, it, expect } from "vitest"
import { criticalPathTopic } from "../src/topics/criticalpath"
import { makeEvidence } from "../src/core/fixture"
import type { NetworkRequest } from "../src/core"

function ctrl(id: string) {
  const c = criticalPathTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

function req(p: Partial<NetworkRequest>): NetworkRequest {
  return {
    url: "https://example.com/x",
    resourceType: "other",
    status: 200,
    fromCache: false,
    encodedBytes: 0,
    decodedBytes: 0,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "",
    ...p,
  }
}

describe("criticalPathTopic metadata", () => {
  it("id + points", () => {
    expect(criticalPathTopic.id).toBe(8)
    expect(criticalPathTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })
})

describe("cp.headorder", () => {
  it("PASS — correct order", () => {
    const e = makeEvidence({
      head: {
        order: ["meta[charset]", "meta[viewport]", "title", "link[stylesheet]", "script"],
        tags: [],
      },
    })
    expect(ctrl("cp.headorder").evaluate(e).passed).toBe(true)
  })
  it("FAIL — script before stylesheet", () => {
    const e = makeEvidence({
      head: { order: ["script", "link[stylesheet]"], tags: [] },
    })
    expect(ctrl("cp.headorder").evaluate(e).passed).toBe(false)
  })

  it("PASS — meta[charset] within the first 1024 bytes", () => {
    const e = makeEvidence({
      head: { order: ["meta[charset]", "meta[viewport]"], tags: [] },
      rawHtml: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head></html>`,
    })
    const result = ctrl("cp.headorder").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("byte offset")
  })

  it("FAIL — meta[charset] present but past the 1024-byte budget", () => {
    const padding = `<!-- ${"x".repeat(1100)} -->`
    const e = makeEvidence({
      head: { order: ["meta[charset]", "meta[viewport]"], tags: [] },
      rawHtml: `<!doctype html><html><head>${padding}<meta charset="utf-8"><meta name="viewport" content="width=device-width"></head></html>`,
    })
    const result = ctrl("cp.headorder").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("re-parse")
  })
})

describe("cp.limitresources", () => {
  const html = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`

  it("FAIL — one sync script matched to a 400 KB request", () => {
    const e = makeEvidence({
      rawHtml: html(`<script src="https://example.com/app.js"></script>`),
      requests: [
        req({
          url: "https://example.com/app.js",
          resourceType: "script",
          encodedBytes: 400_000,
        }),
      ],
    })
    const result = ctrl("cp.limitresources").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("1 sync script(s)")
  })

  it("PASS — same 400 KB script but deferred (0 KB blocking)", () => {
    const e = makeEvidence({
      rawHtml: html(`<script defer src="https://example.com/app.js"></script>`),
      requests: [
        req({
          url: "https://example.com/app.js",
          resourceType: "script",
          encodedBytes: 400_000,
        }),
      ],
    })
    const result = ctrl("cp.limitresources").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("No render-blocking script or stylesheet")
    expect(result.evidence).toContain("for reference: total CSS+JS transferred")
  })

  it("PASS — 100 KB blocking stylesheet + 100 KB sync script (200 KB < 300 KB)", () => {
    const e = makeEvidence({
      rawHtml: html(
        `<link rel="stylesheet" media="screen" href="https://example.com/main.css">` +
          `<script src="https://example.com/app.js"></script>`,
      ),
      requests: [
        req({
          url: "https://example.com/main.css",
          resourceType: "stylesheet",
          encodedBytes: 102_400,
        }),
        req({
          url: "https://example.com/app.js",
          resourceType: "script",
          encodedBytes: 102_400,
        }),
      ],
    })
    const result = ctrl("cp.limitresources").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("200 KB")
    expect(result.evidence).toContain("1 sync script(s)")
    expect(result.evidence).toContain("1 blocking stylesheet(s)")
  })

  it("media=print stylesheet is not counted as blocking", () => {
    const e = makeEvidence({
      rawHtml: html(`<link rel="stylesheet" media="print" href="https://example.com/print.css">`),
      requests: [
        req({
          url: "https://example.com/print.css",
          resourceType: "stylesheet",
          encodedBytes: 500_000,
        }),
      ],
    })
    const result = ctrl("cp.limitresources").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("No render-blocking script or stylesheet")
  })

  it("blocking tag with no matching request is reported, not failed", () => {
    const e = makeEvidence({
      rawHtml: html(`<script src="https://example.com/ghost.js"></script>`),
      requests: [],
    })
    const result = ctrl("cp.limitresources").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("1 blocking tag(s) not matched to a network request")
  })

  it("loose match — request URL carries a cache-busting query", () => {
    const e = makeEvidence({
      rawHtml: html(`<script src="/assets/app.js"></script>`),
      requests: [
        req({
          url: "https://example.com/assets/app.js?v=42",
          resourceType: "script",
          encodedBytes: 400_000,
        }),
      ],
    })
    const result = ctrl("cp.limitresources").evaluate(e)
    expect(result.passed).toBe(false)
  })

  it("heavy interaction-phase scripts do not block (not in <head> markup)", () => {
    const e = makeEvidence({
      rawHtml: html(""),
      requests: [
        req({ resourceType: "script", encodedBytes: 500_000, phase: "interaction" }),
        req({ resourceType: "script", encodedBytes: 300_000, phase: "interaction" }),
      ],
    })
    const result = ctrl("cp.limitresources").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("for reference: total CSS+JS transferred (non-interaction): 0 KB")
  })
})

describe("cp.preloadprio", () => {
  it("PASS — preload as= and fetchpriority present", () => {
    const e = makeEvidence({
      rawHtml: `<link rel="preload" as="image" href="h.jpg" fetchpriority="high">`,
    })
    expect(ctrl("cp.preloadprio").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no preload/fetchpriority", () => {
    expect(ctrl("cp.preloadprio").evaluate(makeEvidence()).passed).toBe(false)
  })
})

describe("cp.preloadheader", () => {
  it("PASS — Link header has rel=preload", () => {
    const e = makeEvidence({
      mainResponseHeaders: { link: `<a.css>; rel=preload; as=style` },
    })
    expect(ctrl("cp.preloadheader").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no Link header", () => {
    expect(ctrl("cp.preloadheader").evaluate(makeEvidence()).passed).toBe(false)
  })
  it("PASS — Link header with a comma inside the preloaded URL", () => {
    const e = makeEvidence({
      mainResponseHeaders: { link: `<https://x.com/a,b.css>; rel=preload; as=style` },
    })
    const result = ctrl("cp.preloadheader").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("a,b.css")
  })
})

describe("cp.earlyhints", () => {
  it("FAIL — no 103 Early Hints observed", () => {
    expect(ctrl("cp.earlyhints").evaluate(makeEvidence()).passed).toBe(false)
  })
  it("PASS — 103 Early Hints observed", () => {
    const e = makeEvidence({ earlyHints: { link: "<a.css>; rel=preload; as=style" } })
    const result = ctrl("cp.earlyhints").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("Early Hints")
  })
})
