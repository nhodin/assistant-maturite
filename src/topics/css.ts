/**
 * Topic 7 — CSS management
 * topicId: 7 | hasNA: false | standalone: false
 * Max points: 30+25+20+10+10+5 = 100
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import { isThirdParty, parseTags, headSlice, header } from "./util"

// ── helpers ──────────────────────────────────────────────────────────────────

/** Extract all <style> block contents from rawHtml (including those in <head>). */
function inlineStyleBlocks(html: string): string {
  const blocks: string[] = []
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[1]) blocks.push(m[1])
  }
  return blocks.join("\n")
}

// ── controls ─────────────────────────────────────────────────────────────────

const noExtCssControl: Control = {
  id: "css.noextcss",
  topicId: 7,
  label: "No external CSS in head",
  description: "No <link rel=stylesheet> in <head> pointing to a third-party domain.",
  defaultPoints: 30,
  evaluate(e: EvidenceBundle) {
    const headHtml = headSlice(e.rawHtml)
    const links = parseTags(headHtml, "link")
    const externalCss = links.filter((t) => {
      const rel = (t.attrs["rel"] ?? "").toLowerCase()
      const href = t.attrs["href"] ?? ""
      return rel === "stylesheet" && href !== "" && isThirdParty(href, e.finalUrl)
    })
    if (externalCss.length === 0) {
      const totalCss = links.filter((t) => (t.attrs["rel"] ?? "").toLowerCase() === "stylesheet").length
      return {
        passed: true,
        evidence: `No third-party CSS in <head> (${totalCss} stylesheet link(s), all first-party or none)`,
      }
    }
    const domains = externalCss.map((t) => {
      try { return new URL(t.attrs["href"] ?? "").hostname } catch { return t.attrs["href"] ?? "" }
    }).join(", ")
    return {
      passed: false,
      evidence: `${externalCss.length} external CSS link(s) in <head>: ${domains}`,
    }
  },
}

const orderControl: Control = {
  id: "css.order",
  topicId: 7,
  label: "CSS at top of head after meta[viewport]",
  description: "First link[stylesheet] token appears after meta[viewport] and before the first script token in head.order.",
  defaultPoints: 25,
  evaluate(e: EvidenceBundle) {
    const order = e.head.order
    const viewportIdx = order.indexOf("meta[viewport]")
    const firstCssIdx = order.indexOf("link[stylesheet]")
    const firstScriptIdx = order.indexOf("script")

    if (viewportIdx === -1) {
      return {
        passed: false,
        evidence: `meta[viewport] not found in head.order: [${order.join(", ")}]`,
      }
    }
    if (firstCssIdx === -1) {
      return {
        passed: false,
        evidence: `No link[stylesheet] found in head.order: [${order.join(", ")}]`,
      }
    }
    const afterViewport = firstCssIdx > viewportIdx
    const beforeScript = firstScriptIdx === -1 || firstCssIdx < firstScriptIdx
    const passed = afterViewport && beforeScript

    return {
      passed,
      evidence: `head.order: [${order.join(", ")}] — CSS idx=${firstCssIdx}, viewport idx=${viewportIdx}, script idx=${firstScriptIdx === -1 ? "none" : firstScriptIdx}`,
    }
  },
}

const noSvgFontsControl: Control = {
  id: "css.nosvgfonts",
  topicId: 7,
  label: "No inlined SVG or base64 fonts in CSS",
  description: "Inline <style> blocks do not contain data:image/svg or data:font/data:application/font URIs.",
  defaultPoints: 20,
  evaluate(e: EvidenceBundle) {
    const inlineCSS = inlineStyleBlocks(e.rawHtml)
    // SVG data URIs in CSS
    const svgPattern = /data:image\/svg/i
    // Base64 font data URIs (covers data:font/*, data:application/font-*, data:application/x-font-*)
    const fontPattern = /data:(?:font|application\/(?:x-)?font)/i
    const hasSvg = svgPattern.test(inlineCSS)
    const hasFont = fontPattern.test(inlineCSS)
    if (!hasSvg && !hasFont) {
      return {
        passed: true,
        evidence: "No data:image/svg or data:font URIs found in inline <style> blocks (note: external CSS not parsed in POC)",
      }
    }
    const found: string[] = []
    if (hasSvg) found.push("data:image/svg")
    if (hasFont) found.push("data:font/data:application/font")
    return {
      passed: false,
      evidence: `Inlined ${found.join(" and ")} URI(s) detected in inline <style> blocks`,
    }
  },
}

const criticalInlineControl: Control = {
  id: "css.criticalinline",
  topicId: 7,
  label: "Inlined critical CSS",
  description: "At least one non-trivial <style> block in <head> (total inline CSS ≥500 chars).",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const headHtml = headSlice(e.rawHtml)
    const inlineCSS = inlineStyleBlocks(headHtml)
    const len = inlineCSS.trim().length
    const passed = len >= 500
    return {
      passed,
      evidence: passed
        ? `${len} chars of inline CSS in <head> (≥500 threshold — critical CSS likely inlined)`
        : `Only ${len} chars of inline CSS in <head> (< 500 threshold — no significant critical CSS)`,
    }
  },
}

const preloadControl: Control = {
  id: "css.preload",
  topicId: 7,
  label: "CSS preload in response headers",
  description: "Main response Link header contains rel=preload and as=style.",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    const linkHeader = header(e.mainResponseHeaders, "link") ?? ""
    if (!linkHeader) {
      return {
        passed: false,
        evidence: "No Link response header found",
      }
    }
    // Split by comma to handle multiple link directives
    const directives = linkHeader.split(",")
    const cssPreload = directives.find((d) => {
      const hasPreload = /rel\s*=\s*["']?preload["']?/i.test(d)
      const hasStyle = /as\s*=\s*["']?style["']?/i.test(d)
      return hasPreload && hasStyle
    })
    if (cssPreload) {
      return {
        passed: true,
        evidence: `Link header contains CSS preload: ${cssPreload.trim().substring(0, 120)}`,
      }
    }
    return {
      passed: false,
      evidence: `Link header present but no CSS preload (as=style) directive found: ${linkHeader.substring(0, 80)}`,
    }
  },
}

const unusedControl: Control = {
  id: "css.unused",
  topicId: 7,
  label: "Unused CSS < 30%",
  description: "CSS coverage shows < 30% unused rules (e.coverage.cssUnusedPct).",
  defaultPoints: 5,
  evaluate(e: EvidenceBundle) {
    const pct = e.coverage.cssUnusedPct
    if (pct === null) {
      return {
        passed: false,
        evidence: "Unused CSS not measured (CSS coverage unavailable in POC)",
      }
    }
    const passed = pct < 30
    return {
      passed,
      evidence: passed
        ? `CSS unused: ${pct.toFixed(1)}% (< 30% threshold)`
        : `CSS unused: ${pct.toFixed(1)}% (≥ 30% threshold)`,
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const cssTopic: TopicModule = {
  id: 7,
  name: "CSS management",
  hasNA: false,
  standalone: false,
  controls: [
    noExtCssControl,      // 30
    orderControl,         // 25
    noSvgFontsControl,    // 20
    criticalInlineControl, // 10
    preloadControl,       // 10
    unusedControl,        //  5
  ],
}
