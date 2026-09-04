/**
 * Cross-topic regression tests for HTML-comment blindness.
 *
 * A browser never executes what sits inside `<!-- ... -->`, so markup that only
 * exists in a comment must neither validate nor invalidate a criterion. The strip
 * lives in `stripHtmlComments` (topics/util.ts); these tests pin it down at the
 * call sites that scan `rawHtml` directly, i.e. those that do NOT go through
 * `parseTags` / `headSlice` / `bodySlice` (already covered by util.test.ts).
 */
import { describe, it, expect } from "vitest"
import { makeEvidence } from "../src/core/fixture"
import { imagesTopic } from "../src/topics/images"
import { criticalPathTopic } from "../src/topics/criticalpath"
import { ttfbCacheTopic } from "../src/topics/ttfbcache"
import { sliderTopic } from "../src/topics/slider"
import { jsTopic } from "../src/topics/js"
import type { TopicModule } from "../src/core"

function ctrl(topic: TopicModule, id: string) {
  const c = topic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control not found: ${id}`)
  return c
}

describe("HTML comments are invisible to detection", () => {
  it("images.lazyload — a commented-out <img loading=lazy> does not validate", () => {
    const e = makeEvidence({
      rawHtml: '<html><body><!-- <img src="hero.jpg" loading="lazy"> --><img src="hero.jpg"></body></html>',
    })
    expect(ctrl(imagesTopic, "images.lazyload").evaluate(e).passed).toBe(false)
  })

  it("images.lazyload — a real lazy <img> still validates alongside a commented one", () => {
    const e = makeEvidence({
      rawHtml: '<html><body><!-- <img src="old.jpg"> --><img src="hero.jpg" loading="lazy"></body></html>',
    })
    expect(ctrl(imagesTopic, "images.lazyload").evaluate(e).passed).toBe(true)
  })

  it("cp.preloadusage — a preload + fetchpriority living only in a comment does not validate", () => {
    const e = makeEvidence({
      rawHtml:
        '<html><head><!-- <link rel="preload" as="image" href="h.jpg" fetchpriority="high"> --></head><body></body></html>',
    })
    expect(ctrl(criticalPathTopic, "cp.preloadprio").evaluate(e).passed).toBe(false)
  })

  it("ttfb.speculationrules — a commented-out speculation rules script does not validate", () => {
    const e = makeEvidence({
      rawHtml:
        '<html><head><!-- <script type="speculationrules">{"prerender":[]}</script> --></head><body></body></html>',
    })
    expect(ctrl(ttfbCacheTopic, "ttfb.specrules").evaluate(e).passed).toBe(false)
  })

  it("ttfb.bfcache — a commented-out unload handler does not fail the criterion", () => {
    const e = makeEvidence({
      rawHtml: '<html><body><!-- <body onunload="save()"> --></body></html>',
      mainResponseHeaders: { "cache-control": "max-age=60" },
    })
    expect(ctrl(ttfbCacheTopic, "ttfb.bfcache").evaluate(e).passed).toBe(true)
  })

  it("slider — markup that only exists in a comment is not detected as a slider", () => {
    const e = makeEvidence({
      rawHtml: '<html><body><!-- <div class="swiper"><img src="s1.jpg"></div> --></body></html>',
    })
    // No slider markup at all → the topic's markup controls see zero slider windows,
    // exactly as if the commented block were absent from the document.
    expect(ctrl(sliderTopic, "slider.firstimgnojs").evaluate(e).evidence).not.toContain("s1.jpg")
  })

  it("js.splittasks — a commented-out scheduler.yield does not validate", () => {
    const e = makeEvidence({
      rawHtml: "<html><body><!-- await scheduler.yield() --></body></html>",
      perf: { longTasks: [{ startTime: 0, duration: 250 }] },
    })
    expect(ctrl(jsTopic, "js.splittasks").evaluate(e).passed).toBe(false)
  })

  it("a literal <!-- inside a <script> body is preserved, not treated as a comment", () => {
    const e = makeEvidence({
      rawHtml:
        '<html><body><script>var s = "<!--";</script><img src="hero.jpg" loading="lazy"></body></html>',
    })
    expect(ctrl(imagesTopic, "images.lazyload").evaluate(e).passed).toBe(true)
  })
})
