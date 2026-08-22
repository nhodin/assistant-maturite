/**
 * Topic 5 — TTFB/Cache
 * topicId: 5 | hasNA: false | standalone: false
 * Max points: 35+30+15+10+10 = 100
 */
import type { Control, TopicModule } from "../core"
import { edgeHitHeader, header } from "./util"

// ── controls ──────────────────────────────────────────────────────────────────

/** 35 pts — CDN cache on HTML */
export const cdnCacheControl: Control = {
  id: "ttfb.cdncache",
  topicId: 5,
  label: "CDN cache on HTML pages",
  description:
    "Main response indicates edge caching: an OBSERVED edge hit (cf-cache-status/x-cache/x-vercel-cache/akamai-cache-status HIT, server-timing cdn-cache;desc=HIT, or age > 0) always passes, whatever cache-control says — some CDNs (Akamai typically) cache by their own config while returning `private` to the client. Absent an observed hit, a declarative signal is accepted only if shared caching is not forbidden: s-maxage > 0, or as weakest fallback max-age > 0 — both void when cache-control carries private/no-store/no-cache.",
  defaultPoints: 35,
  evaluate(e) {
    const h = e.mainResponseHeaders

    // Steps 1–2 are OBSERVED edge hits and are deliberately evaluated FIRST, before any
    // cache-control check: an edge hit is proof the CDN cached the object, whatever the
    // header says. Several CDNs (Akamai typically) cache according to their own
    // configuration while still returning `private` to the client — so `private` must never
    // veto a hit we actually measured. Only the DECLARATIVE signals below, which infer
    // caching from cache-control alone, are subject to the shared-cache directives.

    // 1. Hit headers — shared detector with cdn.ts:isCdnHit (cf-cache-status, x-cache,
    //    x-vercel-cache, akamai-cache-status, x-cache-status, x-cache-remote, and
    //    server-timing cdn-cache;desc=HIT). A signature added there lands here too.
    const hit = edgeHitHeader(h)
    if (hit) {
      return { passed: true, evidence: hit }
    }

    // 2. age header > 0
    const ageRaw = header(h, "age") ?? ""
    const age = parseInt(ageRaw, 10)
    if (!isNaN(age) && age > 0) {
      return { passed: true, evidence: `age: ${age} (object served from edge cache)` }
    }

    // No observed edge hit from here on — only declarative signals, which are void as soon as
    // cache-control forbids shared (CDN) caching. `private` wins over `s-maxage`: a response
    // marked private may not be stored by a shared cache at all, so its s-maxage is inoperative.
    const cc = header(h, "cache-control") ?? ""
    const sharedCacheBlocked = /\b(private|no-store|no-cache)\b/i.test(cc)

    // 3. cache-control s-maxage > 0 (and shared caching not forbidden)
    const smax = /\bs-maxage\s*=\s*(\d+)/i.exec(cc)
    const smaxVal = smax ? parseInt(smax[1]!, 10) : null
    if (smaxVal !== null && smaxVal > 0 && !sharedCacheBlocked) {
      return { passed: true, evidence: `cache-control: ${cc} (s-maxage=${smaxVal})` }
    }

    // 4. Weakest fallback — cache-control max-age > 0 without private/no-store/no-cache.
    //    The written criterion accepts "Cache-Control with max-age/s-max-age > 0"; a public
    //    max-age lets a shared cache (CDN) store the response, but we have no direct edge-hit.
    if (!sharedCacheBlocked) {
      const maxMatch = /\bmax-age\s*=\s*(\d+)/i.exec(cc)
      if (maxMatch) {
        const maxVal = parseInt(maxMatch[1]!, 10)
        if (maxVal > 0) {
          return {
            passed: true,
            evidence: `cache-control: ${cc} (max-age=${maxVal}>0 without private — a CDN may cache this; no direct edge-hit evidence, weak signal)`,
          }
        }
      }
    }

    if (smaxVal !== null && smaxVal > 0 && sharedCacheBlocked) {
      return {
        passed: false,
        evidence: `cache-control: ${cc} — s-maxage present but private/no-store/no-cache forbids shared caching and no edge-hit header observed`,
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
    "cache-control max-age > 0 and not blocked by no-store or no-cache. `private` does NOT block browser caching (it only forbids shared/CDN caches), so `private, max-age=N` passes — the correct pattern for personalized HTML.",
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

    // Note: `private` is NOT a blocker — it only forbids shared/CDN caches; the browser
    // (a private cache) still stores the response, so `private, max-age=N` is a valid HTML pattern.

    // Extract max-age (not s-maxage — browser only reads max-age)
    const maxMatch = /\bmax-age\s*=\s*(\d+)/i.exec(cc)
    if (!maxMatch) {
      return { passed: false, evidence: `cache-control: ${cc} (no max-age directive)` }
    }
    const maxAge = parseInt(maxMatch[1]!, 10)
    if (maxAge > 0) {
      const note = /\bprivate\b/i.test(cc)
        ? " — private does not block browser caching, only shared/CDN caches"
        : ""
      return { passed: true, evidence: `cache-control: ${cc} (max-age=${maxAge}${note})` }
    }
    return { passed: false, evidence: `cache-control: ${cc} (max-age=0 — browser won't cache)` }
  },
}

/** 15 pts — TTFB < 800ms */
export const ttfb800Control: Control = {
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
      // An origin-scoped p75 is pulled by the homepage, so say so rather than
      // letting it read as a measure of this URL.
      const scope =
        e.field?.scope === "origin"
          ? ` (origin-wide${e.field.urlKey ? ` — ${e.field.urlKey}` : ""})`
          : ""
      return {
        passed,
        evidence: `Lab TTFB: ${labStr}, Field TTFB: ${Math.round(field)}ms${scope} — both must be < 800ms`,
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
    "Low-confidence heuristic: greps inline HTML (rawHtml/renderedHtml) for onunload or addEventListener('unload'/'beforeunload'). Unload handlers overwhelmingly live in external JS bundles, which are NOT scanned — so a pass only means no inline handler was found.",
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
        "No unload handler in inline HTML — external scripts not scanned; low-confidence pass",
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
