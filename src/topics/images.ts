/**
 * Topic 1 — Images management
 * topicId: 1 | hasNA: false | standalone: false
 * Max points: 30+20+15+10+10+5+5+5 = 100
 */
import type { EvidenceBundle, NetworkRequest } from "../core"
import type { Control, TopicModule } from "../core"

// ── helpers ──────────────────────────────────────────────────────────────────

function imageRequests(e: EvidenceBundle): NetworkRequest[] {
  return e.requests.filter((r) => r.resourceType === "image")
}

function isModernImageMime(mimeType: string): boolean {
  return mimeType === "image/webp" || mimeType === "image/avif"
}

function countImgsWithAttr(html: string, attr: string): number {
  // Match <img ... attr="..." ...> (attr present anywhere in tag)
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? []
  return imgTags.filter((tag) => new RegExp(`\\b${attr}\\s*=`, "i").test(tag)).length
}

function countImgsWithBothDimensions(html: string): number {
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? []
  return imgTags.filter((tag) => {
    const hasWidth = /\bwidth\s*=/i.test(tag)
    const hasHeight = /\bheight\s*=/i.test(tag)
    const hasAspectRatio = /aspect-ratio/i.test(tag)
    return (hasWidth && hasHeight) || hasAspectRatio
  }).length
}

// ── controls ─────────────────────────────────────────────────────────────────

