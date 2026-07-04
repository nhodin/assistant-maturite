/**
 * Topic 9 — Fonts management
 * topicId: 9 | hasNA: false | standalone: false
 * Max points: 30+10+10+10+10+20+10 = 100
 *
 * e.fonts combines @font-face rules parsed from inline <style> blocks AND from
 * external stylesheet bodies fetched over CDP during capture (see
 * collector/index.ts), so criteria depending on @font-face descriptors
 * (font-display, size-adjust, unicode-range) are not blind to fonts declared in
 * an external stylesheet — the common case.
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import { sameSite, requestsOfType } from "./util"

// ── helpers ──────────────────────────────────────────────────────────────────

const ICON_FONT_RE =
  /font\s*awesome|fontawesome|icomoon|glyphicon|material[\s-]?icons|materialicons|feather|ionicons/i

/** Normalize a font-family value for distinct-family counting. */
function normFamily(family: string): string {
  return family.replace(/['"]/g, "").trim().toLowerCase()
}

/** Best-effort font "family" stem from a font file URL (strip weights/hashes/ext). */
function fontStem(url: string): string {
  let base = url
  try {
    base = new URL(url).pathname
  } catch {
    /* keep raw */
  }
  base = base.split("/").pop() ?? base
  base = base.replace(/\.(woff2?|ttf|otf|eot)(\?.*)?$/i, "")
  // Drop trailing weight/style/hash tokens (e.g. -700, -Bold, .a1b2c3)
  base = base.replace(
    /[-_.](?:[0-9]{3}|bold|regular|italic|light|medium|semibold|thin|black|[0-9a-f]{6,})$/i,
    "",
  )
  return base.toLowerCase()
}

// ── controls ─────────────────────────────────────────────────────────────────

const selfHostControl: Control = {
  id: "fonts.selfhost",
  topicId: 9,
  label: "Self-hosting fonts",
  description: "Font files are served from the same registrable domain as the page.",
  defaultPoints: 30,
  evaluate(e: EvidenceBundle) {
    const fontReqs = requestsOfType(e.requests, "font")
    if (fontReqs.length === 0 && e.fonts.length === 0) {
      return { passed: true, evidence: "No web fonts loaded" }
    }
    if (fontReqs.length === 0) {
      return {
        passed: false,
        evidence: `No font requests observed but ${e.fonts.length} inline @font-face declared — cannot confirm self-hosting`,
      }
    }
    const firstParty = fontReqs.filter((r) => sameSite(r.url, e.finalUrl))
    const ratio = firstParty.length / fontReqs.length
    const passed = ratio > 0.5
    return {
      passed,
      evidence: `${firstParty.length}/${fontReqs.length} font requests are first-party (${Math.round(ratio * 100)}%)`,
    }
  },
}

const woff2Control: Control = {
  id: "fonts.woff2",
  topicId: 9,
  label: "WOFF2 format",
  description: "Font files use the WOFF2 format.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const fontReqs = requestsOfType(e.requests, "font")
    if (fontReqs.length > 0) {
      const woff2 = fontReqs.filter(
        (r) =>
          /\.woff2(\?|$)/i.test(r.url) || /woff2/i.test(r.mimeType ?? ""),
      )
      const ratio = woff2.length / fontReqs.length
      const passed = ratio > 0.5
      return {
        passed,
        evidence: `${woff2.length}/${fontReqs.length} font requests are WOFF2 (${Math.round(ratio * 100)}%)`,
      }
    }
    // Fall back to inline @font-face formats
    if (e.fonts.length > 0) {
      const woff2 = e.fonts.filter((f) => (f.format ?? "").toLowerCase().includes("woff2"))
      const passed = woff2.length > 0 && woff2.length === e.fonts.length
      return {
        passed,
        evidence: `${woff2.length}/${e.fonts.length} inline @font-face declare woff2 format`,
      }
    }
    return { passed: false, evidence: "No fonts to assess" }
  },
}

const fontDisplayControl: Control = {
  id: "fonts.fontdisplay",
  topicId: 9,
  label: "font-display swap/optional",
  description: "All captured @font-face use font-display: swap or optional.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    if (e.fonts.length === 0) {
      return {
        passed: false,
        evidence: "No @font-face rule captured (inline or external stylesheet)",
      }
    }
    const good = e.fonts.filter((f) => {
      const d = (f.fontDisplay ?? "").toLowerCase()
      return d === "swap" || d === "optional"
    })
    const passed = good.length === e.fonts.length
    return {
      passed,
      evidence: `${good.length}/${e.fonts.length} @font-face rule(s) use font-display swap/optional`,
    }
  },
}

