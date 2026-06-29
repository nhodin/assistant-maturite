/**
 * Topic 11 — Technical GEO
 * topicId: 11 | hasNA: false | standalone: true
 * Max points: 15+15+10+10+30+15+5 = 100
 *
 * Prefer FIELD data (CrUX/PSI), fall back to LAB (perf object).
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import { bodySlice, wordCount } from "./util"

// ── field-or-lab helpers ─────────────────────────────────────────────────────

function fieldOrLabTtfb(e: EvidenceBundle): { value: number | null; source: string } {
  if (e.field?.ttfbMs !== undefined) {
    return { value: e.field.ttfbMs, source: `field (${e.field.source})` }
  }
  return { value: e.perf.ttfbMs, source: "lab" }
}

function fieldOrLabLcp(e: EvidenceBundle): { value: number | null; source: string } {
  if (e.field?.lcpMs !== undefined) {
    return { value: e.field.lcpMs, source: `field (${e.field.source})` }
  }
  return { value: e.perf.lcpMs, source: "lab" }
}

function fieldOrLabCls(e: EvidenceBundle): { value: number | null; source: string } {
  if (e.field?.cls !== undefined) {
    return { value: e.field.cls, source: `field (${e.field.source})` }
  }
  return { value: e.perf.cls, source: "lab" }
}

// ── controls ─────────────────────────────────────────────────────────────────

const ttfb200Control: Control = {
  id: "geo.ttfb200",
  topicId: 11,
  label: "TTFB < 200ms",
  description: "Time to First Byte below 200ms (field data preferred, lab fallback).",
  defaultPoints: 15,
  evaluate(e) {
    const { value, source } = fieldOrLabTtfb(e)
    if (value === null) {
      return {
        passed: false,
        evidence: `TTFB unavailable (${source} returned null)`,
      }
    }
    const passed = value < 200
    return {
      passed,
      evidence: `TTFB ${value}ms via ${source} — threshold 200ms`,
    }
  },
}

const weight1mbControl: Control = {
  id: "geo.weight1mb",
  topicId: 11,
  label: "Page weight < 1 MB",
  description: "Total transferred bytes across all requests below 1 MB (lab data).",
  defaultPoints: 15,
  evaluate(e) {
    const bytes = e.perf.totalBytes
    if (bytes <= 0) {
      return {
        passed: false,
        evidence: "Page weight unavailable (totalBytes = 0)",
      }
    }
    const mb = (bytes / 1_048_576).toFixed(2)
    const passed = bytes < 1_048_576
    return {
      passed,
      evidence: `Page weight ${mb} MB (${bytes} bytes) — threshold 1 MB`,
    }
  },
}

const lcp25Control: Control = {
  id: "geo.lcp25",
  topicId: 11,
  label: "LCP < 2.5s",
  description: "Largest Contentful Paint below 2500ms (field data preferred, lab fallback).",
  defaultPoints: 10,
  evaluate(e) {
    const { value, source } = fieldOrLabLcp(e)
    if (value === null) {
      return {
        passed: false,
        evidence: `LCP unavailable (${source} returned null)`,
      }
    }
    const passed = value < 2500
    return {
      passed,
      evidence: `LCP ${value}ms via ${source} — threshold 2500ms`,
    }
  },
}

const cls01Control: Control = {
  id: "geo.cls01",
  topicId: 11,
  label: "CLS < 0.1",
  description: "Cumulative Layout Shift below 0.1 (field data preferred, lab fallback).",
  defaultPoints: 10,
  evaluate(e) {
    const { value, source } = fieldOrLabCls(e)
    if (value === null) {
      return {
        passed: false,
        evidence: `CLS unavailable (${source} returned null)`,
      }
    }
    const passed = value < 0.1
    return {
      passed,
      evidence: `CLS ${value} via ${source} — threshold 0.1`,
    }
  },
}

const ssrContentControl: Control = {
  id: "geo.ssrcontent",
  topicId: 11,
  label: "Main content present in initial HTML (SSR)",
  description: "Body of raw HTML contains at least 100 visible words — no critical JS-only content.",
  defaultPoints: 30,
  evaluate(e) {
    const body = bodySlice(e.rawHtml)
    const wc = wordCount(body)
    const passed = wc >= 100
    return {
      passed,
      evidence: `Raw HTML body contains ${wc} visible word(s) — threshold 100`,
    }
  },
}

const ssrRatioControl: Control = {
  id: "geo.ssrratio",
  topicId: 11,
  label: "SSR/rendered content ratio > 70%",
  description: "Visible-text word count in raw HTML divided by rendered DOM word count exceeds 0.7.",
  defaultPoints: 15,
  evaluate(e) {
    const renderedWc = wordCount(e.renderedHtml)
    if (renderedWc === 0) {
      return {
        passed: false,
        evidence: "rendered DOM unavailable (word count = 0)",
      }
    }
    const rawWc = wordCount(e.rawHtml)
    const ratio = Math.min(rawWc / renderedWc, 1.0)
    const pct = Math.round(ratio * 100)
    const passed = ratio > 0.7
    return {
      passed,
      evidence: `SSR ratio ${pct}% (raw ${rawWc} words / rendered ${renderedWc} words) — threshold 70%`,
    }
  },
}

const display2sControl: Control = {
  id: "geo.display2s",
  topicId: 11,
  label: "Content visible within 2s with JS",
  description: "Proxy: lab LCP < 2000ms (content displayed within 2 seconds).",
  defaultPoints: 5,
  evaluate(e) {
    const lcp = e.perf.lcpMs
    if (lcp === null) {
      return {
        passed: false,
        evidence: "LCP unavailable — cannot confirm content visible within 2s",
      }
    }
    const passed = lcp < 2000
    return {
      passed,
      evidence: `Lab LCP ${lcp}ms — threshold 2000ms`,
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const geoTopic: TopicModule = {
  id: 11,
  name: "Technical GEO",
  hasNA: false,
  standalone: true,
  controls: [
    ttfb200Control,    // 15
    weight1mbControl,  // 15
    lcp25Control,      // 10
    cls01Control,      // 10
    ssrContentControl, // 30
    ssrRatioControl,   // 15
    display2sControl,  //  5
  ],
}
