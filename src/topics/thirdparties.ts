/**
 * Topic 4 — Third parties
 * topicId: 4 | hasNA: false | standalone: false
 * Max points: 30+25+20+15+10 = 100
 *
 * NOTE: cookie acceptance before capture is handled at the collector level
 * (features.cookieAccepted). The criteria here work on whatever was captured.
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import {
  parseTags,
  headSlice,
  isThirdParty,
  host,
} from "./util"

// ── third-party category map ──────────────────────────────────────────────────

/**
 * Maps a domain substring → category string.
 * Used by tp.limit to detect >1 provider per category.
 * Order matters: first match wins.
 */
const THIRD_PARTY_CATEGORIES: Array<[substring: string, category: string]> = [
  ["google-analytics.com", "analytics-tagmgr"],
  ["googletagmanager.com", "analytics-tagmgr"],
  ["doubleclick.net", "ads"],
  ["googlesyndication.com", "ads"],
  ["googleadservices.com", "ads"],
  ["connect.facebook.net", "social-pixel"],
  ["facebook.net", "social-pixel"],
  ["hotjar.com", "session-replay"],
  ["clarity.ms", "session-replay"],
  ["mouseflow.com", "session-replay"],
  ["optimizely.com", "abtest"],
  ["abtasty.com", "abtest"],
  ["vwo.com", "abtest"],
  ["zendesk.com", "chat"],
  ["intercom.io", "chat"],
  ["drift.com", "chat"],
  ["tawk.to", "chat"],
  ["cookielaw.org", "consent"],
  ["onetrust.com", "consent"],
  ["didomi.io", "consent"],
  ["typekit.net", "fonts"],
  ["use.fontawesome.com", "fonts"],
  ["fonts.gstatic.com", "fonts"],
  ["youtube.com", "video"],
  ["vimeo.com", "video"],
]

