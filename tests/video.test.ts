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

/**
 * louisvuitton.com HP pattern: no `poster` attribute — a <picture> is stacked over the
 * <video> and hidden once it loads. The <img> holds a transparent base64 GIF in `src`
 * and the real URLs only in `srcset`, which the parser resolves without JS.
 */
const LV_OVERLAY_HTML = `<div class="is-loaded lv-video-loop">
  <div class="video-loop-poster lv-responsive-picture is-loaded">
    <div class="lv-skeleton" style="display: none;"></div>
    <picture>
      <img sizes="(min-width: 0rem) 100vw" class="lv-smart-picture__object"
        srcset="/images/is/poster-video/a26.jpg?wid=490 490w, /images/is/poster-video/a26.jpg?wid=1180 1180w"
        src="data:image/gif;base64,R0lGODlhAQABAAAAACAAAAAAAAAAAAABAAEAAAIBTAA7">
    </picture>
  </div>
  <video src="https://vod.freecaster.com/a26_9.mp4" muted loop preload="auto" playsinline></video>
</div>`

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

  it("PASS — overlay <picture> stacked on the video (louisvuitton.com pattern)", () => {
    const e = makeEvidence({ rawHtml: LV_OVERLAY_HTML })
    const result = ctrl("video.posternojs").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/overlay/i)
    expect(result.evidence).toMatch(/srcset/i)
  })

  it("FAIL — overlay image is lazyloaded (data-srcset only, needs JS)", () => {
    const e = makeEvidence({
      rawHtml: `<div class="video-loop-poster"><picture><img data-srcset="/p.jpg 490w" src="data:image/gif;base64,R0lGOD"></picture></div><video src="v.mp4"></video>`,
    })
    expect(ctrl("video.posternojs").evaluate(e).passed).toBe(false)
  })

  it("FAIL — image next to the video but no poster-named container", () => {
    const e = makeEvidence({
      rawHtml: `<div class="editorial-block"><img src="/logo.jpg"></div><video src="v.mp4"></video>`,
    })
    expect(ctrl("video.posternojs").evaluate(e).passed).toBe(false)
  })

  it("FAIL — <source src> inside <video> is the video file, not a poster", () => {
    const e = makeEvidence({
      rawHtml: `<div class="video-cover"><video><source src="/v.mp4" type="video/mp4"></video></div>`,
    })
    expect(ctrl("video.posternojs").evaluate(e).passed).toBe(false)
  })

  it('FAIL — "discover" in a class name is not the "cover" poster token', () => {
    const e = makeEvidence({
      rawHtml: `<div class="discover-block"><img src="/a.jpg"></div><video src="v.mp4"></video>`,
    })
    expect(ctrl("video.posternojs").evaluate(e).passed).toBe(false)
  })

  it("PASS — <noscript><img> fallback in the video container", () => {
    const e = makeEvidence({
      rawHtml: `<div class="hero-media"><noscript><img src="/still.jpg"></noscript></div><video src="v.mp4"></video>`,
    })
    const result = ctrl("video.posternojs").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/noscript/i)
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
  it("À CONFIRMER — CLS not measured → unknown, still not passed", () => {
    const e = makeEvidence({ perf: { cls: null } })
    const r = ctrl("video.reservedspace").evaluate(e)
    expect(r.passed).toBe(false)
    expect(r.unknown).toBe(true)
    expect(r.evidence).toMatch(/À confirmer/i)
  })
  it("no unknown flag when CLS is measured", () => {
    expect(ctrl("video.reservedspace").evaluate(makeEvidence({ perf: { cls: 0.2 } })).unknown)
      .toBeUndefined()
  })
})

describe("topic 3 applicability — the whole topic is N/A off the critical path", () => {
  // Every control shares one gate, so the topic is N/A as a block.
  const gate = () => ctrl("video.preloadposter").appliesTo!

  it("every control shares the same gate", () => {
    const gates = new Set(videoTopic.controls.map((c) => c.appliesTo))
    expect(gates.size).toBe(1)
    expect([...gates][0]).toBeTypeOf("function")
  })

  it("N/A — video below the fold and not the LCP", () => {
    const e = makeEvidence({
      features: { videoDetected: true, videoInViewport: false },
      rawHtml: LV_OVERLAY_HTML,
      perf: { lcpElement: { tagName: "H1" } },
    })
    expect(gate()(e)).toBe(false)
  })

  it("APPLIES — video in the initial viewport", () => {
    const e = makeEvidence({
      features: { videoDetected: true, videoInViewport: true },
      rawHtml: LV_OVERLAY_HTML,
    })
    expect(gate()(e)).toBe(true)
  })

  it("APPLIES — video below the fold but the <video> is the LCP", () => {
    const e = makeEvidence({
      features: { videoDetected: true, videoInViewport: false },
      rawHtml: `<video src="v.mp4"></video>`,
      perf: { lcpElement: { tagName: "VIDEO" } },
    })
    expect(gate()(e)).toBe(true)
  })

  it("APPLIES — video below the fold but its overlay poster is the LCP", () => {
    const e = makeEvidence({
      features: { videoDetected: true, videoInViewport: false },
      rawHtml: LV_OVERLAY_HTML,
      perf: {
        lcpElement: {
          tagName: "IMG",
          src: "https://lv.com/images/is/poster-video/a26.jpg?wid=1180",
        },
      },
    })
    expect(gate()(e)).toBe(true)
  })

  it("APPLIES — videoInViewport not measured (legacy evidence)", () => {
    const e = makeEvidence({
      features: { videoDetected: true },
      rawHtml: `<video src="v.mp4"></video>`,
    })
    expect(gate()(e)).toBe(true)
  })

  it("N/A — no video at all", () => {
    const e = makeEvidence({ features: { videoDetected: false } })
    expect(gate()(e)).toBe(false)
  })
})

