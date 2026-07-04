/**
 * Topic 3 — Video management
 * topicId: 3 | hasNA: true | standalone: false
 * Max points: 30+25+20+10+10+5 = 100
 *
 * Every control declares appliesTo: (e) => e.features.videoDetected === true.
 * When no video is present the engine marks the topic N/A.
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import { parseTags, headSlice, sameSite, requestsOfType, host } from "./util"

const videoGate = (e: EvidenceBundle): boolean => e.features.videoDetected === true

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

// ── controls ─────────────────────────────────────────────────────────────────

const posterNoJs: Control = {
  id: "video.posternojs",
  topicId: 3,
  label: "Poster image loaded without JS",
  description:
    "A <video> tag with a non-empty poster attribute is present in raw HTML.",
  defaultPoints: 30,
  appliesTo: videoGate,
  evaluate(e) {
    const videos = parseTags(e.rawHtml, "video")
    const withPoster = videos.filter(
      (v) => (v.attrs["poster"] ?? "").trim().length > 0,
    )
    const count = withPoster.length
    const passed = count > 0
    return {
      passed,
      evidence: passed
        ? `${count} <video> element(s) with a poster attribute found in raw HTML`
        : "No <video> tag with a non-empty poster attribute found in raw HTML",
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
    'A <link rel="preload" as="image" fetchpriority="high"> exists in <head>.',
  defaultPoints: 20,
  appliesTo: videoGate,
  evaluate(e) {
    const head = headSlice(e.rawHtml)
    const links = parseTags(head, "link")
    const match = links.find(
      (link) =>
        (link.attrs["rel"] ?? "").toLowerCase() === "preload" &&
        (link.attrs["as"] ?? "").toLowerCase() === "image" &&
        (link.attrs["fetchpriority"] ?? "").toLowerCase() === "high",
    )
    if (match) {
      return {
        passed: true,
        evidence:
          '<link rel="preload" as="image" fetchpriority="high"> found in <head>',
      }
    }
    return {
      passed: false,
      evidence:
        'No <link rel="preload" as="image" fetchpriority="high"> found in <head>',
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
