/**
 * Topic 12 — China Market Access
 * topicId: 12 | hasNA: false | standalone: true (reported separately, not in average)
 * Max points: 30+25+20+15+10 = 100
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import { host, parseTags, headSlice, header } from "./util"

// ── GFW-blocked domains ────────────────────────────────────────────────────────
// Clearly blocked-in-mainland-China domains. A host matches if it equals or ends
// with one of these.
const GFW_DOMAINS = [
  "googleapis.com",
  "gstatic.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "google-analytics.com",
  "googletagmanager.com",
  "www.google.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "facebook.net",
  "connect.facebook.net",
  "facebook.com",
  "fbcdn.net",
  "youtube.com",
  "youtu.be",
  "ytimg.com",
  "twitter.com",
  "x.com",
  "t.co",
  "instagram.com",
  "whatsapp.com",
  "linkedin.com",
  "pinterest.com",
]

function isGfw(url: string): boolean {
  const h = host(url)
  if (!h) return false
  return GFW_DOMAINS.some((d) => h === d || h.endsWith("." + d))
}

// CN-CDN response-header signals (best-effort; a single-origin probe can only infer).
const CN_CDN_HEADER_KEYS = [
  "x-nws-log-uuid", // Tencent Cloud CDN
  "x-ser", // some CN CDNs
  "ali-swift", // Alibaba
  "eagleid", // Alibaba/Aliyun edge id
  "powered-by-chinacache", // ChinaCache
  "x-wangsu", // Wangsu / ChinaNetCenter
]

// ── controls ─────────────────────────────────────────────────────────────────

const noGfwCriticalControl: Control = {
  id: "china.nogfwcritical",
  topicId: 12,
  label: "No GFW domains on critical path",
  description: "No render-blocking script/CSS/preload in <head> from a GFW-blocked domain.",
  defaultPoints: 30,
  evaluate(e: EvidenceBundle) {
    const headHtml = headSlice(e.rawHtml)
    const blocked = new Set<string>()
    for (const s of parseTags(headHtml, "script")) {
      const src = s.attrs["src"]
      if (src && isGfw(src)) blocked.add(host(src))
    }
    for (const l of parseTags(headHtml, "link")) {
      const rel = (l.attrs["rel"] ?? "").toLowerCase()
      const href = l.attrs["href"] ?? ""
      if ((rel === "stylesheet" || rel === "preload") && href && isGfw(href)) {
        blocked.add(host(href))
      }
    }
    if (blocked.size === 0) {
      return { passed: true, evidence: "No GFW-blocked domains on the critical path" }
    }
    return {
      passed: false,
      evidence: `Critical-path GFW-blocked domain(s): ${[...blocked].join(", ")}`,
    }
  },
}

const cdnChinaPopControl: Control = {
  id: "china.cdnchinapop",
  topicId: 12,
  label: "CDN with mainland-China POP",
  description: "Response headers indicate a mainland-China CDN POP (inferred).",
  defaultPoints: 25,
  evaluate(e: EvidenceBundle) {
    const hit = CN_CDN_HEADER_KEYS.find(
      (k) => header(e.mainResponseHeaders, k) !== undefined,
    )
    if (hit) {
      return {
        passed: true,
        evidence: `CN-CDN signal header present: ${hit} (inferred)`,
      }
    }
    return {
      passed: false,
      evidence:
        "No mainland-China CDN POP header detected (inferred — single-origin probe cannot confirm)",
    }
  },
}

const noGfwAllControl: Control = {
  id: "china.nogfwall",
  topicId: 12,
  label: "No GFW domains across all resources",
  description: "No network request (analytics, pixels, fonts, embeds) targets a GFW-blocked domain.",
  defaultPoints: 20,
  evaluate(e: EvidenceBundle) {
    const blocked = new Set<string>()
    for (const r of e.requests) {
      if (isGfw(r.url)) blocked.add(host(r.url))
    }
    if (blocked.size === 0) {
      return {
        passed: true,
        evidence: `No GFW-blocked domains across ${e.requests.length} request(s)`,
      }
    }
    const sample = [...blocked].slice(0, 8)
    return {
      passed: false,
      evidence: `${blocked.size} GFW-blocked domain(s) across all requests: ${sample.join(", ")}${blocked.size > sample.length ? "…" : ""}`,
    }
  },
}

const icpControl: Control = {
  id: "china.icp",
  topicId: 12,
  label: "ICP license in footer",
  description: "An ICP filing number is present in the page.",
  defaultPoints: 15,
  evaluate(e: EvidenceBundle) {
    const haystack = e.renderedHtml || e.rawHtml
    // e.g. 京ICP备12345678号 / 沪ICP备 1234567 号 / plain ICP备12345678
    const m = haystack.match(
      /[一-龥]{0,3}ICP\s*备?\s*\d{5,}\s*号?/i,
    )
    if (m) {
      return { passed: true, evidence: `ICP license found: ${m[0].trim()}` }
    }
    return { passed: false, evidence: "No ICP filing number found in page" }
  },
}

const cnAnalyticsControl: Control = {
  id: "china.cnanalytics",
  topicId: 12,
  label: "China-compatible analytics",
  description: "Baidu analytics used, or no blocked client-side tracker firing.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const hosts = e.requests.map((r) => host(r.url))
    const usesBaidu = hosts.some((h) => h.includes("hm.baidu.com") || h.endsWith("baidu.com"))
    if (usesBaidu) {
      return { passed: true, evidence: "Baidu analytics (hm.baidu.com) detected" }
    }
    const BLOCKED_TRACKERS = [
      "google-analytics.com",
      "googletagmanager.com",
      "connect.facebook.net",
      "facebook.net",
    ]
    const firing = hosts.filter((h) =>
      BLOCKED_TRACKERS.some((d) => h === d || h.endsWith("." + d)),
    )
    if (firing.length === 0) {
      return {
        passed: true,
        evidence: "No blocked client-side tracker firing (GA/GTM/Meta absent)",
      }
    }
    return {
      passed: false,
      evidence: `Blocked tracker(s) firing client-side: ${[...new Set(firing)].join(", ")}`,
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const chinaTopic: TopicModule = {
  id: 12,
  name: "China Market Access",
  hasNA: false,
  standalone: true,
  controls: [
    noGfwCriticalControl, // 30
    cdnChinaPopControl,   // 25
    noGfwAllControl,      // 20
    icpControl,           // 15
    cnAnalyticsControl,   // 10
  ],
}
