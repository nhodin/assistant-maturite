/**
 * Topic 2 — Slider management
 * topicId: 2 | hasNA: true | standalone: false
 * Max points: 30+25+20+15+10 = 100
 *
 * Every control shares `sliderGate`, so the topic is N/A as a block.
 *
 * All markup-based controls are scoped to the SLIDER MARKUP (`sliderWindows`), never to
 * the whole page: otherwise the header logo validates "first image without JS", and the
 * LCP hero preload validates "preload next slider images".
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import type { ParsedTag } from "./util"
import { parseTags, headSlice } from "./util"

// ── slider markup scoping ─────────────────────────────────────────────────────

/** Tokens naming a slider container, mirroring the collector's detection selectors
 *  (`src/collector/index.ts`, sliderSelectors). */
const SLIDER_TOKEN = /(swiper|slick|glide|splide|carousel|slider|data-glide-el)/i

/** True if this opening tag names a slider through class/id/data-* — checked on the
 *  ATTRIBUTE VALUES only, never on free text, so prose about a "carousel" is ignored. */
function isSliderTag(rawTag: string): boolean {
  const attrs =
    rawTag.match(/(class|id|data-[-a-z0-9]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi) ?? []
  if (attrs.some((a) => SLIDER_TOKEN.test(a))) return true
  // `data-glide-el` (and friends) may appear as a valueless attribute.
  return /\sdata-glide-el\b/i.test(rawTag)
}

/**
 * Markup slices around each slider container found in the server HTML: for every opening
 * tag named like a slider, `html.slice(index, index + span)`.
 *
 * Nested containers (`.swiper` > `.swiper-wrapper` > `.swiper-slide`) would otherwise
 * yield near-identical windows, so a match already covered by the previous window is
 * skipped. Empty array = the slider exists only in the rendered DOM (JS-built).
 */
export function sliderWindows(html: string, span = 12000): string[] {
  const out: string[] = []
  if (!html) return out
  const re = /<[a-z][a-z0-9-]*\b[^>]*>/gi
  let m: RegExpExecArray | null
  let coveredUntil = -1
  while ((m = re.exec(html)) !== null) {
    if (m.index <= coveredUntil) continue
    if (!isSliderTag(m[0])) continue
    out.push(html.slice(m.index, m.index + span))
    coveredUntil = m.index + span - 1
  }
  return out
}

// ── URL matching (same rules as topics/video.ts) ───────────────────────────────

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

/** Loose URL equality (exact, same pathname, or same filename) to tolerate
 *  CDN/query variance between a preload href and a slide URL. */
function looseUrlMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const pa = urlParts(a)
  const pb = urlParts(b)
  if (pa.pathname && pa.pathname === pb.pathname) return true
  if (pa.lastSeg && pa.lastSeg === pb.lastSeg) return true
  return false
}

/** True for a URL a client can actually fetch: non-empty, not a data: placeholder. */
function realUrl(u: string): boolean {
  const v = u.trim()
  return v.length > 0 && !/^data:/i.test(v)
}

/** Every candidate URL of a srcset-style attribute value. */
function srcsetUrls(value: string): string[] {
  const out: string[] = []
  for (const entry of (value ?? "").split(",")) {
    const url = entry.trim().split(/\s+/)[0] ?? ""
    if (realUrl(url)) out.push(url)
  }
  return out
}

/** All image URLs a tag references, JS-driven attributes included. Used to decide
 *  MEMBERSHIP in the slider ("is this image a slide?"), not how it loads. */
function allImageUrls(t: ParsedTag): string[] {
  const out: string[] = []
  for (const attr of ["src", "data-src", "data-lazy", "data-lazy-src", "data-original"]) {
    const v = (t.attrs[attr] ?? "").trim()
    if (realUrl(v)) out.push(v)
  }
  for (const attr of ["srcset", "data-srcset", "data-lazy-srcset"]) {
    out.push(...srcsetUrls(t.attrs[attr] ?? ""))
  }
  return out
}

