/**
 * Topic 8 — Critical path
 * topicId: 8 | hasNA: false | standalone: false
 * Max points: 30+25+20+15+10 = 100
 */
import type { Control, TopicModule } from "../core"
import { header, headSlice, isNonBlockingScript, parseTags, requestsOfType } from "./util"

// ── controls ──────────────────────────────────────────────────────────────────

const CHARSET_TAG_RE = /<meta\b[^>]*charset[^>]*>/i
/** Browsers must see the charset declaration within the first 1024 bytes to
 *  avoid a re-parse of the document (HTML Standard encoding-sniffing rule). */
const CHARSET_BYTE_BUDGET = 1024

/** Byte offset (UTF-8) of the first <meta charset> tag in rawHtml, or null if absent. */
function charsetByteOffset(rawHtml: string): number | null {
  const m = CHARSET_TAG_RE.exec(rawHtml)
  if (!m) return null
  return Buffer.byteLength(rawHtml.slice(0, m.index), "utf-8")
}

/**
 * 30 pts — Head order: meta[charset] → meta[viewport] → title → CSS → JS
 *
 * From e.head.order we verify that among the PRESENT tokens from this ordered
 * set, each one appears before the next. Missing tokens are skipped (not a failure).
 * Tokens checked: "meta[charset]", "meta[viewport]", "title", "link[stylesheet]", "script"
 *
 * Also requires — when a charset declaration is present — that it appears within
 * the first 1024 bytes of the document, per the HTML Standard's encoding-sniffing
 * rule; a later charset tag forces the browser to re-parse the whole document.
 */
const headOrderControl: Control = {
  id: "cp.headorder",
  topicId: 8,
  label: "Head tag order: charset → viewport → title → CSS → JS",
  description:
    "The first occurrences of meta[charset], meta[viewport], title, link[stylesheet], script appear in that relative order, and meta[charset] (if present) is within the first 1024 bytes.",
  defaultPoints: 30,
  evaluate(e) {
    const EXPECTED = [
      "meta[charset]",
      "meta[viewport]",
      "title",
      "link[stylesheet]",
      "script",
    ] as const

    const order = e.head.order

    // Find the first index of each expected token (or -1 if absent)
    const positions: Array<{ token: string; idx: number }> = EXPECTED.map((token) => ({
      token,
      idx: order.indexOf(token),
    }))

    // Collect only the present ones
    const present = positions.filter((p) => p.idx !== -1)

    if (present.length === 0) {
      return {
        passed: true,
        evidence: "head.order is empty — no ordering violation possible (vacuously satisfied)",
      }
    }

    // Check relative ordering among present tokens
    let violation: string | null = null
    for (let i = 1; i < present.length; i++) {
      const prev = present[i - 1]!
      const curr = present[i]!
      if (prev.idx > curr.idx) {
        violation = `"${prev.token}" (pos ${prev.idx}) appears after "${curr.token}" (pos ${curr.idx})`
        break
      }
    }

    const observed = present.map((p) => `${p.token}@${p.idx}`).join(", ")

    if (violation) {
      return {
        passed: false,
        evidence: `Head order violation — ${violation}. Observed present tokens: [${observed}]`,
      }
    }

    // Encoding-sniffing rule: a present charset tag must start within the first
    // 1024 bytes, else the browser re-parses the document from scratch.
    const charsetOffset = charsetByteOffset(e.rawHtml)
    if (charsetOffset !== null && charsetOffset >= CHARSET_BYTE_BUDGET) {
      return {
        passed: false,
        evidence: `meta[charset] found but at byte offset ${charsetOffset} (≥${CHARSET_BYTE_BUDGET}) — triggers browser re-parse. Observed present tokens: [${observed}]`,
      }
    }

    return {
      passed: true,
      evidence:
        charsetOffset !== null
          ? `Head tag order correct among present tokens: [${observed}]; meta[charset] at byte offset ${charsetOffset} (< ${CHARSET_BYTE_BUDGET})`
          : `Head tag order correct among present tokens: [${observed}]`,
    }
  },
}

/**
 * True if a stylesheet's `media` attribute makes it NON render-blocking
 * (print, speech, a non-matching media query…). Absent/`all`/`screen` = blocking.
 * Local copy of the same rule used by topic 4 (`thirdparties.ts`) — deliberately
 * duplicated to keep the topic modules independent.
 */
function isNonBlockingMedia(media: string | undefined): boolean {
  if (!media) return false
  const m = media.toLowerCase().trim()
  if (!m || m === "all" || m === "screen") return false
  return !m.includes("screen") && !m.includes("all")
}

