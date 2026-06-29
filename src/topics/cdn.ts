/**
 * Topic 10 — CDN
 * topicId: 10 | hasNA: false | standalone: false
 * Max points: 20+20+20+15+10+10+5 = 100
 */
import type { EvidenceBundle, NetworkRequest } from "../core"
import type { Control, TopicModule } from "../core"

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns document + stylesheet + script requests ("text resources"). */
function textResources(e: EvidenceBundle): NetworkRequest[] {
  return e.requests.filter(
    (r) => r.resourceType === "document" || r.resourceType === "stylesheet" || r.resourceType === "script",
  )
}

/** Returns image + stylesheet + script + font requests ("static assets"). */
function staticAssets(e: EvidenceBundle): NetworkRequest[] {
  return e.requests.filter(
    (r) =>
      r.resourceType === "image" ||
      r.resourceType === "stylesheet" ||
      r.resourceType === "script" ||
      r.resourceType === "font",
  )
}

/**
 * Parse max-age from a Cache-Control header value.
 * Returns the numeric value in seconds, or -1 if not present.
 */
export function cacheControlMaxAge(headerValue: string): number {
  const match = /\bmax-age\s*=\s*(\d+)/i.exec(headerValue)
  return match ? parseInt(match[1]!, 10) : -1
}

/** Returns true if the cache-control value indicates long TTL (≥180 days or immutable). */
function hasLongTtl(cacheControl: string): boolean {
  if (/\bimmutable\b/i.test(cacheControl)) return true
  const maxAge = cacheControlMaxAge(cacheControl)
  return maxAge >= 15552000 // 180 days in seconds
}

/** Known CDN response header fingerprints. */
const CDN_HEADERS = [
  "cf-ray",
  "cf-cache-status",
  "x-amz-cf-pop",
  "x-amz-cf-id",
  "x-cache",
  "x-served-by",
  "fastly-io-info",
  "x-fastly-request-id",
  "x-akamai-request-id",
  "akamai-cache-status",
  "x-akamai-transformed",
  "x-akamai",
]

// ── controls ─────────────────────────────────────────────────────────────────

const brotliControl: Control = {
  id: "cdn.brotli",
  topicId: 10,
  label: "Brotli compression on HTML and text resources",
  description:
    "Main HTML uses br (or zstd) encoding AND most CSS/JS responses also use br/zstd.",
  defaultPoints: 20,
  evaluate(e) {
    const htmlEncoding = e.mainResponseHeaders["content-encoding"] ?? ""
    const htmlModern = /\b(br|zstd)\b/i.test(htmlEncoding)

    const texts = textResources(e).filter((r) => r.resourceType !== "document")
    const modernTexts = texts.filter((r) => /\b(br|zstd)\b/i.test(r.responseHeaders["content-encoding"] ?? ""))
    const textRatio = texts.length === 0 ? 1 : modernTexts.length / texts.length
    const passed = htmlModern && textRatio > 0.5

    const htmlNote = htmlModern
      ? `HTML uses ${htmlEncoding}`
      : `HTML encoding: "${htmlEncoding}" (not br/zstd)`
    const textNote =
      texts.length === 0
        ? "no external text resources"
        : `${modernTexts.length}/${texts.length} CSS/JS use br/zstd`

    return {
      passed,
      evidence: `${htmlNote}; ${textNote}`,
    }
  },
}

const longTtlControl: Control = {
  id: "cdn.longttl",
  topicId: 10,
  label: "Long TTL for static assets (≥180 days or immutable)",
  description: "Majority of image/stylesheet/script/font responses have cache-control max-age ≥15552000 or immutable.",
  defaultPoints: 20,
  evaluate(e) {
    const assets = staticAssets(e)
    if (assets.length === 0) {
      return { passed: false, evidence: "No static asset requests observed" }
    }
    const longTtlAssets = assets.filter((r) => {
      const cc = r.responseHeaders["cache-control"] ?? ""
      return hasLongTtl(cc)
    })
    const pct = Math.round((longTtlAssets.length / assets.length) * 100)
    const passed = longTtlAssets.length / assets.length > 0.5
    return {
      passed,
      evidence: `${longTtlAssets.length}/${assets.length} static assets have long TTL (≥180d or immutable) = ${pct}%`,
    }
  },
}