/** Every image URL referenced inside the slider markup (`<img>` + `<source srcset>`). */
function sliderImageUrls(windows: string[]): string[] {
  const out: string[] = []
  for (const win of windows) {
    for (const t of parseTags(win, "img")) out.push(...allImageUrls(t))
    for (const t of parseTags(win, "source")) {
      out.push(...srcsetUrls(t.attrs["srcset"] ?? ""))
      out.push(...srcsetUrls(t.attrs["data-srcset"] ?? ""))
    }
  }
  return out
}

/** True if `url` designates one of the slider's images (loose match). */
function isSliderImageUrl(url: string, sliderUrls: string[]): boolean {
  return sliderUrls.some((u) => looseUrlMatch(url, u))
}

/**
 * Is the LCP element one of the slider's images?
 *   null  = not decidable (no LCP element captured, or it carries no src)
 *   true  = the LCP image belongs to the slider markup
 *   false = the LCP is some other image/element
 */
export function lcpIsSliderImage(e: EvidenceBundle): boolean | null {
  const lcp = e.perf.lcpElement
  const src = (lcp?.src ?? "").trim()
  if (!lcp || src.length === 0) return null
  return isSliderImageUrl(src, sliderImageUrls(sliderWindows(e.rawHtml)))
}

// ── topic gate ────────────────────────────────────────────────────────────────

/**
 * The topic applies only when the slider IS the page's main display. A slider far below
 * the fold (a "you may also like" rail, a footer logo strip) is not what these criteria
 * describe: preloading its next slide would steal bandwidth from the real LCP, and its
 * images SHOULD be lazyloaded. Grading it would penalise a correct decision, so the
 * topic goes N/A instead of failing — same reasoning as `videoGate` in topics/video.ts.
 *
 * Decision table:
 *   - `features.sliderDetected !== true` → N/A: there is no slider at all.
 *   - no slider markup in the server HTML → APPLIES. The slider is 100% JS-built, which
 *     is precisely what `slider.firstimgnojs` must fail on; going N/A would reward it.
 *   - `lcpIsSliderImage === null` (LCP unknown / no src) → APPLIES. "Not measured" is
 *     not "not the main display" (same convention as `videoInViewport === undefined`).
 *   - `lcpIsSliderImage === false` → N/A: the LCP is elsewhere, the slider is secondary.
 *   - `lcpIsSliderImage === true` → APPLIES: the slider paints the largest element.
 */
function sliderGate(e: EvidenceBundle): boolean {
  if (e.features.sliderDetected !== true) return false
  if (sliderWindows(e.rawHtml).length === 0) return true
  const lcpInSlider = lcpIsSliderImage(e)
  if (lcpInSlider === null) return true
  return lcpInSlider
}

/** Evidence string used whenever the slider has no server-rendered markup at all. */
const NO_MARKUP =
  "slider detected in rendered DOM but no slider markup in server HTML — first image requires JS"

// ── controls ─────────────────────────────────────────────────────────────────