/** Pathname (lowercased) and last path segment of a URL — tolerant of relative
 *  and protocol-relative URLs commonly seen in markup. Local copy of the helper
 *  in `video.ts`. */
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
 *  CDN/query variance between a markup href/src and the network request URL. */
function looseUrlMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const pa = urlParts(a)
  const pb = urlParts(b)
  if (pa.pathname && pa.pathname === pb.pathname) return true
  if (pa.lastSeg && pa.lastSeg === pb.lastSeg) return true
  return false
}

/**
 * Threshold for the render-blocking payload, in encoded (transferred) bytes.
 *
 * The old control summed ALL non-interaction JS+CSS against 600 KB, which is why
 * that number was so high. We now count only what actually blocks rendering
 * (sync scripts + screen stylesheets in <head>), a much smaller set, so the
 * budget comes down accordingly. 300 KB compressed of render-blocking resources
 * is still well beyond the usual critical-path budgets (~170 KB) — deliberately
 * lenient, to be tightened later if the portfolio warrants it.
 */
const BLOCKING_BYTE_BUDGET = 307_200 // 300 KB

/**
 * 25 pts — Limit critical resources (total size)
 *
 * Measures the resources that are genuinely **render-blocking**, taken from the
 * server HTML `<head>`:
 *   - `<script src>` without defer/async/type=module (parser-blocking), and
 *   - `<link rel=stylesheet href>` whose `media` applies to the screen.
 * Each blocking tag URL is matched to a network request (script/stylesheet) —
 * exact first, then loose (same pathname or same filename) — and their
 * encodedBytes are summed. A blocking tag with no matching request counts 0 but
 * is reported in the evidence.
 *
 * PASS if the blocking total is < BLOCKING_BYTE_BUDGET. Zero blocking resources
 * (everything deferred, CSS inlined) is the ideal case and passes with 0 KB.
 * The old "all non-interaction JS+CSS" total is still reported for reference.
 */
const limitResourcesControl: Control = {
  id: "cp.limitresources",
  topicId: 8,
  label: "Limit render-blocking resource total size (<300 KB)",
  description:
    "Sum of encoded bytes for render-blocking resources in <head> (sync <script src> without defer/async/module + screen-applicable <link rel=stylesheet>) is < 307 200 bytes.",
  defaultPoints: 25,
  evaluate(e) {
    const head = headSlice(e.rawHtml)

    const syncScriptUrls = parseTags(head, "script")
      .filter((t) => (t.attrs["src"] ?? "") !== "" && !isNonBlockingScript(t.attrs))
      .map((t) => t.attrs["src"]!)

    const blockingCssUrls = parseTags(head, "link")
      .filter((t) => {
        const rel = (t.attrs["rel"] ?? "").toLowerCase()
        if (!rel.split(/\s+/).includes("stylesheet")) return false
        if ((t.attrs["href"] ?? "") === "") return false
        return !isNonBlockingMedia(t.attrs["media"])
      })
      .map((t) => t.attrs["href"]!)

    const netResources = requestsOfType(e.requests, "stylesheet", "script")

    let blockingBytes = 0
    let unmatched = 0
    for (const url of [...syncScriptUrls, ...blockingCssUrls]) {
      const exact = netResources.find((r) => r.url === url)
      const match = exact ?? netResources.find((r) => looseUrlMatch(url, r.url))
      if (match) blockingBytes += match.encodedBytes
      else unmatched++
    }

    const blockingKb = Math.round(blockingBytes / 1024)
    const passed = blockingBytes < BLOCKING_BYTE_BUDGET

    // Reference figure: the old measure (all non-interaction CSS+JS transferred).
    const nonInteraction = netResources.filter((r) => r.phase !== "interaction")
    const refKb = Math.round(
      nonInteraction.reduce((sum, r) => sum + r.encodedBytes, 0) / 1024,
    )

    const parts: string[] = []
    if (syncScriptUrls.length === 0 && blockingCssUrls.length === 0) {
      parts.push(
        "No render-blocking script or stylesheet in <head> (0 KB) — everything is deferred or inlined",
      )
    } else {
      parts.push(
        `Render-blocking payload: ${blockingKb} KB (${syncScriptUrls.length} sync script(s), ${blockingCssUrls.length} blocking stylesheet(s)) — threshold ${Math.round(BLOCKING_BYTE_BUDGET / 1024)} KB`,
      )
    }
    if (unmatched > 0) {
      parts.push(`${unmatched} blocking tag(s) not matched to a network request`)
    }
    parts.push(`for reference: total CSS+JS transferred (non-interaction): ${refKb} KB`)

    return { passed, evidence: parts.join("; ") }
  },
}

