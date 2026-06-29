/**
 * Topic 5 — TTFB/Cache
 * topicId: 5 | hasNA: false | standalone: false
 * Max points: 35+30+15+10+10 = 100
 */
import type { Control, TopicModule } from "../core"
import { header } from "./util"

// ── local helper ──────────────────────────────────────────────────────────────

/**
 * Parse Cache-Control header to extract max-age or s-maxage in seconds.
 * Returns the numeric seconds, or null if neither directive is present.
 * s-maxage takes precedence over max-age (CDN semantics).
 */
export function cacheControlMaxAge(value: string): number | null {
  // Try s-maxage first (CDN-facing)
  const smax = /\bs-maxage\s*=\s*(\d+)/i.exec(value)
  if (smax) return parseInt(smax[1]!, 10)
  // Fall back to max-age
  const max = /\bmax-age\s*=\s*(\d+)/i.exec(value)
  if (max) return parseInt(max[1]!, 10)
  return null
}

// ── controls ──────────────────────────────────────────────────────────────────

/** 35 pts — CDN cache on HTML */
const cdnCacheControl: Control = {
  id: "ttfb.cdncache",
  topicId: 5,
  label: "CDN cache on HTML pages",
  description:
    "Main response indicates edge caching: cf-cache-status/x-cache/x-vercel-cache HIT, age > 0, or s-maxage > 0.",
  defaultPoints: 35,
  evaluate(e) {
    const h = e.mainResponseHeaders

    // 1. cf-cache-status contains "HIT"
    const cfStatus = header(h, "cf-cache-status") ?? ""
    if (cfStatus.toUpperCase().includes("HIT")) {
      return { passed: true, evidence: `cf-cache-status: ${cfStatus}` }
    }

    // 2. x-cache contains "Hit"
    const xCache = header(h, "x-cache") ?? ""
    if (/hit/i.test(xCache)) {
      return { passed: true, evidence: `x-cache: ${xCache}` }
    }

    // 3. x-vercel-cache = "HIT"
    const vercelCache = header(h, "x-vercel-cache") ?? ""
    if (vercelCache.toUpperCase() === "HIT") {
      return { passed: true, evidence: `x-vercel-cache: ${vercelCache}` }
    }

    // 4. age header > 0
    const ageRaw = header(h, "age") ?? ""
    const age = parseInt(ageRaw, 10)
    if (!isNaN(age) && age > 0) {
      return { passed: true, evidence: `age: ${age} (object served from edge cache)` }
    }

    // 5. cache-control s-maxage > 0
    const cc = header(h, "cache-control") ?? ""
    const smax = /\bs-maxage\s*=\s*(\d+)/i.exec(cc)
    if (smax) {
      const smaxVal = parseInt(smax[1]!, 10)
      if (smaxVal > 0) {
        return { passed: true, evidence: `cache-control: ${cc} (s-maxage=${smaxVal})` }
      }
    }

    return {
      passed: false,
      evidence: cc
        ? `No CDN cache hit indicators found. cache-control: ${cc}; age: "${ageRaw}"`
        : "No CDN cache hit indicators found (no cache-control, no age, no hit headers)",
    }
  },
}

/** 30 pts — Browser cache for HTML */
const browserCacheControl: Control = {
  id: "ttfb.browsercache",
  topicId: 5,
  label: "Browser cache for HTML pages",
  description:
    "cache-control max-age > 0 and not blocked by no-store, no-cache, or private.",
  defaultPoints: 30,
  evaluate(e) {
    const cc = header(e.mainResponseHeaders, "cache-control") ?? ""
    if (!cc) {
      return { passed: false, evidence: "No cache-control header on main response" }
    }

    // Check for blocking directives
    if (/\bno-store\b/i.test(cc)) {
      return { passed: false, evidence: `cache-control: ${cc} (no-store blocks browser cache)` }
    }
    if (/\bno-cache\b/i.test(cc)) {
      return { passed: false, evidence: `cache-control: ${cc} (no-cache requires revalidation)` }
    }
    if (/\bprivate\b/i.test(cc)) {
      return { passed: false, evidence: `cache-control: ${cc} (private — browser will cache but CDN won't; criterion checks max-age)` }
    }

    // Extract max-age (not s-maxage — browser only reads max-age)
    const maxMatch = /\bmax-age\s*=\s*(\d+)/i.exec(cc)
    if (!maxMatch) {
      return { passed: false, evidence: `cache-control: ${cc} (no max-age directive)` }
    }
    const maxAge = parseInt(maxMatch[1]!, 10)
    if (maxAge > 0) {
      return { passed: true, evidence: `cache-control: ${cc} (max-age=${maxAge})` }
    }
    return { passed: false, evidence: `cache-control: ${cc} (max-age=0 — browser won't cache)` }
  },
}