const firstImgNoJs: Control = {
  id: "slider.firstimgnojs",
  topicId: 2,
  label: "First slide image in server HTML (no JS required)",
  description:
    "At least one <img> with a real src (http/https or root-relative, not data:) inside the slider markup of the raw HTML.",
  defaultPoints: 30,
  appliesTo: sliderGate,
  evaluate(e) {
    const windows = sliderWindows(e.rawHtml)
    if (windows.length === 0) {
      return { passed: false, evidence: NO_MARKUP }
    }
    const imgs = windows.flatMap((w) => parseTags(w, "img"))
    const realSrcImgs = imgs.filter((img) => {
      const src = img.attrs["src"] ?? ""
      return (
        src.length > 0 &&
        !src.startsWith("data:") &&
        (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("/"))
      )
    })
    const count = realSrcImgs.length
    const passed = count > 0
    return {
      passed,
      evidence: passed
        ? `${count} <img> element(s) with real src found in the slider markup (${windows.length} slider container(s) in raw HTML)`
        : `No <img> with a real (non-data:) src found in the slider markup (${windows.length} slider container(s) in raw HTML)`,
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
      return {
        passed: false,
        unknown: true,
        evidence: "À confirmer : CLS non mesuré sur cette capture (CLS not measured)",
      }
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
    'The slider markup contains at least one <img loading="lazy"> or an <img> with a data-src/data-lazy attribute.',
  defaultPoints: 20,
  appliesTo: sliderGate,
  evaluate(e) {
    const windows = sliderWindows(e.rawHtml)
    if (windows.length === 0) {
      return {
        passed: false,
        evidence:
          "slider detected in rendered DOM but no slider markup in server HTML — no slide image to lazyload server-side",
      }
    }
    const imgs = windows.flatMap((w) => parseTags(w, "img"))

    const lazyCount = imgs.filter(
      (img) => (img.attrs["loading"] ?? "").toLowerCase() === "lazy",
    ).length
    const dataSrcCount = imgs.filter(
      (img) => img.attrs["data-src"] !== undefined || img.attrs["data-lazy"] !== undefined,
    ).length

    const passed = lazyCount > 0 || dataSrcCount > 0
    if (!passed) {
      return {
        passed: false,
        evidence: `No <img loading="lazy"> or data-src/data-lazy attribute in the slider markup (${windows.length} slider container(s))`,
      }
    }
    const parts: string[] = []
    if (lazyCount > 0) parts.push(`${lazyCount} <img loading="lazy">`)
    if (dataSrcCount > 0) parts.push(`${dataSrcCount} <img data-src/data-lazy>`)
    return { passed: true, evidence: parts.join("; ") + " found in the slider markup" }
  },
}

const delayNext: Control = {
  id: "slider.delaynext",
  topicId: 2,
  label: "Delay next slide loading after onload",
  description:
    "At least one image of the slider is fetched ONLY after a synthetic user/browser interaction (phase=interaction), not during initial load — deferred next-slide loading.",
  defaultPoints: 15,
  appliesTo: sliderGate,
  evaluate(e) {
    const windows = sliderWindows(e.rawHtml)
    if (windows.length === 0) {
      return {
        passed: false,
        evidence:
          "slider detected in rendered DOM but no slider markup in server HTML — no slide URL to match a deferred image against",
      }
    }
    const sliderUrls = sliderImageUrls(windows)

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
        !loadedImgs.has(req.url) &&
        isSliderImageUrl(req.url, sliderUrls),
    )

    const passed = deferred.length > 0
    return {
      passed,
      evidence: passed
        ? `${deferred.length} slider image(s) loaded only after user/browser interaction (deferred next-slide loading)`
        : "no image of the slider markup loaded only after synthetic user/browser interaction",
    }
  },
}

const preloadNext: Control = {
  id: "slider.preloadnext",
  topicId: 2,
  label: "Preload next slider images",
  description:
    'A <link rel="preload" as="image"> in <head> whose href matches an image of the slider markup.',
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
    if (preloadImageLinks.length === 0) {
      return {
        passed: false,
        evidence: 'No <link rel="preload" as="image"> found in <head>',
      }
    }

    const windows = sliderWindows(e.rawHtml)
    if (windows.length === 0) {
      return {
        passed: false,
        evidence: `${preloadImageLinks.length} <link rel="preload" as="image"> in <head>, but no slider markup in server HTML to match them against`,
      }
    }

    const sliderUrls = sliderImageUrls(windows)
    const match = preloadImageLinks.find((link) =>
      isSliderImageUrl(link.attrs["href"] ?? "", sliderUrls),
    )
    if (!match) {
      return {
        passed: false,
        evidence: `${preloadImageLinks.length} <link rel="preload" as="image"> in <head>, but none targets an image of the slider markup`,
      }
    }
    return {
      passed: true,
      evidence: `<link rel="preload" as="image"> targets a slider image (href="${match.attrs["href"] ?? ""}")`,
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
