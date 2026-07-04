/**
 * Tests for Topic 3 — Video management
 * Controls: video.posternojs(30), video.reservedspace(25), video.preloadposter(20),
 *           video.selfhosted(10), video.playerjs(10), video.preconnect(5)
 */
import { describe, it, expect } from "vitest"
import { videoTopic } from "../src/topics/video"
import { makeEvidence } from "../src/core/fixture"

function ctrl(id: string) {
  const c = videoTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control ${id} not found`)
  return c
}

describe("videoTopic metadata", () => {
  it("id/name/hasNA/standalone + points", () => {
    expect(videoTopic.id).toBe(3)
    expect(videoTopic.hasNA).toBe(true)
    expect(videoTopic.standalone).toBe(false)
    expect(videoTopic.controls.reduce((s, c) => s + c.defaultPoints, 0)).toBe(100)
  })
})

describe("video.posternojs", () => {
  it("PASS — <video poster> in raw HTML", () => {
    const e = makeEvidence({ rawHtml: `<video poster="p.jpg"></video>` })
    expect(ctrl("video.posternojs").evaluate(e).passed).toBe(true)
  })
  it("FAIL — video without poster", () => {
    const e = makeEvidence({ rawHtml: `<video></video>` })
    expect(ctrl("video.posternojs").evaluate(e).passed).toBe(false)
  })
})

describe("video.reservedspace", () => {
  it("PASS — CLS < 0.05", () => {
    const e = makeEvidence({ perf: { cls: 0.0 } })
    expect(ctrl("video.reservedspace").evaluate(e).passed).toBe(true)
  })
  it("FAIL — CLS >= 0.05", () => {
    const e = makeEvidence({ perf: { cls: 0.2 } })
    expect(ctrl("video.reservedspace").evaluate(e).passed).toBe(false)
  })
  it("FAIL — CLS not measured", () => {
    const e = makeEvidence({ perf: { cls: null } })
    expect(ctrl("video.reservedspace").evaluate(e).passed).toBe(false)
  })
})

describe("video.preloadposter", () => {
  it("PASS — preload as=image fetchpriority=high in head", () => {
    const e = makeEvidence({
      rawHtml: `<head><link rel="preload" as="image" fetchpriority="high" href="p.jpg"></head>`,
    })
    expect(ctrl("video.preloadposter").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no such preload", () => {
    const e = makeEvidence({ rawHtml: `<head></head>` })
    expect(ctrl("video.preloadposter").evaluate(e).passed).toBe(false)
  })
})

describe("video.selfhosted", () => {
  it("PASS — same-site <video src>", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<video src="https://example.com/v.mp4"></video>`,
    })
    expect(ctrl("video.selfhosted").evaluate(e).passed).toBe(true)
  })
  it("FAIL — only third-party YouTube iframe", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<iframe src="https://www.youtube.com/embed/abc"></iframe>`,
    })
    expect(ctrl("video.selfhosted").evaluate(e).passed).toBe(false)
  })
})

describe("video.playerjs", () => {
  const mkReq = (
    url: string,
    resourceType: string,
    phase: "load" | "interaction",
  ) => ({
    url,
    resourceType,
    status: 200,
    fromCache: false,
    encodedBytes: 1000,
    decodedBytes: 1000,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "",
    phase,
  })

  it("PASS — YouTube iframe loads only after interaction (facade)", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [
        mkReq("https://www.youtube.com/embed/abc", "document", "interaction"),
      ],
    })
    expect(ctrl("video.playerjs").evaluate(e).passed).toBe(true)
  })

  it("FAIL — player script loaded eagerly during initial load", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [
        mkReq("https://www.youtube.com/iframe_api.js", "script", "load"),
      ],
    })
    expect(ctrl("video.playerjs").evaluate(e).passed).toBe(false)
  })

  it("FAIL — no video player request after interaction", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [mkReq("https://example.com/app.js", "script", "interaction")],
    })
    expect(ctrl("video.playerjs").evaluate(e).passed).toBe(false)
  })
})

describe("video.preconnect", () => {
  it("PASS — preconnect to a video domain", () => {
    const e = makeEvidence({
      rawHtml: `<head><link rel="preconnect" href="https://www.youtube.com"></head>`,
    })
    expect(ctrl("video.preconnect").evaluate(e).passed).toBe(true)
  })
  it("FAIL — preconnect to a non-video domain only", () => {
    const e = makeEvidence({
      rawHtml: `<head><link rel="preconnect" href="https://fonts.example.net"></head>`,
    })
    expect(ctrl("video.preconnect").evaluate(e).passed).toBe(false)
  })
})
