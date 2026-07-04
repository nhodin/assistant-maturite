/**
 * Tests for Topic 6 — JS management
 * Controls: js.defer(30), js.nojsview(25), js.endofbody(20),
 *           js.eventbased(15), js.splittasks(10)
 */
import { describe, it, expect } from "vitest"
import { jsTopic } from "../src/topics/js"
import { makeEvidence } from "../src/core/fixture"

function ctrl(id: string) {
  const c = jsTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

const LONG_BODY = `<body><p>${Array.from({ length: 120 }, (_, i) => "word" + i).join(" ")}</p></body>`

describe("jsTopic metadata", () => {
  it("id + points", () => {
    expect(jsTopic.id).toBe(6)
    expect(jsTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })
})

describe("js.defer", () => {
  it("PASS — majority of first-party scripts deferred", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<script src="/a.js" defer></script><script src="/b.js" defer></script><script src="/c.js"></script>`,
    })
    expect(ctrl("js.defer").evaluate(e).passed).toBe(true)
  })
  it("FAIL — first-party scripts not deferred", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<script src="/a.js"></script><script src="/b.js"></script>`,
    })
    expect(ctrl("js.defer").evaluate(e).passed).toBe(false)
  })
  it("FAIL — no first-party scripts", () => {
    const e = makeEvidence({ rawHtml: `<p>no scripts</p>` })
    expect(ctrl("js.defer").evaluate(e).passed).toBe(false)
  })
})

describe("js.nojsview", () => {
  it("PASS — substantial SSR body (>=80 words)", () => {
    const e = makeEvidence({ rawHtml: LONG_BODY })
    expect(ctrl("js.nojsview").evaluate(e).passed).toBe(true)
  })
  it("FAIL — empty body", () => {
    const e = makeEvidence({ rawHtml: `<body><div></div></body>` })
    expect(ctrl("js.nojsview").evaluate(e).passed).toBe(false)
  })
})

describe("js.endofbody", () => {
  it("PASS — no blocking scripts in head", () => {
    const e = makeEvidence({
      rawHtml: `<head><script src="/a.js" defer></script></head><body></body>`,
    })
    expect(ctrl("js.endofbody").evaluate(e).passed).toBe(true)
  })
  it("FAIL — blocking script in head", () => {
    const e = makeEvidence({
      rawHtml: `<head><script src="/a.js"></script></head><body></body>`,
    })
    expect(ctrl("js.endofbody").evaluate(e).passed).toBe(false)
  })
})

describe("js.eventbased", () => {
  const mkReq = (
    url: string,
    phase: "load" | "interaction",
  ) => ({
    url,
    resourceType: "script",
    status: 200,
    fromCache: false,
    encodedBytes: 1000,
    decodedBytes: 1000,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "text/javascript",
    phase,
  })

  it("PASS — first-party script loads only after interaction", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [
        mkReq("https://example.com/main.js", "load"),
        mkReq("https://example.com/chat-widget.js", "interaction"),
      ],
    })
    expect(ctrl("js.eventbased").evaluate(e).passed).toBe(true)
  })

  it("FAIL — interaction-phase script is third-party", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [mkReq("https://cdn.thirdparty.com/x.js", "interaction")],
    })
    expect(ctrl("js.eventbased").evaluate(e).passed).toBe(false)
  })

  it("FAIL — no interaction-phase scripts", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [mkReq("https://example.com/main.js", "load")],
    })
    expect(ctrl("js.eventbased").evaluate(e).passed).toBe(false)
  })
})

describe("js.splittasks", () => {
  it("PASS — scheduler.yield present", () => {
    const e = makeEvidence({ rawHtml: `<script>await scheduler.yield()</script>` })
    expect(ctrl("js.splittasks").evaluate(e).passed).toBe(true)
  })
  it("PASS — no long tasks observed", () => {
    const e = makeEvidence({ perf: { longTasks: [] } })
    expect(ctrl("js.splittasks").evaluate(e).passed).toBe(true)
  })
  it("FAIL — long tasks and no scheduler.yield", () => {
    const e = makeEvidence({ perf: { longTasks: [{ startTime: 100, duration: 120 }] } })
    expect(ctrl("js.splittasks").evaluate(e).passed).toBe(false)
  })
})
