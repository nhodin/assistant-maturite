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

/**
 * True when a @font-face embeds its font file as a data: URI (base64 or not).
 * Such a font is delivered inside the page's own HTML/CSS — no request, no
 * external domain — so it is self-hosted by construction.
 */
function isDataUriSrc(src: string | undefined): boolean {
  if (!src) return false
  return /url\s*\(\s*['"]?data:/i.test(src)
}

/**
 * True when a @font-face declares an icon font (family name or src file name
 * matching a known icon-font signature).
 */
function isIconFont(f: { family?: string; src?: string }): boolean {
  return ICON_FONT_RE.test(f.family ?? "") || ICON_FONT_RE.test(f.src ?? "")
}

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
  // Drop trailing weight/style/hash tokens (e.g. -700, -Bold, .a1b2c3),
  // repeatedly, so "foo-bold-italic" collapses to "foo" (not "foo-bold").
  const tokenRe =
    /[-_.](?:[0-9]{3}|bold|regular|italic|oblique|light|medium|semibold|thin|black|normal|[0-9a-f]{6,})$/i
  let prev: string
  do {
    prev = base
    base = base.replace(tokenRe, "")
  } while (base !== prev)
  return base.toLowerCase()
}

/**
 * True when a @font-face `src` only resolves to a locally installed font
 * (`src: local("Arial")`) — i.e. no `url(...)` to download. Such rules are
 * adjusted system fallbacks (size-adjust / ascent-override wrappers), not
 * downloaded families, so they must not count toward the 2-family limit.
 */
function isLocalOnlySrc(src: string | undefined): boolean {
  if (!src) return false
  return /local\s*\(/i.test(src) && !/url\s*\(/i.test(src)
}

const SUBSET_TOKEN_RE =
  /(?:^|[/\-_.])(latin|cyrillic|greek|vietnamese|hebrew|arabic|subset|ext)(?:$|[/\-_.?])/i

/** True if a font URL's pathname carries a delimited locale/subset token. */
function hasSubsetToken(url: string): boolean {
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    /* keep raw */
  }
  return SUBSET_TOKEN_RE.test(path)
}

// ── controls ─────────────────────────────────────────────────────────────────

const selfHostControl: Control = {
  id: "fonts.selfhost",
  topicId: 9,
  label: "Self-hosting fonts",
  description:
    "Font files are served from the same registrable domain as the page. A @font-face embedded as a data: URI counts as self-hosted — it issues no request and reaches no external domain.",
  defaultPoints: 30,
  evaluate(e: EvidenceBundle) {
    const fontReqs = requestsOfType(e.requests, "font")
    // A data:-URI @font-face is embedded in the page's own HTML/CSS: it issues no
    // request and reaches no external domain, so it IS self-hosted. Count it on the
    // first-party side rather than letting it look like an unconfirmable font.
    const dataUriFonts = e.fonts.filter((f) => isDataUriSrc(f.src))
    const embedded = dataUriFonts.length
    const embeddedNote = embedded > 0 ? ` + ${embedded} data:-URI @font-face (embedded)` : ""
    if (fontReqs.length === 0 && e.fonts.length === 0) {
      return { passed: true, evidence: "No web fonts loaded" }
    }
    if (fontReqs.length === 0) {
      if (embedded > 0 && embedded === e.fonts.filter((f) => !isLocalOnlySrc(f.src)).length) {
        return {
          passed: true,
          evidence: `No font request — all ${embedded} downloaded @font-face are embedded as data: URIs (self-hosted by construction)`,
        }
      }
      return {
        passed: false,
        evidence: `No font requests observed but ${e.fonts.length} inline @font-face declared — cannot confirm self-hosting${embeddedNote}`,
      }
    }
    const firstPartyReqs = fontReqs.filter((r) => sameSite(r.url, e.finalUrl))
    const firstParty = firstPartyReqs.length + embedded
    const total = fontReqs.length + embedded
    const ratio = firstParty / total
    const passed = ratio > 0.5
    return {
      passed,
      evidence: `${firstPartyReqs.length}/${fontReqs.length} font requests are first-party${embeddedNote} → ${Math.round(ratio * 100)}% self-hosted`,
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
  description:
    "All downloaded @font-face use font-display: swap or optional. @font-face rules whose src is local(...) only are adjusted system fallbacks — nothing is downloaded, so font-display does not apply and they are excluded. Icon fonts are excluded too: swap/optional would flash a fallback letter in place of the glyph, so it is not the recommended value for them (icon fonts are penalized by their own criterion).",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    if (e.fonts.length === 0) {
      return {
        passed: false,
        evidence: "No @font-face rule captured (inline or external stylesheet)",
      }
    }
    const realFonts = e.fonts.filter((f) => !isLocalOnlySrc(f.src))
    const localOnly = e.fonts.length - realFonts.length
    // Icon fonts are out of scope: swap/optional makes the browser paint a
    // fallback *letter* where a glyph belongs, so it is not the recommended
    // value for them. They are already penalized by fonts.noiconfonts.
    const downloaded = realFonts.filter((f) => !isIconFont(f))
    const iconCount = realFonts.length - downloaded.length
    const skipped =
      (localOnly > 0 ? ` (${localOnly} local()-only fallback @font-face ignored)` : "") +
      (iconCount > 0 ? ` (${iconCount} icon font @font-face ignored)` : "")
    if (downloaded.length === 0) {
      return {
        passed: true,
        evidence: `No downloaded @font-face — font-display not applicable${skipped}`,
      }
    }
    const good = downloaded.filter((f) => {
      const d = (f.fontDisplay ?? "").toLowerCase()
      return d === "swap" || d === "optional"
    })
    const passed = good.length === downloaded.length
    // On failure, name the offending families so the report says WHICH font is
    // missing font-display (and with what value) rather than just a count.
    let offenders = ""
    if (!passed) {
      const seen = new Map<string, string>()
      for (const f of downloaded) {
        if (good.includes(f)) continue
        const name = (f.family ?? "").replace(/['"]/g, "").trim() || fontStem(f.src ?? "") || "unnamed @font-face"
        const value = (f.fontDisplay ?? "").trim() || "absent"
        if (!seen.has(name)) seen.set(name, value)
      }
      offenders = ` — missing: ${[...seen].map(([n, v]) => `${n} (font-display: ${v})`).join(", ")}`
    }
    return {
      passed,
      evidence: `${good.length}/${downloaded.length} downloaded @font-face rule(s) use font-display swap/optional${skipped}${offenders}`,
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
  description:
    "At most 2 distinct font families loaded. Counts @font-face family names when any are captured, ignoring rules whose src is local(...) only (adjusted system fallbacks are not downloaded families); falls back to font-file URL stems only when no downloaded @font-face family was captured (avoids double-counting the same font as both a family name and a file stem).",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const families = new Set<string>()
    let localOnly = 0
    for (const f of e.fonts) {
      if (!f.family) continue
      if (isLocalOnlySrc(f.src)) {
        localOnly++
        continue
      }
      families.add(normFamily(f.family))
    }
    // Only fall back to URL stems when NO @font-face family was captured;
    // otherwise the same font counts twice ("Foo Web" family + foo-web stem).
    let source: string
    if (families.size > 0) {
      source = "@font-face families"
    } else {
      for (const r of requestsOfType(e.requests, "font")) {
        families.add(fontStem(r.url))
      }
      source = "font-file URL stems"
    }
    const count = families.size
    const passed = count <= 2
    const skipped = localOnly > 0 ? ` (${localOnly} local()-only fallback @font-face ignored)` : ""
    return {
      passed,
      evidence: `${count} distinct font ${source}: ${[...families].slice(0, 6).join(", ") || "none"}${skipped}`,
    }
  },
}

const fallbackControl: Control = {
  id: "fonts.fallback",
  topicId: 9,
  label: "Adjusted local fallback fonts",
  description:
    "A local system fallback strategy is present: a size-adjust / ascent-override / descent-override metric OR a local(...) source in the @font-face stack (the criterion gives points 'even if there is no size settings').",
  defaultPoints: 20,
  evaluate(e: EvidenceBundle) {
    const hasMetric = e.fonts.some(
      (f) =>
        (f.sizeAdjust ?? "") !== "" ||
        (f.ascentOverride ?? "") !== "" ||
        (f.descentOverride ?? "") !== "",
    )
    const hasLocalSrc = e.fonts.some((f) => /local\(/i.test(f.src ?? ""))
    const htmlHasAdjust = /size-adjust|ascent-override|descent-override/i.test(
      e.rawHtml,
    )
    const passed = hasMetric || hasLocalSrc || htmlHasAdjust
    const signal = hasMetric
      ? "size-adjust/ascent-override/descent-override on @font-face"
      : hasLocalSrc
        ? "local(...) fallback source in @font-face src"
        : htmlHasAdjust
          ? "adjust metric in raw HTML"
          : ""
    return {
      passed,
      evidence: passed
        ? `Adjusted local fallback detected (${signal})`
        : "No adjusted fallback metric or local() source detected in inline or external CSS",
    }
  },
}

const subsettingControl: Control = {
  id: "fonts.subsetting",
  topicId: 9,
  label: "Subsetting by locale",
  description:
    "unicode-range subsetting on @font-face, or multiple font files whose URL pathname carries a delimited locale/subset token (e.g. -latin-ext, .cyrillic).",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const hasUnicodeRange = e.fonts.some((f) => (f.unicodeRange ?? "") !== "")
    if (hasUnicodeRange) {
      return { passed: true, evidence: "unicode-range subsetting present on @font-face" }
    }
    // Multiple font files differing by a locale/subset token in the URL.
    // Require the token to be delimited (bounded on BOTH sides) against the
    // pathname, so "next.woff2"/"text-icons.woff2" don't false-positive on "ext".
    const fontReqs = requestsOfType(e.requests, "font")
    const subsetTokens = fontReqs.filter((r) => hasSubsetToken(r.url))
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
