/**
 * Topic 3 — Video management
 * topicId: 3 | hasNA: true | standalone: false
 * Max points: 30+25+20+10+10+5 = 100
 *
 * Every control declares appliesTo: videoGate. When no video is present — or when
 * every video sits below the fold and none is the LCP — the engine marks the whole
 * topic N/A and it is excluded from the Overall average.
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import type { ParsedTag } from "./util"
import { parseTags, headSlice, sameSite, requestsOfType, host } from "./util"

/**
 * The topic gate. A video only deserves to be graded when it is on the critical path:
 * it sits in the initial viewport, or it (or its poster) IS the LCP element.
 *
 * None of these criteria describe good practice for a below-the-fold video — poster
 * preloading would steal bandwidth from the real LCP, reserving space and eager
 * poster markup buy nothing, and a deferred player is exactly what such a video
 * should do. Scoring it would penalise a site for a correct decision, so the whole
 * topic goes N/A (excluded from the topic max AND from the Overall average) instead
 * of failing.
 *
 * `videoInViewport === undefined` means "not measured" (evidence captured before the
 * collector reported it) — the topic then applies, preserving historical verdicts.
 */
function videoGate(e: EvidenceBundle): boolean {
  if (e.features.videoDetected !== true) return false
  if (e.features.videoInViewport !== false) return true
  return lcpIsVideoOrPoster(e)
}

/** True if the LCP element is the <video> itself, or the poster painted over it. */
function lcpIsVideoOrPoster(e: EvidenceBundle): boolean {
  const lcp = e.perf.lcpElement
  if (!lcp) return false
  if (lcp.tagName.toUpperCase() === "VIDEO") return true
  const poster = resolvePosterEvidence(e.rawHtml)
  if (!poster) return false
  const src = lcp.src ?? ""
  return src.length > 0 && poster.urls.some((u) => looseUrlMatch(src, u))
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

/** Loose URL equality (exact, same pathname, or same filename) to tolerate
 *  CDN/query variance between a preload href and a poster URL. */
function looseUrlMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const pa = urlParts(a)
  const pb = urlParts(b)
  if (pa.pathname && pa.pathname === pb.pathname) return true
  if (pa.lastSeg && pa.lastSeg === pb.lastSeg) return true
  return false
}

/** Known third-party video hosting domains (iframe embeds). */
const THIRD_PARTY_VIDEO_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "dailymotion.com",
  "wistia.com",
  "brightcove.com",
  "kaltura.com",
]

/** Known video player CDN / script domains (for preconnect check). */
const VIDEO_PLAYER_DOMAINS = [
  "youtube.com",
  "ytimg.com",
  "vimeo.com",
  "brightcove.com",
  "jwplayer.com",
  "players.brightcove.net",
]

// ── poster resolution ─────────────────────────────────────────────────────────
//
// A poster does not have to be `<video poster>`. The common modern pattern (seen on
// louisvuitton.com) stacks a <picture> OVER the <video> as a sibling and hides it once
// the video is ready. That poster still paints without JS — as long as the HTML parser
// alone can resolve its URL — so it must validate the criterion.
//
// The trap: such an <img> often carries a transparent base64 GIF in `src` (a placeholder)
// and the real URLs only in `srcset`. srcset alone is enough for the parser, so the URL
// resolution below accepts it; `data-src`/`data-srcset` are NOT accepted (they need JS).

/** Tokens marking an element as the video's poster layer, matched on class/id/data-*
 *  as whole words — so "discover" never counts as "cover". */
const POSTER_TOKEN = /(^|[^a-z])(poster|cover|placeholder|fallback|still|preview)([^a-z]|$)/i

/** True for a URL the parser can fetch: non-empty and not a data: placeholder. */
function realUrl(u: string): boolean {
  const v = u.trim()
  return v.length > 0 && !/^data:/i.test(v)
}

/** URLs an <img>/<source> resolves without JS: a real src, plus every real srcset
 *  candidate. Empty when the tag only carries a data: placeholder or data-* attrs. */
