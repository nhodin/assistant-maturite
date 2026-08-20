/**
 * Topic 12 — China Market Access
 * topicId: 12 | hasNA: false | standalone: true (reported separately, not in average)
 * Max points: 50+30+20 = 100
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

/** Extract url(...) and @import targets from a block of CSS text. */
function extractCssUrls(css: string): string[] {
  const out: string[] = []
  // url( '...' | "..." | ... )
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(css)) !== null) {
    const u = m[1] ?? m[2] ?? m[3] ?? ""
    if (u) out.push(u)
  }
  // @import "..." | '...'  (without url())
  const importRe = /@import\s+(?:"([^"]*)"|'([^']*)')/gi
  while ((m = importRe.exec(css)) !== null) {
    const u = m[1] ?? m[2] ?? ""
    if (u) out.push(u)
  }
  return out
}

/** Extract preload/prefetch URLs (between < and >) from a Link response header value. */
function extractLinkHeaderUrls(linkHeader: string): string[] {
  const out: string[] = []
  const re = /<([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(linkHeader)) !== null) {
    if (m[1]) out.push(m[1].trim())
  }
  return out
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

/**
 * 50 pts — the sitespeed fundamentals, measured on the China page itself.
 *
 * DERIVED control: its points are not a function of the bundle but of the OTHER
 * topics' scores on this very page — each of topics 1–10 reduced to its first
 * criterion (0 or 100), exactly the China-page rule (see `PageScoringMode`). The
 * engine fills it in once everything else is scored, PROPORTIONALLY:
 * `round(50 × moyenne des sujets 1–10 / 100)`. `evaluate` is therefore a
 * placeholder that the engine never reads.
 */
const basicsControl: Control = {
  id: "china.basics",
  topicId: 12,
  label: "Fondamentaux sitespeed sur la page China (1er critère de chaque sujet)",
  description:
    "Moyenne des sujets 1 à 10 évalués sur leur premier critère uniquement, ramenée sur 50 points. " +
    "Calculé par le moteur à partir des autres sujets de la même page China.",
  defaultPoints: 50,
  derivedFromTopics: true,
  evaluate() {
    // Never used: the engine overrides this control's result. See derivedFromTopics.
    return { passed: false, evidence: "Calculé à partir des sujets 1 à 10 de la page" }
  },
}

const noGfwCriticalControl: Control = {
  id: "china.nogfwcritical",
  topicId: 12,
  label: "No GFW domains on critical path",
  description:
    "No render-blocking GFW-blocked domain on the critical path: <head> <script src>, " +
    "<head> <link rel=stylesheet|preload> href, GFW URLs referenced via @import/url(...) " +
    "inside inline <style> in <head>, and preload targets in the main response Link header.",
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
    // Inline <style> blocks in <head>: @import / url(...) pointing at GFW hosts.
    for (const styleBlock of headHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      for (const url of extractCssUrls(styleBlock[1] ?? "")) {
        if (isGfw(url)) blocked.add(host(url))
      }
    }
    // Main response Link header: preload directives targeting GFW hosts.
    const linkHeader = header(e.mainResponseHeaders, "link")
    if (linkHeader) {
      for (const url of extractLinkHeaderUrls(linkHeader)) {
        if (isGfw(url)) blocked.add(host(url))
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
  defaultPoints: 20,
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

// ── topic module ──────────────────────────────────────────────────────────────

export const chinaTopic: TopicModule = {
  id: 12,
  name: "China Market Access",
  hasNA: false,
  standalone: true,
  controls: [
    basicsControl,        // 50 (derived from topics 1-10 on this page)
    noGfwCriticalControl, // 30
    cdnChinaPopControl,   // 20
  ],
}
