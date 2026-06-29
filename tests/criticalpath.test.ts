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
})

describe("cp.limitresources", () => {
  it("PASS — under 600 KB", () => {
    const e = makeEvidence({
      requests: [req({ resourceType: "script", encodedBytes: 100_000 })],
    })
    expect(ctrl("cp.limitresources").evaluate(e).passed).toBe(true)
  })
  it("FAIL — over 600 KB", () => {
    const e = makeEvidence({
      requests: [
        req({ resourceType: "script", encodedBytes: 400_000 }),
        req({ resourceType: "stylesheet", encodedBytes: 300_000 }),
      ],
    })
    expect(ctrl("cp.limitresources").evaluate(e).passed).toBe(false)
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
})

describe("cp.earlyhints", () => {
  it("always FAIL (POC limitation)", () => {
    expect(ctrl("cp.earlyhints").evaluate(makeEvidence()).passed).toBe(false)
  })
})