function urlsWithoutJs(t: ParsedTag): string[] {
  const out: string[] = []
  const src = (t.attrs["src"] ?? "").trim()
  if (realUrl(src)) out.push(src)
  for (const entry of (t.attrs["srcset"] ?? "").split(",")) {
    const url = entry.trim().split(/\s+/)[0] ?? ""
    if (realUrl(url)) out.push(url)
  }
  return out
}

/** Markup surrounding each <video>: the overlay is a sibling, almost always emitted
 *  BEFORE the video, hence the asymmetric window. */
function videoWindows(html: string, before = 4000, after = 1000): string[] {
  const out: string[] = []
  const re = /<video\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    out.push(html.slice(Math.max(0, m.index - before), m.index + after))
  }
  return out
}

/** True if some element in this window is named like a poster layer. Checked on
 *  class/id/data-* attributes only, never on free text. */
function hasPosterHint(html: string): boolean {
  const tags = html.match(/<[a-z][^>]*>/gi) ?? []
  return tags.some((raw) =>
    (raw.match(/(class|id|data-[-a-z0-9]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi) ?? []).some(
      (attr) => POSTER_TOKEN.test(attr),
    ),
  )
}

/** Image candidates in a window: every <img>, plus <source srcset> (a <picture>
 *  source). <source src> is excluded — inside <video> that is the video file itself. */
function imageCandidates(html: string): { tag: string; t: ParsedTag }[] {
  return [
    ...parseTags(html, "img").map((t) => ({ tag: "img", t })),
    ...parseTags(html, "source")
      .filter((t) => (t.attrs["srcset"] ?? "").trim().length > 0)
      .map((t) => ({ tag: "source", t })),
  ]
}

export interface PosterEvidence {
  /** "attribute" = <video poster>, "overlay" = stacked <picture>/<img>, "noscript". */
  kind: "attribute" | "overlay" | "noscript"
  /** Every URL resolvable without JS (src + srcset candidates), for preload matching. */
  urls: string[]
  /** Human-readable justification, embedded in the control evidence. */
  detail: string
}

/**
 * Poster(s) a browser paints without running any JS, in priority order:
 *   1. <video poster="…">
 *   2. an overlay <img>/<picture> next to a <video>, in a poster-named container
 *   3. a <noscript><img> fallback in the same window
 * Shared by video.posternojs and video.preloadposter so both judge the same poster.
 */
export function resolvePosterEvidence(rawHtml: string): PosterEvidence | null {
  const attributeUrls = parseTags(rawHtml, "video")
    .map((v) => (v.attrs["poster"] ?? "").trim())
    .filter((p) => p.length > 0)
  if (attributeUrls.length > 0) {
    return {
      kind: "attribute",
      urls: attributeUrls,
      detail: `${attributeUrls.length} <video> element(s) with a poster attribute found in raw HTML`,
    }
  }

  for (const win of videoWindows(rawHtml)) {
    if (hasPosterHint(win)) {
      const hit = imageCandidates(win)
        .map(({ tag, t }) => ({ tag, t, urls: urlsWithoutJs(t) }))
        .find((c) => c.urls.length > 0)
      if (hit) {
        const via = realUrl(hit.t.attrs["src"] ?? "") ? "src" : "srcset"
        return {
          kind: "overlay",
          urls: hit.urls,
          detail: `poster overlay <${hit.tag}> stacked on a <video>, resolvable via ${via} without JS: ${hit.urls[0]!.substring(0, 80)}`,
        }
      }
    }
    const noscript = /<noscript\b[^>]*>([\s\S]*?)<\/noscript>/i.exec(win)
    if (noscript) {
      const hit = imageCandidates(noscript[1] ?? "")
        .map(({ t }) => urlsWithoutJs(t))
        .find((urls) => urls.length > 0)
      if (hit) {
        return {
          kind: "noscript",
          urls: hit,
          detail: `<noscript> <img> fallback in the video container: ${hit[0]!.substring(0, 80)}`,
        }
      }
    }
  }
  return null
}

// ── controls ─────────────────────────────────────────────────────────────────

const posterNoJs: Control = {
  id: "video.posternojs",
  topicId: 3,
  label: "Poster image loaded without JS",
  description:
    "A poster the HTML parser resolves on its own is present in raw HTML: <video poster>, an overlay <picture>/<img> stacked on the video, or a <noscript> fallback.",
  defaultPoints: 30,
  appliesTo: videoGate,
  evaluate(e) {
    const poster = resolvePosterEvidence(e.rawHtml)
    if (!poster) {
      return {
        passed: false,
        evidence:
          "No <video poster>, and no overlay/<noscript> image resolvable without JS near a <video> in raw HTML",
      }
    }
    return {
      passed: true,
      evidence:
        poster.kind === "attribute"
          ? poster.detail
          : `No <video poster>, but ${poster.detail} — renders without JS`,
    }
  },
}

const reservedSpace: Control = {
  id: "video.reservedspace",
  topicId: 3,
  label: "Reserved space for video + same-sized poster (CLS < 0.05)",
  description: "CLS is measured and below 0.05.",
  defaultPoints: 25,
  appliesTo: videoGate,
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

const preloadPoster: Control = {
  id: "video.preloadposter",
  topicId: 3,
  label: "Poster image preloaded with fetchpriority=high",
  description:
    'A <link rel="preload" as="image" fetchpriority="high"> in <head> preloads the poster (href loosely matched against the poster URLs resolvable without JS).',
  defaultPoints: 20,
  appliesTo: videoGate,
  evaluate(e) {
    const head = headSlice(e.rawHtml)
    const links = parseTags(head, "link")
    const imagePreloads = links.filter(
      (link) =>
        (link.attrs["rel"] ?? "").toLowerCase() === "preload" &&
        (link.attrs["as"] ?? "").toLowerCase() === "image" &&
        (link.attrs["fetchpriority"] ?? "").toLowerCase() === "high",
    )
    if (imagePreloads.length === 0) {
      return {
        passed: false,
        evidence:
          'No <link rel="preload" as="image" fetchpriority="high"> found in <head>',
      }
    }
    // Poster URLs the parser resolves on its own — <video poster>, or the overlay
    // <picture>/<img> pattern (same resolution as video.posternojs, so a site whose
    // poster is an overlay is matched here too instead of falling to the weak signal).
    const poster = resolvePosterEvidence(e.rawHtml)
    if (poster) {
      const match = imagePreloads.find((link) =>
        poster.urls.some((p) => looseUrlMatch(link.attrs["href"] ?? "", p)),
      )
      if (match) {
        return {
          passed: true,
          evidence: `<link rel=preload as=image fetchpriority=high> preloads the ${poster.kind === "attribute" ? "<video poster>" : `${poster.kind} poster`} (href="${match.attrs["href"] ?? ""}")`,
        }
      }
      return {
        passed: false,
        evidence: `image preload present in <head> but none of its href(s) match a poster URL (${poster.kind})`,
      }
    }
    // No poster to match against — keep the weaker any-image-preload signal.
    return {
      passed: true,
      evidence:
        '<link rel="preload" as="image" fetchpriority="high"> found in <head> — no poster resolvable without JS to match — weak match on any image preload',
    }
  },
}

const selfHosted: Control = {
  id: "video.selfhosted",
  topicId: 3,
  label: "Self-hosting video",
  description:
    "A <video>/<source> src is same-site, OR a first-party media network request is present.",
  defaultPoints: 10,
  appliesTo: videoGate,
  evaluate(e) {
    // Check <video src="..."> and <source src="..."> in raw HTML
    const videoTags = parseTags(e.rawHtml, "video")
    const sourceTags = parseTags(e.rawHtml, "source")
    const allSrcs = [
      ...videoTags.map((v) => v.attrs["src"] ?? ""),
      ...sourceTags.map((s) => s.attrs["src"] ?? ""),
    ].filter((src) => src.length > 0)

    for (const src of allSrcs) {
      if (sameSite(src, e.finalUrl)) {
        return {
          passed: true,
          evidence: `<video>/<source> src is same-site: ${src.substring(0, 80)}`,
        }
      }
    }

    // Check first-party media requests
    const mediaRequests = requestsOfType(e.requests, "media")
    const firstPartyMedia = mediaRequests.filter((r) => sameSite(r.url, e.finalUrl))
    if (firstPartyMedia.length > 0) {
      return {
        passed: true,
        evidence: `${firstPartyMedia.length} first-party media request(s) observed`,
      }
    }

    // Check if only third-party iframes are present (youtube/vimeo)
    const iframeTags = parseTags(e.rawHtml, "iframe")
    const thirdPartyVideoIframes = iframeTags.filter((iframe) => {
      const src = iframe.attrs["src"] ?? ""
      return THIRD_PARTY_VIDEO_DOMAINS.some((domain) => src.includes(domain))
    })
    if (thirdPartyVideoIframes.length > 0) {
      return {
        passed: false,
        evidence: `Only third-party video iframe(s) detected (${thirdPartyVideoIframes.length} iframe(s) from youtube/vimeo/etc); no self-hosted video`,
      }
    }

    return {
      passed: false,
      evidence:
        "No same-site <video>/<source> src or first-party media requests found",
    }
  },
}

/** Hosts that signal a video player (script bundles or iframe embeds). */
const VIDEO_HOST_HINTS = [...VIDEO_PLAYER_DOMAINS, ...THIRD_PARTY_VIDEO_DOMAINS]

function isVideoPlayerHost(url: string): boolean {
  const h = host(url)
  if (!h) return false
  return VIDEO_HOST_HINTS.some((d) => h === d || h.endsWith("." + d))
}

const playerJs: Control = {
  id: "video.playerjs",
  topicId: 3,
  label: "Fine-tune video player JS loading",
  description:
    "Video player scripts/iframes load ONLY after a synthetic user/browser interaction (phase=interaction) — facade/deferred pattern — instead of eagerly during initial load.",
  defaultPoints: 10,
  appliesTo: videoGate,
  evaluate(e) {
    // Video-player hosts already fetched eagerly during the quiet initial load.
    const loadedEarly = new Set<string>()
    for (const req of e.requests) {
      if (req.phase === "interaction") continue
      if (isVideoPlayerHost(req.url)) loadedEarly.add(host(req.url))
    }

    const deferred = e.requests.filter(
      (req) =>
        req.phase === "interaction" &&
        ["script", "document", "xhr", "fetch"].includes(req.resourceType) &&
        isVideoPlayerHost(req.url) &&
        !loadedEarly.has(host(req.url)),
    )

    const passed = deferred.length > 0
    const hosts = [...new Set(deferred.map((r) => host(r.url)))]
    return {
      passed,
      evidence: passed
        ? `${deferred.length} video player request(s) deferred to user/browser interaction: ${hosts.slice(0, 4).join(", ")}`
        : "no video player script/iframe loaded only after synthetic user/browser interaction",
    }
  },
}

const preconnect: Control = {
  id: "video.preconnect",
  topicId: 3,
  label: "preconnect to video player domains",
  description:
    "A <link rel=\"preconnect\"> or <link rel=\"dns-prefetch\"> to a known video domain exists in <head>.",
  defaultPoints: 5,
  appliesTo: videoGate,
  evaluate(e) {
    const head = headSlice(e.rawHtml)
    const links = parseTags(head, "link")
    const match = links.find((link) => {
      const rel = (link.attrs["rel"] ?? "").toLowerCase()
      const href = (link.attrs["href"] ?? "").toLowerCase()
      const isPreconnectOrDns =
        rel === "preconnect" || rel === "dns-prefetch"
      const isVideoDomain = VIDEO_PLAYER_DOMAINS.some((domain) =>
        href.includes(domain),
      )
      return isPreconnectOrDns && isVideoDomain
    })
    if (match) {
      const rel = match.attrs["rel"] ?? "preconnect"
      const href = match.attrs["href"] ?? ""
      return {
        passed: true,
        evidence: `<link rel="${rel}" href="${href}"> to video domain found in <head>`,
      }
    }
    return {
      passed: false,
      evidence:
        "No <link rel=\"preconnect\"> or dns-prefetch to a known video player domain found in <head>",
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const videoTopic: TopicModule = {
  id: 3,
  name: "Video management",
  hasNA: true,
  standalone: false,
  controls: [
    posterNoJs,     // 30
    reservedSpace,  // 25
    preloadPoster,  // 20
    selfHosted,     // 10
    playerJs,       // 10
    preconnect,     //  5
  ],
}