/** Return the category for a hostname, or null if not categorized. */
function categoryForHost(hostname: string): string | null {
  const lower = hostname.toLowerCase()
  for (const [sub, cat] of THIRD_PARTY_CATEGORIES) {
    if (lower.includes(sub)) return cat
  }
  return null
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** True if a script tag has defer, async, or type="module". */
function hasDefer(attrs: Record<string, string>): boolean {
  return (
    "defer" in attrs ||
    "async" in attrs ||
    (attrs["type"] ?? "").toLowerCase() === "module"
  )
}

/** Resolve root-relative src: if it starts with "/" it's first-party. */
function isRootRelative(src: string): boolean {
  return src.startsWith("/") && !src.startsWith("//")
}

// ── controls ──────────────────────────────────────────────────────────────────

const deferAsyncControl: Control = {
  id: "tp.deferasync",
  topicId: 4,
  label: "defer/async on third-party JS",
  description:
    "All <script src> tags loading third-party JS must have defer, async, or type=module.",
  defaultPoints: 30,
  evaluate(e: EvidenceBundle) {
    const scripts = parseTags(e.rawHtml, "script")
    // Only external scripts with a src attribute
    const externalScripts = scripts.filter((s) => s.attrs["src"] !== undefined)
    // Filter to third-party only (root-relative → first-party)
    const tpScripts = externalScripts.filter((s) => {
      const src = s.attrs["src"]!
      if (isRootRelative(src)) return false
      return isThirdParty(src, e.finalUrl)
    })

    if (tpScripts.length === 0) {
      return {
        passed: true,
        evidence: "no third-party scripts in initial HTML",
      }
    }

    const withDefer = tpScripts.filter((s) => hasDefer(s.attrs))
    const passed = withDefer.length === tpScripts.length
    return {
      passed,
      evidence: `${withDefer.length}/${tpScripts.length} third-party scripts use defer/async`,
    }
  },
}

const preconnectControl: Control = {
  id: "tp.preconnect",
  topicId: 4,
  label: "preconnect / dns-prefetch for external domains",
  description:
    "At least one <link rel=preconnect> or <link rel=dns-prefetch> to an external domain in <head>.",
  defaultPoints: 25,
  evaluate(e: EvidenceBundle) {
    const head = headSlice(e.rawHtml)
    const links = parseTags(head, "link")
    const preconnectLinks = links.filter((l) => {
      const rel = (l.attrs["rel"] ?? "").toLowerCase()
      return rel === "preconnect" || rel === "dns-prefetch"
    })
    // Check that at least one points to an external domain
    const externalPreconnects = preconnectLinks.filter((l) => {
      const href = l.attrs["href"] ?? ""
      if (!href) return false
      // A bare //domain or https://domain is external if not same-site
      if (isRootRelative(href)) return false
      return isThirdParty(href, e.finalUrl)
    })

    const passed = externalPreconnects.length > 0
    return {
      passed,
      evidence: passed
        ? `${externalPreconnects.length} preconnect/dns-prefetch hint(s) to external domains in <head>`
        : `${preconnectLinks.length} preconnect/dns-prefetch link(s) found but none pointing to external domains`,
    }
  },
}

const selfhostControl: Control = {
  id: "tp.selfhost",
  topicId: 4,
  label: "No third-party scripts/stylesheets on critical path",
  description:
    "No third-party <script src> or <link rel=stylesheet> in <head> (critical-path resources are first-party).",
  defaultPoints: 20,
  evaluate(e: EvidenceBundle) {
    const head = headSlice(e.rawHtml)

    const scripts = parseTags(head, "script")
    const tpScripts = scripts.filter((s) => {
      const src = s.attrs["src"]
      if (!src) return false
      if (isRootRelative(src)) return false
      return isThirdParty(src, e.finalUrl)
    })

    const links = parseTags(head, "link")
    const tpStylesheets = links.filter((l) => {
      const rel = (l.attrs["rel"] ?? "").toLowerCase()
      if (rel !== "stylesheet") return false
      const href = l.attrs["href"] ?? ""
      if (!href || isRootRelative(href)) return false
      return isThirdParty(href, e.finalUrl)
    })

    const total = tpScripts.length + tpStylesheets.length
    const passed = total === 0
    return {
      passed,
      evidence: passed
        ? "no third-party scripts or stylesheets in <head> (critical path is first-party)"
        : `${total} third-party resource(s) in <head>: ${tpScripts.length} script(s), ${tpStylesheets.length} stylesheet(s)`,
    }
  },
}

const limitControl: Control = {
  id: "tp.limit",
  topicId: 4,
  label: "Max 1 provider per third-party category (heuristic)",
  description:
    "For all third-party request hosts, no usage category has more than 1 distinct provider domain. Heuristic based on domain-substring matching.",
  defaultPoints: 15,
  evaluate(e: EvidenceBundle) {
    // Collect all distinct third-party hostnames from requests
    const tpHosts = new Set<string>()
    for (const req of e.requests) {
      if (isThirdParty(req.url, e.finalUrl)) {
        const h = host(req.url)
        if (h) tpHosts.add(h)
      }
    }

    // Group hosts by category, track distinct provider domains per category
    // A "provider" = registrable domain (we just use the matched category key)
    const categoryToProviders = new Map<string, Set<string>>()
    for (const h of tpHosts) {
      const cat = categoryForHost(h)
      if (!cat) continue
      if (!categoryToProviders.has(cat)) categoryToProviders.set(cat, new Set())
      categoryToProviders.get(cat)!.add(h)
    }

    const violating: string[] = []
    for (const [cat, providers] of categoryToProviders) {
      if (providers.size > 1) {
        violating.push(`${cat}: ${[...providers].join(", ")}`)
      }
    }

    const passed = violating.length === 0
    return {
      passed,
      evidence: passed
        ? `no category exceeds 1 provider (heuristic — ${tpHosts.size} third-party host(s) checked)`
        : `categories with >1 provider: ${violating.join(" | ")} (heuristic)`,
    }
  },
}

const eventBasedControl: Control = {
  id: "tp.eventbased",
  topicId: 4,
  label: "Event-based loading of third parties",
  description:
    "At least one third-party provider (analytics/chat/pixel/SDK) is fetched ONLY after a synthetic user/browser interaction (phase=interaction), not during initial load — i.e. fine-tuned event-based loading.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    // Third-party hosts already present during the quiet initial load.
    const loadHosts = new Set<string>()
    for (const req of e.requests) {
      if (req.phase === "interaction") continue
      if (!isThirdParty(req.url, e.finalUrl)) continue
      const h = host(req.url)
      if (h) loadHosts.add(h)
    }

    // Third-party requests initiated only after interaction, from a host not seen
    // during load, that look like an actual provider (categorized OR an executable
    // /beacon resource — script/xhr/fetch). Lazy CDN images don't count.
    const deferred = new Set<string>()
    for (const req of e.requests) {
      if (req.phase !== "interaction") continue
      if (!isThirdParty(req.url, e.finalUrl)) continue
      const h = host(req.url)
      if (!h || loadHosts.has(h)) continue
      const looksLikeProvider =
        categoryForHost(h) !== null ||
        ["script", "xhr", "fetch"].includes(req.resourceType)
      if (looksLikeProvider) deferred.add(h)
    }

    const passed = deferred.size > 0
    return {
      passed,
      evidence: passed
        ? `${deferred.size} third-party provider(s) deferred to user/browser interaction: ${[...deferred].slice(0, 5).join(", ")}`
        : "no third-party provider loaded only after synthetic user/browser interaction",
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const thirdPartiesTopic: TopicModule = {
  id: 4,
  name: "Third parties",
  hasNA: false,
  standalone: false,
  controls: [
    deferAsyncControl,   // 30
    preconnectControl,   // 25
    selfhostControl,     // 20
    limitControl,        // 15
    eventBasedControl,   // 10
  ],
}