const noIconFontsControl: Control = {
  id: "fonts.noiconfonts",
  topicId: 9,
  label: "No icon fonts",
  description: "No icon font (FontAwesome, icomoon, Material Icons, etc.) detected.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const fontReqs = requestsOfType(e.requests, "font")
    const reqHit = fontReqs.find((r) => ICON_FONT_RE.test(r.url))
    const familyHit = e.fonts.find((f) => ICON_FONT_RE.test(f.family ?? ""))
    const htmlHit = ICON_FONT_RE.test(e.rawHtml)
    if (reqHit || familyHit || htmlHit) {
      const where = reqHit
        ? `font request ${reqHit.url}`
        : familyHit
          ? `@font-face family "${familyHit.family}"`
          : "raw HTML reference"
      return { passed: false, evidence: `Icon font detected (${where})` }
    }
    return { passed: true, evidence: "No icon font signature detected" }
  },
}

const max2Control: Control = {
  id: "fonts.max2",
  topicId: 9,
  label: "Max 2 font families",
  description: "At most 2 distinct font families loaded across the page.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const families = new Set<string>()
    for (const f of e.fonts) {
      if (f.family) families.add(normFamily(f.family))
    }
    for (const r of requestsOfType(e.requests, "font")) {
      families.add(fontStem(r.url))
    }
    const count = families.size
    const passed = count <= 2
    return {
      passed,
      evidence: `${count} distinct font family/file group(s) detected: ${[...families].slice(0, 6).join(", ") || "none"}`,
    }
  },
}

const fallbackControl: Control = {
  id: "fonts.fallback",
  topicId: 9,
  label: "Adjusted local fallback fonts",
  description: "A size-adjusted fallback strategy (size-adjust / ascent-override / descent-override) is present.",
  defaultPoints: 20,
  evaluate(e: EvidenceBundle) {
    const fontHasAdjust = e.fonts.some((f) => (f.sizeAdjust ?? "") !== "")
    const htmlHasAdjust = /size-adjust|ascent-override|descent-override/i.test(
      e.rawHtml,
    )
    const passed = fontHasAdjust || htmlHasAdjust
    return {
      passed,
      evidence: passed
        ? "Adjusted fallback font metrics detected (size-adjust/ascent-override/descent-override)"
        : "No adjusted fallback font metrics detected in inline or external CSS",
    }
  },
}

const subsettingControl: Control = {
  id: "fonts.subsetting",
  topicId: 9,
  label: "Subsetting by locale",
  description: "unicode-range subsetting or multiple locale-specific font files present.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const hasUnicodeRange = e.fonts.some((f) => (f.unicodeRange ?? "") !== "")
    if (hasUnicodeRange) {
      return { passed: true, evidence: "unicode-range subsetting present on @font-face" }
    }
    // Multiple font files differing by a locale/subset token in the URL
    const fontReqs = requestsOfType(e.requests, "font")
    const subsetTokens = fontReqs.filter((r) =>
      /(latin|cyrillic|greek|vietnamese|hebrew|arabic|subset|ext)\b/i.test(r.url),
    )
    if (subsetTokens.length >= 1 && fontReqs.length > 1) {
      return {
        passed: true,
        evidence: `${subsetTokens.length} font file(s) carry a locale/subset token in their URL`,
      }
    }
    return {
      passed: false,
      evidence: "No unicode-range or locale-subset font files detected in inline or external CSS",
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const fontsTopic: TopicModule = {
  id: 9,
  name: "Fonts management",
  hasNA: false,
  standalone: false,
  controls: [
    selfHostControl,    // 30
    fallbackControl,    // 20
    woff2Control,       // 10
    fontDisplayControl, // 10
    noIconFontsControl, // 10
    max2Control,        // 10
    subsettingControl,  // 10
  ],
}