const lazyloadControl: Control = {
  id: "images.lazyload",
  topicId: 1,
  label: "Basic lazy-loading",
  description: "At least one <img loading=\"lazy\"> in raw HTML.",
  defaultPoints: 30,
  evaluate(e) {
    const count = countImgsWithAttr(e.rawHtml, "loading")
    // More precisely: count imgs where loading="lazy"
    const imgTags = e.rawHtml.match(/<img\b[^>]*>/gi) ?? []
    const lazyCount = imgTags.filter((tag) => /\bloading\s*=\s*["']?lazy["']?/i.test(tag)).length
    const passed = lazyCount > 0
    return {
      passed,
      evidence: passed
        ? `${lazyCount} <img loading="lazy"> found in raw HTML`
        : "No <img loading=\"lazy\"> found in raw HTML",
    }
  },
}

const modernFormatControl: Control = {
  id: "images.modernformat",
  topicId: 1,
  label: "Modern image format (WebP / AVIF)",
  description: "Majority (>50%) of image responses use image/webp or image/avif content-type.",
  defaultPoints: 20,
  evaluate(e) {
    const imgs = imageRequests(e)
    if (imgs.length === 0) {
      return { passed: false, evidence: "No image requests observed" }
    }
    const modernCount = imgs.filter((r) => isModernImageMime(r.mimeType)).length
    const pct = Math.round((modernCount / imgs.length) * 100)
    const passed = modernCount / imgs.length > 0.5
    return {
      passed,
      evidence: `${modernCount}/${imgs.length} image responses are webp/avif (${pct}%)`,
    }
  },
}

const lcpPreloadControl: Control = {
  id: "images.lcppreload",
  topicId: 1,
  label: "LCP image preloaded with fetchpriority=high",
  description: "LCP element has fetchpriority=high, or a <link rel=preload as=image fetchpriority=high> exists.",
  defaultPoints: 15,
  evaluate(e) {
    // Check 1: LCP element itself has fetchpriority=high
    if (e.perf.lcpElement?.fetchPriorityAttr === "high") {
      return {
        passed: true,
        evidence: `LCP element (${e.perf.lcpElement.tagName}) has fetchpriority="high" attribute`,
      }
    }
    // Check 2: a <link rel="preload" as="image" fetchpriority="high"> in rawHtml
    const preloadLinks = e.rawHtml.match(/<link\b[^>]*>/gi) ?? []
    const highPriorityPreload = preloadLinks.find((tag) => {
      const isPreload = /\brel\s*=\s*["']?preload["']?/i.test(tag)
      const isImage = /\bas\s*=\s*["']?image["']?/i.test(tag)
      const isHighPriority = /\bfetchpriority\s*=\s*["']?high["']?/i.test(tag)
      return isPreload && isImage && isHighPriority
    })
    if (highPriorityPreload) {
      return {
        passed: true,
        evidence: `Found <link rel="preload" as="image" fetchpriority="high"> in raw HTML`,
      }
    }
    return {
      passed: false,
      evidence: "No fetchpriority=high on LCP element and no <link rel=preload as=image fetchpriority=high> found",
    }
  },
}

const fixedHeightControl: Control = {
  id: "images.fixedheight",
  topicId: 1,
  label: "Fixed width & height on images (CLS prevention)",
  description: "≥60% of <img> elements have both width and height attributes (or aspect-ratio).",
  defaultPoints: 10,
  evaluate(e) {
    const imgTags = e.rawHtml.match(/<img\b[^>]*>/gi) ?? []
    const total = imgTags.length
    if (total === 0) {
      return { passed: true, evidence: "No <img> tags found — criterion vacuously satisfied" }
    }
    const withDimensions = countImgsWithBothDimensions(e.rawHtml)
    const pct = Math.round((withDimensions / total) * 100)
    const passed = withDimensions / total >= 0.6
    return {
      passed,
      evidence: `${withDimensions}/${total} <img> tags have width+height (or aspect-ratio) = ${pct}%`,
    }
  },
}

const lcpNotLazyControl: Control = {
  id: "images.lcpnotlazy",
  topicId: 1,
  label: "LCP image is not lazy-loaded",
  description: "LCP element exists, is an image, and does not have loading=lazy.",
  defaultPoints: 10,
  evaluate(e) {
    const lcp = e.perf.lcpElement
    if (!lcp) {
      return { passed: false, evidence: "LCP element not identified" }
    }
    const isImage = lcp.tagName.toUpperCase() === "IMG" || Boolean(lcp.src)
    if (!isImage) {
      return { passed: true, evidence: `LCP element is <${lcp.tagName}> (not an img) — criterion satisfied` }
    }
    const passed = lcp.loadingAttr !== "lazy"
    return {
      passed,
      evidence: passed
        ? `LCP <${lcp.tagName}> loading="${lcp.loadingAttr ?? "(not set)"}" — not lazy`
        : `LCP <${lcp.tagName}> has loading="lazy"`,
    }
  },
}

const responsiveControl: Control = {
  id: "images.responsive",
  topicId: 1,
  label: "Responsive images (srcset / sizes)",
  description: "At least one <img> uses srcset or sizes in raw HTML.",
  defaultPoints: 5,
  evaluate(e) {
    const imgTags = e.rawHtml.match(/<img\b[^>]*>/gi) ?? []
    const withSrcset = imgTags.filter((tag) => /\bsrcset\s*=/i.test(tag) || /\bsizes\s*=/i.test(tag)).length
    const passed = withSrcset > 0
    return {
      passed,
      evidence: passed
        ? `${withSrcset} <img> element(s) use srcset or sizes`
        : "No <img> with srcset or sizes found",
    }
  },
}

const compressedControl: Control = {
  id: "images.compressed",
  topicId: 1,
  label: "Well-compressed images (<250 KB each)",
  description: "No single image response exceeds 250 KB transferred (encodedBytes ≤ 256000).",
  defaultPoints: 5,
  evaluate(e) {
    const imgs = imageRequests(e)
    if (imgs.length === 0) {
      return { passed: true, evidence: "No image requests observed — criterion vacuously satisfied" }
    }
    const heaviest = imgs.reduce((max, r) => (r.encodedBytes > max.encodedBytes ? r : max), imgs[0]!)
    const passed = heaviest.encodedBytes <= 256000
    const kb = Math.round(heaviest.encodedBytes / 1024)
    return {
      passed,
      evidence: passed
        ? `Largest image is ${kb} KB (≤250 KB threshold) — ${imgs.length} image request(s)`
        : `Largest image is ${kb} KB (>250 KB threshold): ${heaviest.url}`,
    }
  },
}

const earlyHintControl: Control = {
  id: "images.earlyhint",
  topicId: 1,
  label: "Early hint / Link preload for LCP image",
  description: "Main response Link header contains rel=preload; as=image.",
  defaultPoints: 5,
  evaluate(e) {
    const linkHeader = e.mainResponseHeaders["link"] ?? ""
    // Split by comma to handle multiple link directives
    const directives = linkHeader.split(",")
    const preloadImageDirective = directives.find((d) => {
      return /rel\s*=\s*["']?preload["']?/i.test(d) && /as\s*=\s*["']?image["']?/i.test(d)
    })
    if (preloadImageDirective) {
      const snippet = preloadImageDirective.trim().substring(0, 120)
      return {
        passed: true,
        evidence: `Link header contains image preload: ${snippet}`,
      }
    }
    return {
      passed: false,
      evidence: linkHeader
        ? `Link header present but no image preload directive: ${linkHeader.substring(0, 80)}`
        : "No Link preload header",
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const imagesTopic: TopicModule = {
  id: 1,
  name: "Images management",
  hasNA: false,
  standalone: false,
  controls: [
    lazyloadControl,       // 30
    modernFormatControl,   // 20
    lcpPreloadControl,     // 15
    fixedHeightControl,    // 10
    lcpNotLazyControl,     // 10
    responsiveControl,     //  5
    compressedControl,     //  5
    earlyHintControl,      //  5
  ],
}
