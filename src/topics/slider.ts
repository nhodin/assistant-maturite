/**
 * Topic 2 — Slider management
 * topicId: 2 | hasNA: true | standalone: false
 * Max points: 30+25+20+15+10 = 100
 *
 * Every control declares appliesTo: (e) => e.features.sliderDetected === true.
 * When no slider is present the engine marks the topic N/A.
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import { parseTags, headSlice } from "./util"

const sliderGate = (e: EvidenceBundle): boolean => e.features.sliderDetected === true

// ── controls ─────────────────────────────────────────────────────────────────

const firstImgNoJs: Control = {
  id: "slider.firstimgnojs",
  topicId: 2,
  label: "First slide image in server HTML (no JS required)",
  description:
    'At least one <img> with a real src (http/https or root-relative, not data:) found in raw HTML.',
  defaultPoints: 30,
  appliesTo: sliderGate,
  evaluate(e) {
    const imgs = parseTags(e.rawHtml, "img")
    const realSrcImgs = imgs.filter((img) => {
      const src = img.attrs["src"] ?? ""
      return (
        src.length > 0 &&
        !src.startsWith("data:") &&
        (src.startsWith("http://") ||
          src.startsWith("https://") ||
          src.startsWith("/"))
      )
    })
    const count = realSrcImgs.length
    const passed = count > 0
    return {
      passed,
      evidence: passed
        ? `${count} <img> element(s) with real src found in raw HTML`
        : "No <img> with a real (non-data:) src found in raw HTML",
    }
  },
}

const reservedSpace: Control = {
  id: "slider.reservedspace",
  topicId: 2,
  label: "Reserved space for slider wrapper (CLS < 0.05)",
  description: "CLS is measured and below 0.05, indicating the slider has reserved space.",
  defaultPoints: 25,
  appliesTo: sliderGate,
  evaluate(e) {
    const cls = e.perf.cls
    if (cls === null) {
      return { passed: false, evidence: "CLS not measured" }
    }
    const passed = cls < 0.05
    return {
      passed,
      evidence: passed
        ? `CLS = ${cls} (< 0.05 threshold)`
        : `CLS = ${cls} (≥ 0.05 threshold)`,
    }
  },
}

const lazyLoadRest: Control = {
  id: "slider.lazyloadrest",
  topicId: 2,
  label: "Lazyload non-visible slider images",
  description:
    'Raw HTML contains at least one <img loading="lazy"> or an <img> with data-src/data-lazy attribute.',
  defaultPoints: 20,
  appliesTo: sliderGate,
  evaluate(e) {
    const imgs = parseTags(e.rawHtml, "img")

    const lazyLoadingImgs = imgs.filter(
      (img) => (img.attrs["loading"] ?? "").toLowerCase() === "lazy",
    )
    const dataSrcImgs = imgs.filter(
      (img) =>
        img.attrs["data-src"] !== undefined || img.attrs["data-lazy"] !== undefined,
    )

    const lazyCount = lazyLoadingImgs.length
    const dataSrcCount = dataSrcImgs.length
    const passed = lazyCount > 0 || dataSrcCount > 0

    if (!passed) {
      return {
        passed: false,
        evidence: "No <img loading=\"lazy\"> or data-src/data-lazy attributes found in raw HTML",
      }
    }
    const parts: string[] = []
    if (lazyCount > 0) parts.push(`${lazyCount} <img loading="lazy">`)
    if (dataSrcCount > 0) parts.push(`${dataSrcCount} <img data-src/data-lazy>`)
    return { passed: true, evidence: parts.join("; ") + " found in raw HTML" }
  },
}

const delayNext: Control = {
  id: "slider.delaynext",
  topicId: 2,
  label: "Delay next slide loading after onload",
  description:
    "At least one image is fetched ONLY after a synthetic user/browser interaction (phase=interaction), not during initial load — deferred next-slide loading.",
  defaultPoints: 15,
  appliesTo: sliderGate,
  evaluate(e) {
    // Image URLs already fetched during the quiet initial load.
    const loadedImgs = new Set<string>()
    for (const req of e.requests) {
      if (req.resourceType !== "image") continue
      if (req.phase === "interaction") continue
      loadedImgs.add(req.url)
    }

    const deferred = e.requests.filter(
      (req) =>
        req.resourceType === "image" &&
        req.phase === "interaction" &&
        !loadedImgs.has(req.url),
    )

    const passed = deferred.length > 0
    return {
      passed,
      evidence: passed
        ? `${deferred.length} image(s) loaded only after user/browser interaction (deferred next-slide loading)`
        : "no slider image loaded only after synthetic user/browser interaction",
    }
  },
}

const preloadNext: Control = {
  id: "slider.preloadnext",
  topicId: 2,
  label: "Preload next slider images",
  description: 'A <link rel="preload" as="image"> exists in <head>.',
  defaultPoints: 10,
  appliesTo: sliderGate,
  evaluate(e) {
    const head = headSlice(e.rawHtml)
    const links = parseTags(head, "link")
    const preloadImageLinks = links.filter(
      (link) =>
        (link.attrs["rel"] ?? "").toLowerCase() === "preload" &&
        (link.attrs["as"] ?? "").toLowerCase() === "image",
    )
    const count = preloadImageLinks.length
    const passed = count > 0
    return {
      passed,
      evidence: passed
        ? `${count} <link rel="preload" as="image"> found in <head>`
        : 'No <link rel="preload" as="image"> found in <head>',
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const sliderTopic: TopicModule = {
  id: 2,
  name: "Slider management",
  hasNA: true,
  standalone: false,
  controls: [
    firstImgNoJs,   // 30
    reservedSpace,  // 25
    lazyLoadRest,   // 20
    delayNext,      // 15
    preloadNext,    // 10
  ],
}