/** 15 pts — TTFB < 800ms */
const ttfb800Control: Control = {
  id: "ttfb.ttfb800",
  topicId: 5,
  label: "TTFB < 800ms (field + lab)",
  description:
    "Lab TTFB < 800ms. When field data is present, both field and lab must be < 800ms.",
  defaultPoints: 15,
  evaluate(e) {
    const lab = e.perf.ttfbMs
    const field = e.field?.ttfbMs ?? null

    if (lab === null && field === null) {
      return { passed: false, evidence: "TTFB not measured (lab null, no field data)" }
    }

    if (field !== null) {
      // Both must pass
      const labOk = lab !== null && lab < 800
      const fieldOk = field < 800
      const passed = labOk && fieldOk
      const labStr = lab !== null ? `${Math.round(lab)}ms` : "not measured"
      return {
        passed,
        evidence: `Lab TTFB: ${labStr}, Field TTFB: ${Math.round(field)}ms — both must be < 800ms`,
      }
    }

    // Field absent — use lab only
    const passed = lab! < 800
    return {
      passed,
      evidence: `Lab TTFB: ${Math.round(lab!)}ms (no field data) — threshold 800ms`,
    }
  },
}

/** 10 pts — Speculation Rules */
const specrulesControl: Control = {
  id: "ttfb.specrules",
  topicId: 5,
  label: "Speculation Rules",
  description:
    'Page uses <script type="speculationrules"> or a Speculation-Rules header.',
  defaultPoints: 10,
  evaluate(e) {
    // Check inline script tag
    if (/<script[^>]+type\s*=\s*["']?speculationrules["']?/i.test(e.rawHtml)) {
      return { passed: true, evidence: 'Found <script type="speculationrules"> in raw HTML' }
    }

    // Check for Speculation-Rules response header (link header with rel=speculationrules)
    const linkHeader = header(e.mainResponseHeaders, "link") ?? ""
    if (/speculationrules/i.test(linkHeader)) {
      return {
        passed: true,
        evidence: `Speculation-Rules reference found in Link header: ${linkHeader.substring(0, 120)}`,
      }
    }

    // Also check for a dedicated Speculation-Rules header
    const speculationHeader = header(e.mainResponseHeaders, "speculation-rules") ?? ""
    if (speculationHeader) {
      return {
        passed: true,
        evidence: `Speculation-Rules response header: ${speculationHeader.substring(0, 120)}`,
      }
    }

    return {
      passed: false,
      evidence:
        'No <script type="speculationrules"> found in HTML and no Speculation-Rules header detected',
    }
  },
}

/** 10 pts — bfcache (no unload handlers) */
const bfcacheControl: Control = {
  id: "ttfb.bfcache",
  topicId: 5,
  label: "bfcache eligible (no unload handlers)",
  description:
    "Neither rawHtml nor renderedHtml contains onunload or addEventListener('unload'/'beforeunload').",
  defaultPoints: 10,
  evaluate(e) {
    const pattern = /onunload|addEventListener\(\s*['"](unload|beforeunload)/i

    const rawMatch = pattern.test(e.rawHtml)
    const renderedMatch = pattern.test(e.renderedHtml)

    if (rawMatch || renderedMatch) {
      const sources: string[] = []
      if (rawMatch) sources.push("raw HTML")
      if (renderedMatch) sources.push("rendered HTML")
      return {
        passed: false,
        evidence: `Unload handler pattern found in: ${sources.join(", ")} — page may not be bfcache eligible`,
      }
    }

    return {
      passed: true,
      evidence:
        "No onunload or addEventListener(unload/beforeunload) found in raw or rendered HTML — bfcache likely eligible",
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const ttfbCacheTopic: TopicModule = {
  id: 5,
  name: "TTFB/Cache",
  hasNA: false,
  standalone: false,
  controls: [
    cdnCacheControl,     // 35
    browserCacheControl, // 30
    ttfb800Control,      // 15
    specrulesControl,    // 10
    bfcacheControl,      // 10
  ],
}
