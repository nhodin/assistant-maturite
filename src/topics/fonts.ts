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
import { isFirstParty, host, requestsOfType } from "./util"

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Icon-font signatures, matched in TECHNICAL contexts only: a font request URL,
 * or the `family` / `src` of a @font-face. There, a token like "material icons"
 * or "feather-icons" can only name an icon font.
 *
 * `feather` alone is deliberately NOT a token: it is a common English word
 * ("feather-light", "ostrich feather") and even `feather.woff2` is plausible for
 * a real decorative typeface — only the explicit `feather-icons` suffix removes
 * the ambiguity.
 */
const ICON_FONT_RE =
  /font\s*awesome|fontawesome|icomoon|glyphicon|material[\s-]?icons|materialicons|feather[-_]?icons?|ionicons/i

/**
 * Narrower set, matched against FREE TEXT (the whole raw HTML, editorial copy
 * included). Only signatures that cannot plausibly occur in running prose:
 * no bare `feather`, and no spaced `material icons` — "material icons" reads as
 * ordinary editorial wording, whereas `material-icons` is the class/family name.
 */
const ICON_FONT_HTML_RE = /fontawesome|icomoon|glyphicon|material-icons|ionicons/i

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
    "No font is served from an external domain. The criterion fails only when a font file comes from a domain other than the page's — a @font-face embedded as a data: URI issues no request and reaches no external domain, so it is out of scope, like a local()-only fallback.",
  defaultPoints: 30,
  evaluate(e: EvidenceBundle) {
    const fontReqs = requestsOfType(e.requests, "font")
    // data:-URI and local()-only @font-face reach no domain at all: they can never
    // make this criterion fail, and they are not evidence for it either.
    const embedded = e.fonts.filter((f) => isDataUriSrc(f.src)).length
    const embeddedNote = embedded > 0 ? `; ${embedded} data:-URI @font-face (no domain)` : ""

    // A font declared on an external domain but never requested during the capture
    // is still an external dependency — read the URLs out of the @font-face src too.
    const declaredHosts = new Set<string>()
    for (const f of e.fonts) {
      if (!f.src || isDataUriSrc(f.src)) continue
      for (const m of f.src.matchAll(/url\s*\(\s*['"]?([^'")]+)/gi)) {
        const url = m[1].trim()
        if (!url || url.toLowerCase().startsWith("data:")) continue
        if (!isFirstParty(url, e.finalUrl)) declaredHosts.add(host(url))
      }
    }
    const externalReqHosts = new Set(
      fontReqs.filter((r) => !isFirstParty(r.url, e.finalUrl)).map((r) => host(r.url)),
    )
    const externalHosts = [...new Set([...externalReqHosts, ...declaredHosts])].filter(Boolean)

    if (externalHosts.length > 0) {
      return {
        passed: false,
        evidence: `Font(s) served from external domain(s): ${externalHosts.join(", ")}${embeddedNote}`,
      }
    }
    if (fontReqs.length === 0 && e.fonts.length === 0) {
      return { passed: true, evidence: "No web fonts loaded" }
    }
    return {
      passed: true,
      evidence: `No font on an external domain (${fontReqs.length} font request(s), all first-party)${embeddedNote}`,
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
    // Fall back to @font-face declarations (inline <style> + external stylesheets).
    if (e.fonts.length > 0) {
      // local()-only rules download nothing — a file format does not apply to them.
      const downloadable = e.fonts.filter((f) => !isLocalOnlySrc(f.src))
      const localOnly = e.fonts.length - downloadable.length
      const skipped =
        localOnly > 0 ? ` (${localOnly} local()-only fallback @font-face ignored)` : ""
      if (downloadable.length === 0) {
        return {
          passed: true,
          evidence: `No downloadable @font-face — WOFF2 not applicable${skipped}`,
        }
      }
      // Many @font-face omit format() but point at a .woff2 URL — accept either signal.
      const woff2 = downloadable.filter(
        (f) =>
          (f.format ?? "").toLowerCase().includes("woff2") ||
          /\.woff2(\?|['")]|$)/i.test(f.src ?? ""),
      )
      const ratio = woff2.length / downloadable.length
      // Same threshold as the network-request path: a majority of WOFF2 is enough.
      const passed = ratio > 0.5
      return {
        passed,
        evidence: `${woff2.length}/${downloadable.length} downloadable @font-face declare woff2 (${Math.round(ratio * 100)}%)${skipped}`,
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
      // No @font-face AND no font request: the page downloads no web font at all,
      // so there is nothing font-display could be missing on → not a fault.
      const fontReqCount = requestsOfType(e.requests, "font").length
      if (fontReqCount === 0) {
        return { passed: true, evidence: "No web font loaded — font-display not applicable" }
      }
      // Fonts ARE downloaded but their @font-face rules escaped capture (CSS body
      // evicted, CDP unavailable, >40 stylesheets, or fonts injected via the
      // FontFace JS API): font-display is unmeasurable, not proven good.
      return {
        passed: false,
        unknown: true,
        evidence: `À confirmer : ${fontReqCount} font request(s) observed but no @font-face rule captured (inline or external stylesheet) — font-display not measurable`,
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
  description:
    "No icon font (FontAwesome, icomoon, Material Icons, etc.) detected. Font requests and @font-face families are technical contexts, matched against the full signature list; the raw HTML is free text (editorial copy included) and is matched only against signatures impossible in running prose — so a fashion page saying \"feather-light down jacket\" is not mistaken for an icon font.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const fontReqs = requestsOfType(e.requests, "font")
    const reqHit = fontReqs.find((r) => ICON_FONT_RE.test(r.url))
    const familyHit = e.fonts.find((f) => ICON_FONT_RE.test(f.family ?? ""))
    const htmlHit = ICON_FONT_HTML_RE.test(e.rawHtml)
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
    "A local system fallback strategy is present: a size-adjust / ascent-override / descent-override metric OR a @font-face dedicated to the fallback (src made of local(...) only, no url()). The idiomatic `src: local(\"Foo\"), url(foo.woff2)` is merely 'use the installed copy if present' — not a fallback strategy — so it does not count. A dedicated local()-only rule does, since the criterion gives points 'even if there is no size settings'.",
  defaultPoints: 20,
  evaluate(e: EvidenceBundle) {
    const hasMetric = e.fonts.some(
      (f) =>
        (f.sizeAdjust ?? "") !== "" ||
        (f.ascentOverride ?? "") !== "" ||
        (f.descentOverride ?? "") !== "",
    )
    // Only a @font-face DEDICATED to the fallback counts: `src: local("Foo"), url(...)`
    // is the standard "use the installed copy if present" idiom, not a fallback strategy.
    const hasLocalOnlyFace = e.fonts.some((f) => isLocalOnlySrc(f.src))
    const htmlHasAdjust = /size-adjust|ascent-override|descent-override/i.test(
      e.rawHtml,
    )
    const passed = hasMetric || hasLocalOnlyFace || htmlHasAdjust
    const signal = hasMetric
      ? "size-adjust/ascent-override/descent-override on @font-face"
      : hasLocalOnlyFace
        ? "dedicated local()-only fallback @font-face"
        : htmlHasAdjust
          ? "adjust metric in raw HTML"
          : ""
    return {
      passed,
      evidence: passed
        ? `Adjusted local fallback detected (${signal})`
        : "No adjusted fallback metric nor dedicated local()-only fallback @font-face detected in inline or external CSS",
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