describe("video.preloadposter", () => {
  it("PASS — preload as=image fetchpriority=high matching the <video poster>", () => {
    const e = makeEvidence({
      rawHtml: `<head><link rel="preload" as="image" fetchpriority="high" href="p.jpg"></head><body><video poster="p.jpg"></video></body>`,
    })
    expect(ctrl("video.preloadposter").evaluate(e).passed).toBe(true)
  })
  it("FAIL — no such preload", () => {
    const e = makeEvidence({ rawHtml: `<head></head>` })
    expect(ctrl("video.preloadposter").evaluate(e).passed).toBe(false)
  })

  it("PASS — preload href matches a <video poster> (loose filename match)", () => {
    const e = makeEvidence({
      rawHtml: `<head><link rel="preload" as="image" fetchpriority="high" href="/cdn/poster.jpg?w=800"></head><body><video poster="https://img.example.com/poster.jpg"></video></body>`,
    })
    const result = ctrl("video.preloadposter").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("poster")
  })

  it("FAIL — image preload present but does not match any <video poster>", () => {
    const e = makeEvidence({
      rawHtml: `<head><link rel="preload" as="image" fetchpriority="high" href="hero.jpg"></head><body><video poster="poster.jpg"></video></body>`,
    })
    const result = ctrl("video.preloadposter").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/none of its href/i)
  })

  it("PASS — preload matches an overlay poster srcset URL (louisvuitton.com pattern)", () => {
    const e = makeEvidence({
      rawHtml: `<head><link rel="preload" as="image" fetchpriority="high" href="/images/is/poster-video/a26.jpg?wid=1180"></head><body>${LV_OVERLAY_HTML}</body>`,
    })
    const result = ctrl("video.preloadposter").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/overlay poster/i)
  })

  // video.posternojs (30 pts) fails when no poster is resolvable without JS; this
  // 20-pt criterion presupposes it, so an unrelated image preload cannot rescue it.
  it("FAIL — image preload in <head> but no poster resolvable without JS", () => {
    const e = makeEvidence({
      rawHtml: `<head><link rel="preload" as="image" fetchpriority="high" href="p.jpg"></head><body><video src="v.mp4"></video></body>`,
    })
    const result = ctrl("video.preloadposter").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no poster resolvable without JS/i)
    expect(ctrl("video.posternojs").evaluate(e).passed).toBe(false)
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
  it("PASS — root-relative <video src> with no media request captured", () => {
    // preload="none": nothing is fetched during the capture, so the markup is the only
    // evidence. A relative src resolves against the page origin → first-party.
    const e = makeEvidence({
      finalUrl: "https://example.com/fr/home",
      rawHtml: `<video src="/videos/hero.mp4" preload="none"></video>`,
      requests: [],
    })
    const result = ctrl("video.selfhosted").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/first-party/i)
    expect(result.evidence).toContain("/videos/hero.mp4")
  })
  it("FAIL — data: URI src is not evidence of self-hosting", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<video src="data:video/mp4;base64,AAAA"></video>`,
      requests: [],
    })
    expect(ctrl("video.selfhosted").evaluate(e).passed).toBe(false)
  })
  it("FAIL — empty src attributes are ignored", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<video src=""><source src=""></video>`,
      requests: [],
    })
    expect(ctrl("video.selfhosted").evaluate(e).passed).toBe(false)
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

  // The ideal case: nothing third-party to fine-tune. Failing it would penalise the
  // best possible behaviour (same rule as tp.deferasync with no third-party script).
  it("PASS — self-hosted video, no player request, no player iframe/script", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<html><body><video src="/videos/hero.mp4" poster="/p.jpg"></video><script src="/app.js"></script></body></html>`,
      requests: [mkReq("https://example.com/app.js", "script", "interaction")],
    })
    const result = ctrl("video.playerjs").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/no third-party video player/i)
  })

  it("FAIL — youtube.com request during the load phase", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [mkReq("https://www.youtube.com/iframe_api", "script", "load")],
    })
    expect(ctrl("video.playerjs").evaluate(e).passed).toBe(false)
  })

  it("PASS — player request only in the interaction phase", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      requests: [mkReq("https://player.vimeo.com/video/123", "document", "interaction")],
    })
    expect(ctrl("video.playerjs").evaluate(e).passed).toBe(true)
  })
})

describe("video.preconnect", () => {
  it("PASS — no third-party player at all, nothing to preconnect", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      rawHtml: `<html><head></head><body><video src="/v.mp4"></video></body></html>`,
    })
    const result = ctrl("video.preconnect").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/nothing to preconnect/i)
  })
  it("FAIL — youtube iframe present but no preconnect", () => {
    const e = makeEvidence({
      rawHtml: `<html><head><link rel="preconnect" href="https://fonts.example.net"></head><body><iframe src="https://www.youtube.com/embed/abc"></iframe></body></html>`,
    })
    expect(ctrl("video.preconnect").evaluate(e).passed).toBe(false)
  })
  it("PASS — youtube iframe + preconnect to the video domain", () => {
    const e = makeEvidence({
      rawHtml: `<html><head><link rel="preconnect" href="https://www.youtube.com"></head><body><iframe src="https://www.youtube.com/embed/abc"></iframe></body></html>`,
    })
    expect(ctrl("video.preconnect").evaluate(e).passed).toBe(true)
  })
})
