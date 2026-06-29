/**
 * Topic 6 — JS management
 * topicId: 6 | hasNA: false | standalone: false
 * Max points: 30+25+20+15+10 = 100
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import {
  parseTags,
  headSlice,
  bodySlice,
  wordCount,
  sameSite,
} from "./util"

// ── helpers ───────────────────────────────────────────────────────────────────

/** True if a script tag has defer, async, or type="module". */
function hasDeferOrModule(attrs: Record<string, string>): boolean {
  return (
    "defer" in attrs ||
    "async" in attrs ||
    (attrs["type"] ?? "").toLowerCase() === "module"
  )
}

/** True if a script src is first-party (same-site or root-relative). */
function isFirstParty(src: string, pageUrl: string): boolean {
  // Root-relative paths (e.g. /js/app.js) are always first-party
  if (src.startsWith("/") && !src.startsWith("//")) return true
  // Protocol-relative or absolute URLs: compare registrable domain
  return sameSite(src, pageUrl)
}

// ── controls ──────────────────────────────────────────────────────────────────

const deferControl: Control = {
  id: "js.defer",
  topicId: 6,
  label: "defer on first-party JS",
  description:
    "Majority (>50%) of first-party <script src> in raw HTML have defer or type=module.",
  defaultPoints: 30,
  evaluate(e: EvidenceBundle) {
    const scripts = parseTags(e.rawHtml, "script")
    const fpScripts = scripts.filter((s) => {
      const src = s.attrs["src"]
      if (!src) return false // inline script
      return isFirstParty(src, e.finalUrl)
    })

    if (fpScripts.length === 0) {
      return {
        passed: false,
        evidence: "no first-party scripts found",
      }
    }

    const withDefer = fpScripts.filter((s) => hasDeferOrModule(s.attrs))
    const pct = Math.round((withDefer.length / fpScripts.length) * 100)
    const passed = withDefer.length / fpScripts.length > 0.5
    return {
      passed,
      evidence: `${withDefer.length}/${fpScripts.length} first-party scripts use defer/module (${pct}%)`,
    }
  },
}

const noJsViewControl: Control = {
  id: "js.nojsview",
  topicId: 6,
  label: "Viewport content without JS (SSR word count)",
  description:
    "Server-rendered body contains ≥80 words of visible text (wordCount of bodySlice(rawHtml)).",
  defaultPoints: 25,
  evaluate(e: EvidenceBundle) {
    const body = bodySlice(e.rawHtml)
    const wc = wordCount(body)
    const passed = wc >= 80
    return {
      passed,
      evidence: `server HTML body word count: ${wc} (threshold: 80)`,
    }
  },
}

const endOfBodyControl: Control = {
  id: "js.endofbody",
  topicId: 6,
  label: "Non-critical JS moved out of <head>",
  description:
    "No blocking <script src> (without defer/async/type=module) found in <head>.",
  defaultPoints: 20,
  evaluate(e: EvidenceBundle) {
    const head = headSlice(e.rawHtml)
    const scripts = parseTags(head, "script")
    // Blocking = has a src but no defer/async/type=module
    const blockingScripts = scripts.filter((s) => {
      if (!s.attrs["src"]) return false // inline script — not counted here
      return !hasDeferOrModule(s.attrs)
    })
    const passed = blockingScripts.length === 0
    return {
      passed,
      evidence: passed
        ? "0 blocking <script src> in <head>"
        : `${blockingScripts.length} blocking <script src> without defer/async/type=module in <head>`,
    }
  },
}

const eventBasedControl: Control = {
  id: "js.eventbased",
  topicId: 6,
  label: "Event-based JS loading",
  description:
    "Cannot verify event-based JS loading from static HTML.",
  defaultPoints: 15,
  evaluate(_e: EvidenceBundle) {
    return {
      passed: false,
      evidence:
        "cannot verify event-based JS loading statically (POC limitation)",
    }
  },
}

const splitTasksControl: Control = {
  id: "js.splittasks",
  topicId: 6,
  label: "Long task splitting (scheduler.yield / no long tasks)",
  description:
    "rawHtml contains 'scheduler.yield' OR no long tasks observed (perf.longTasks.length === 0).",
  defaultPoints: 10,
  evaluate(e: EvidenceBundle) {
    if (e.rawHtml.includes("scheduler.yield")) {
      return {
        passed: true,
        evidence: "\"scheduler.yield\" found in raw HTML",
      }
    }
    if (e.perf.longTasks.length === 0) {
      return {
        passed: true,
        evidence: "no long tasks observed (perf.longTasks is empty)",
      }
    }
    return {
      passed: false,
      evidence: `${e.perf.longTasks.length} long task(s) observed and "scheduler.yield" not found in HTML`,
    }
  },
}

// ── topic module ──────────────────────────────────────────────────────────────

export const jsTopic: TopicModule = {
  id: 6,
  name: "JS management",
  hasNA: false,
  standalone: false,
  controls: [
    deferControl,        // 30
    noJsViewControl,     // 25
    endOfBodyControl,    // 20
    eventBasedControl,   // 15
    splitTasksControl,   // 10
  ],
}
