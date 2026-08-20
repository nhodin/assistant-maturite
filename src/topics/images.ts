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

/** Value of a single attribute inside a tag string (quoted), or "" if absent. */
function attrValue(tag: string, attr: string): string {
  const m = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"|\\b${attr}\\s*=\\s*'([^']*)'`, "i").exec(tag)
  return m ? (m[1] ?? m[2] ?? "") : ""
}

/** Pathname (lowercased) and last path segment of a URL — tolerant of relative
 *  and protocol-relative URLs commonly seen in markup. */
function urlParts(u: string): { pathname: string; lastSeg: string } {
  let pathname = u
  try {
    const withProto = u.startsWith("//") ? "https:" + u : u
    pathname = /^[a-z]+:\/\//i.test(withProto)
      ? new URL(withProto).pathname
      : (u.split(/[?#]/)[0] ?? u)
  } catch {
    pathname = u.split(/[?#]/)[0] ?? u
  }
  const lastSeg = pathname.split("/").filter(Boolean).pop() ?? ""
  return { pathname: pathname.toLowerCase(), lastSeg: lastSeg.toLowerCase() }
}

/**
 * Loose URL equality to tolerate CDN/query variance between a preload href and
 * the resolved LCP/poster image URL: exact match, OR same pathname, OR same last
 * path segment (filename).
 */
function looseUrlMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const pa = urlParts(a)
  const pb = urlParts(b)
  if (pa.pathname && pa.pathname === pb.pathname) return true
  if (pa.lastSeg && pa.lastSeg === pb.lastSeg) return true
  return false
}

/** The value of a tag's style="..." attribute, or "" if absent. */
function styleAttrValue(tag: string): string {
  const m = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/i.exec(tag)
  return m ? (m[1] ?? m[2] ?? "") : ""
}

function countImgsWithBothDimensions(html: string): number {
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? []
  return imgTags.filter((tag) => {
    const style = styleAttrValue(tag)
    // HTML attributes (width=/height=) OR equivalent CSS properties set inline
    // (style="width:...;height:...") — both fix the box before the image loads.
    const hasWidth = /\bwidth\s*=/i.test(tag) || /(?:^|;)\s*width\s*:/i.test(style)
    const hasHeight = /\bheight\s*=/i.test(tag) || /(?:^|;)\s*height\s*:/i.test(style)
    // aspect-ratio as a genuine CSS property (requires the colon) rather than a
    // loose substring match, which would false-positive on class names like
    // "aspect-ratio-container" that carry no actual aspect-ratio declaration.
    const hasAspectRatio = /aspect-ratio\s*:/i.test(style)
    return (hasWidth && hasHeight) || hasAspectRatio
  }).length
}

// ── controls ─────────────────────────────────────────────────────────────────

const lazyloadControl: Control = {
  id: "images.lazyload",
  topicId: 1,
  label: "Basic lazy-loading",
  description:
    'At least one lazy-loaded <img>: native (loading="lazy") or JS-driven (data-src/data-lazy with no eager src).',
  defaultPoints: 30,
  evaluate(e) {
    const imgTags = e.rawHtml.match(/<img\b[^>]*>/gi) ?? []
    const nativeCount = imgTags.filter((tag) => /\bloading\s*=\s*["']?lazy["']?/i.test(tag)).length
    // JS-lazyload pattern (as detected by the slider topic): an <img> carrying
    // data-src/data-lazy and NO eager src — the real URL is swapped in by script.
    const jsLazyCount = imgTags.filter((tag) => {
      const hasDataSrc = /\bdata-src\s*=/i.test(tag) || /\bdata-lazy\s*=/i.test(tag)
      if (!hasDataSrc) return false
      // A real `src` attribute is preceded by whitespace inside the tag; this
      // avoids matching the "src" substring inside "data-src".
      const eagerSrc = /\ssrc\s*=\s*["']?[^"'\s>]/i.test(tag)
      return !eagerSrc
    }).length
    const passed = nativeCount + jsLazyCount > 0
    if (!passed) {
      return { passed: false, evidence: 'No lazy-loaded <img> (loading="lazy" or data-src/data-lazy) found in raw HTML' }
    }
    const parts: string[] = []
    if (nativeCount > 0) parts.push(`${nativeCount} <img loading="lazy">`)
    if (jsLazyCount > 0) parts.push(`${jsLazyCount} <img data-src/data-lazy>`)
    return { passed: true, evidence: parts.join("; ") + " found in raw HTML" }
  },
}

const modernFormatControl: Control = {
  id: "images.modernformat",
  topicId: 1,
  label: "Modern image format (WebP / AVIF)",
  description:
    "Majority (>50%) of content-image responses use image/webp or image/avif content-type. SVGs and tiny images (≤1 KB tracking pixels/icons) are excluded from both numerator and denominator.",
  defaultPoints: 20,
  evaluate(e) {
    const imgs = imageRequests(e)
    if (imgs.length === 0) {
      return { passed: false, evidence: "No image requests observed" }
    }
    // Restrict to "content pictures": drop SVGs and tiny (≤1 KB) images, which are
    // vector/icon/tracking assets that this criterion is not about.
    const isNonContent = (r: NetworkRequest): boolean =>
      r.mimeType === "image/svg+xml" || (r.encodedBytes > 0 && r.encodedBytes <= 1024)
    let set = imgs.filter((r) => !isNonContent(r))
    let fellBack = false
    if (set.length === 0) {
      set = imgs
      fellBack = true
    }
    const modernCount = set.filter((r) => isModernImageMime(r.mimeType)).length
    const pct = Math.round((modernCount / set.length) * 100)
    const passed = modernCount / set.length > 0.5
    const label = fellBack ? "image" : "content image"
    return {
      passed,
      evidence:
        `${modernCount}/${set.length} ${label} responses are webp/avif (${pct}%)` +
        (fellBack ? " — fallback to unfiltered set (all images were svg/tiny)" : ""),
    }
  },
}

const lcpPreloadControl: Control = {
  id: "images.lcppreload",
  topicId: 1,
  label: "LCP image preloaded with fetchpriority=high",
  description:
    "LCP element has fetchpriority=high, or a <link rel=preload as=image fetchpriority=high> preloads the LCP image (href loosely matched against the LCP src when known).",
  defaultPoints: 15,
  evaluate(e) {
    // Check 1 (strongest signal): LCP element itself has fetchpriority=high.
    if (e.perf.lcpElement?.fetchPriorityAttr === "high") {
      return {
        passed: true,
        evidence: `LCP element (${e.perf.lcpElement.tagName}) has fetchpriority="high" attribute`,
      }
    }
    // Check 2: a <link rel="preload" as="image" fetchpriority="high"> in rawHtml.
    const preloadLinks = e.rawHtml.match(/<link\b[^>]*>/gi) ?? []
    const imagePreloads = preloadLinks.filter((tag) => {
      const isPreload = /\brel\s*=\s*["']?preload["']?/i.test(tag)
      const isImage = /\bas\s*=\s*["']?image["']?/i.test(tag)
      const isHighPriority = /\bfetchpriority\s*=\s*["']?high["']?/i.test(tag)
      return isPreload && isImage && isHighPriority
    })
    if (imagePreloads.length === 0) {
      return {
        passed: false,
        evidence: "No fetchpriority=high on LCP element and no <link rel=preload as=image fetchpriority=high> found",
      }
    }
    const lcpSrc = e.perf.lcpElement?.src
    if (lcpSrc) {
      const matching = imagePreloads.find((tag) => looseUrlMatch(attrValue(tag, "href"), lcpSrc))
      if (matching) {
        return {
          passed: true,
          evidence: `<link rel=preload as=image fetchpriority=high> preloads the LCP image (href="${attrValue(matching, "href")}")`,
        }
      }
      return {
        passed: false,
        evidence: `${imagePreloads.length} image preload link(s) present but none match the LCP image (${lcpSrc})`,
      }
    }
    // LCP URL unknown — fall back to the weaker any-image-preload signal.
    return {
      passed: true,
      evidence:
        "Found <link rel=preload as=image fetchpriority=high> in raw HTML — LCP URL unknown — weak match on any image preload",
    }
  },
}

const fixedHeightControl: Control = {
  id: "images.fixedheight",
  topicId: 1,
  label: "Fixed width & height on images (CLS prevention)",
  description:
    "Validated directly when the measured page CLS is < 0.01 (image sizing is demonstrably handled). Otherwise ≥60% of <img> elements must have both width and height reserved — via HTML attributes, equivalent inline CSS (style=\"width:...;height:...\"), or an inline aspect-ratio declaration.",
  defaultPoints: 10,
  evaluate(e) {
    // A page with virtually no layout shift proves the images are sized correctly,
    // whatever mechanism is used (attributes, CSS classes, aspect-ratio, containers).
    const cls = e.perf.cls
    if (cls !== null && cls < 0.01) {
      return { passed: true, evidence: `CLS = ${cls} (< 0.01) — image sizing considered handled` }
    }
    const imgTags = e.rawHtml.match(/<img\b[^>]*>/gi) ?? []
    const total = imgTags.length
    if (total === 0) {
      return { passed: true, evidence: "No <img> tags found — criterion vacuously satisfied" }
    }
    const withDimensions = countImgsWithBothDimensions(e.rawHtml)
    const pct = Math.round((withDimensions / total) * 100)
    const passed = withDimensions / total >= 0.6
    const clsNote = cls === null ? "CLS not measured" : `CLS = ${cls} (≥ 0.01)`
    return {
      passed,
      evidence: `${clsNote} — ${withDimensions}/${total} <img> tags have width+height (or aspect-ratio) = ${pct}%`,
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
  description:
    "No single image response with an observed transfer size exceeds 250 KB (encodedBytes ≤ 256000). Cached responses (encodedBytes = 0) are ignored.",
  defaultPoints: 5,
  evaluate(e) {
    const imgs = imageRequests(e)
    if (imgs.length === 0) {
      return { passed: true, evidence: "No image requests observed — criterion vacuously satisfied" }
    }
    // encodedBytes is 0 for cached/unknown responses — those tell us nothing about
    // transfer weight, so exclude them rather than silently pass on a 0 "size".
    const withBytes = imgs.filter((r) => r.encodedBytes > 0)
    if (withBytes.length === 0) {
      return {
        passed: true,
        evidence: "no image transfer sizes observed (all cached/unknown) — low confidence",
      }
    }
    const heaviest = withBytes.reduce((max, r) => (r.encodedBytes > max.encodedBytes ? r : max), withBytes[0]!)
    const passed = heaviest.encodedBytes <= 256000
    const kb = Math.round(heaviest.encodedBytes / 1024)
    return {
      passed,
      evidence: passed
        ? `Largest image is ${kb} KB (≤250 KB threshold) — ${withBytes.length} image request(s) with sizes`
        : `Largest image is ${kb} KB (>250 KB threshold): ${heaviest.url}`,
    }
  },
}

function findImagePreloadDirective(linkHeader: string): string | undefined {
  // Split on commas that separate directives (each directive starts with "<uri>"),
  // not on commas inside a URL — hence the lookahead for the next "<".
  return linkHeader.split(/,(?=\s*<)/).find((d) => {
    return /rel\s*=\s*["']?preload["']?/i.test(d) && /as\s*=\s*["']?image["']?/i.test(d)
  })
}

const earlyHintControl: Control = {
  id: "images.earlyhint",
  topicId: 1,
  label: "Early hint / Link preload for LCP image",
  description: "Main response Link header, or a 103 Early Hints response, contains rel=preload; as=image.",
  defaultPoints: 5,
  evaluate(e) {
    const linkHeader = e.mainResponseHeaders["link"] ?? ""
    const preloadImageDirective = findImagePreloadDirective(linkHeader)
    if (preloadImageDirective) {
      const snippet = preloadImageDirective.trim().substring(0, 120)
      return {
        passed: true,
        evidence: `Link header contains image preload: ${snippet}`,
      }
    }
    const earlyHintsLink = e.earlyHints?.["link"] ?? ""
    const earlyHintsPreloadImage = findImagePreloadDirective(earlyHintsLink)
    if (earlyHintsPreloadImage) {
      const snippet = earlyHintsPreloadImage.trim().substring(0, 120)
      return {
        passed: true,
        evidence: `103 Early Hints Link header contains image preload: ${snippet}`,
      }
    }
    return {
      passed: false,
      evidence: linkHeader
        ? `No Link header preload; header present but no image preload directive: ${linkHeader.substring(0, 80)}`
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