const regionControl: Control = {
  id: "cdn.region",
  topicId: 10,
  label: "CDN with regional distribution (inferred)",
  description: "Presence of a CDN fingerprint header in the main document response.",
  defaultPoints: 20,
  evaluate(e) {
    const headers = e.mainResponseHeaders
    for (const cdnHeader of CDN_HEADERS) {
      if (headers[cdnHeader] !== undefined) {
        return {
          passed: true,
          evidence: `CDN inferred from header "${cdnHeader}: ${String(headers[cdnHeader]).substring(0, 60)}" — cannot truly verify regional distribution from one origin`,
        }
      }
    }
    // Also check for "fastly" or "akamai" as a substring in any header value
    for (const [key, value] of Object.entries(headers)) {
      const lVal = String(value).toLowerCase()
      if (lVal.includes("fastly") || lVal.includes("akamai") || lVal.includes("cloudflare")) {
        return {
          passed: true,
          evidence: `CDN inferred from header "${key}" value containing CDN name — cannot truly verify regional distribution from one origin`,
        }
      }
    }
    return {
      passed: false,
      evidence: "No known CDN fingerprint headers found in main document response",
    }
  },
}

const tls13Control: Control = {
  id: "cdn.tls13",
  topicId: 10,
  label: "TLS 1.3 + IPv6",
  description: "network.tlsVersion === TLSv1.3 AND network.ipv6 === true.",
  defaultPoints: 15,
  evaluate(e) {
    const tls = e.network.tlsVersion
    const ipv6 = e.network.ipv6
    const passed = tls === "TLSv1.3" && ipv6 === true
    return {
      passed,
      evidence: `TLS: ${tls ?? "unknown"}, IPv6: ${ipv6 ?? "unknown"}`,
    }
  },
}

const zstdControl: Control = {
  id: "cdn.zstd",
  topicId: 10,
  label: "Zstandard compression",
  description: "Any document/CSS/JS response uses content-encoding: zstd.",
  defaultPoints: 10,
  evaluate(e) {
    // Check main HTML first
    const htmlEncoding = e.mainResponseHeaders["content-encoding"] ?? ""
    if (/\bzstd\b/i.test(htmlEncoding)) {
      return { passed: true, evidence: `Main HTML uses zstd encoding (${htmlEncoding})` }
    }
    // Check text resources
    const texts = textResources(e)
    const zstdResource = texts.find((r) => /\bzstd\b/i.test(r.responseHeaders["content-encoding"] ?? ""))
    if (zstdResource) {
      return {
        passed: true,
        evidence: `Resource ${zstdResource.url} uses zstd encoding`,
      }
    }
    return { passed: false, evidence: "No zstd content-encoding found in document or text resources" }
  },
}

const http3Control: Control = {
  id: "cdn.http3",
  topicId: 10,
  label: "HTTP/3 support",
  description: "network.http3 === true (advertised via alt-svc or negotiated).",
  defaultPoints: 10,
  evaluate(e) {
    const passed = e.network.http3 === true
    return {
      passed,
      evidence: passed
        ? "HTTP/3 negotiated or advertised via alt-svc"
        : `HTTP/3 not available (network.http3 = ${String(e.network.http3)})`,
    }
  },
}

const alpnControl: Control = {
  id: "cdn.alpn",
  topicId: 10,
  label: "ALPN negotiated",
  description: "network.alpn is a non-empty string.",
  defaultPoints: 5,
  evaluate(e) {
    const alpn = e.network.alpn
    const passed = typeof alpn === "string" && alpn.length > 0
    return {
      passed,
      evidence: passed ? `ALPN negotiated: ${alpn}` : `ALPN not set (network.alpn = ${String(alpn)})`,
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const cdnTopic: TopicModule = {
  id: 10,
  name: "CDN",
  hasNA: false,
  standalone: false,
  controls: [
    brotliControl,   // 20
    longTtlControl,  // 20
    regionControl,   // 20
    tls13Control,    // 15
    zstdControl,     // 10
    http3Control,    // 10
    alpnControl,     //  5
  ],
}