/**
 * 20 pts — Right usage of preload + fetchpriority
 *
 * PASS if rawHtml contains ≥1 <link rel="preload"> with an as= attribute
 * AND a fetchpriority attribute appears anywhere in rawHtml.
 */
const preloadPrioControl: Control = {
  id: "cp.preloadprio",
  topicId: 8,
  label: "Preload + fetchpriority used correctly",
  description:
    'rawHtml has ≥1 <link rel="preload" as="..."> and at least one fetchpriority attribute.',
  defaultPoints: 20,
  evaluate(e) {
    // Find <link rel="preload" as="...">
    const linkTags = e.rawHtml.match(/<link\b[^>]*>/gi) ?? []
    const preloadWithAs = linkTags.filter((tag) => {
      const isPreload = /\brel\s*=\s*["']?preload["']?/i.test(tag)
      const hasAs = /\bas\s*=/i.test(tag)
      return isPreload && hasAs
    })

    const hasFetchpriority = /\bfetchpriority\s*=/i.test(e.rawHtml)

    const hasPreload = preloadWithAs.length > 0

    if (hasPreload && hasFetchpriority) {
      return {
        passed: true,
        evidence: `Found ${preloadWithAs.length} <link rel="preload" as="..."> and fetchpriority attribute in raw HTML`,
      }
    }

    const missing: string[] = []
    if (!hasPreload) missing.push('<link rel="preload" as="..."> (none found)')
    if (!hasFetchpriority) missing.push("fetchpriority attribute (none found)")

    return {
      passed: false,
      evidence: `Missing: ${missing.join("; ")}`,
    }
  },
}

/**
 * 15 pts — link rel=preload in HTTP response headers
 *
 * PASS if the Link response header contains "rel=preload".
 */
const preloadHeaderControl: Control = {
  id: "cp.preloadheader",
  topicId: 8,
  label: "Preload via Link response header",
  description: 'Main response Link header contains rel=preload.',
  defaultPoints: 15,
  evaluate(e) {
    const linkHeader = header(e.mainResponseHeaders, "link") ?? ""

    if (/rel\s*=\s*["']?preload["']?/i.test(linkHeader)) {
      // Grab the first preload directive as evidence snippet. Split only at a
      // comma that starts the next link-value ("<…"), so a comma inside a URL
      // (e.g. <https://x.com/a,b.css>) does not fragment the directive.
      const directives = linkHeader.split(/,(?=\s*<)/)
      const preloadDirective = directives.find((d) => /rel\s*=\s*["']?preload["']?/i.test(d))
      const snippet = (preloadDirective ?? linkHeader).trim().substring(0, 140)
      return {
        passed: true,
        evidence: `Link header contains rel=preload: ${snippet}`,
      }
    }

    return {
      passed: false,
      evidence: linkHeader
        ? `Link header present but no rel=preload directive: ${linkHeader.substring(0, 80)}`
        : "No Link response header found",
    }
  },
}

/**
 * 10 pts — 103 Early Hints
 *
 * The collector fetches the main document with Node's http(s).request (see
 * collector/index.ts) and listens for the 'information' event, which surfaces
 * 1xx interim responses — including a 103 Early Hints response and its headers —
 * that fetch()/undici silently discard.
 */
const earlyHintsControl: Control = {
  id: "cp.earlyhints",
  topicId: 8,
  label: "103 Early Hints",
  description: "A 103 Early Hints interim response was observed for the main document request.",
  defaultPoints: 10,
  evaluate(e) {
    if (e.earlyHints) {
      const linkHeader = e.earlyHints["link"]
      return {
        passed: true,
        evidence: linkHeader
          ? `103 Early Hints response observed with Link header: ${linkHeader.substring(0, 120)}`
          : "103 Early Hints response observed for the main document request",
      }
    }
    return {
      passed: false,
      evidence: "No 103 Early Hints response observed for the main document request",
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const criticalPathTopic: TopicModule = {
  id: 8,
  name: "Critical path",
  hasNA: false,
  standalone: false,
  controls: [
    headOrderControl,      // 30
    limitResourcesControl, // 25
    preloadPrioControl,    // 20
    preloadHeaderControl,  // 15
    earlyHintsControl,     // 10
  ],
}
