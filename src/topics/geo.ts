/**
 * Topic 11 — Technical GEO
 * topicId: 11 | hasNA: false | standalone: true
 * Max points: 40+30+20+10 = 100
 *
 * GEO no longer defines performance thresholds of its own. What a generative
 * engine actually needs is a page it can fetch, read without executing JS, and
 * fetch again cheaply — which the other topics already measure. So each GEO
 * criterion REUSES existing controls verbatim (same evaluate, same verdict) and
 * only regroups them under GEO's own weighting:
 *
 *   40 — Accès au contenu sans JS     ← js.nojsview           (topic 6)
 *   30 — TTFB & Cache HTML            ← ttfb.ttfb800 AND ttfb.cdncache (topic 5)
 *   20 — Compression & CDN global     ← cdn.brotli   AND cdn.region    (topic 10)
 *   10 — Allègement du payload HTML   ← page weight < 1 MB (GEO's own, kept)
 *
 * A composite criterion is ALL-OR-NOTHING: both underlying controls must pass,
 * since a criterion is binary in this engine. The evidence string carries both
 * verdicts so the report still shows which half failed.
 *
 * Reusing the controls (rather than re-implementing the checks) means a fix to
 * the TTFB or Brotli detection lands in GEO at the same time, and a site can
 * never be judged differently on the same fact by two topics.
 */
import type { EvidenceBundle } from "../core"
import type { Control, TopicModule } from "../core"
import { noJsViewControl } from "./js"
import { cdnCacheControl, ttfb800Control } from "./ttfbcache"
import { brotliControl, regionControl } from "./cdn"

/** Verdict of one borrowed control, prefixed with the criterion it stands for. */
function delegate(control: Control, e: EvidenceBundle) {
  const v = control.evaluate(e)
  return { passed: v.passed, evidence: `« ${control.label} » : ${v.evidence}` }
}

/**
 * Two borrowed controls, ANDed. Both verdicts are reported either way, so a
 * failure always names the half responsible.
 */
function both(a: Control, b: Control, e: EvidenceBundle) {
  const va = a.evaluate(e)
  const vb = b.evaluate(e)
  const mark = (ok: boolean) => (ok ? "✓" : "✗")
  return {
    passed: va.passed && vb.passed,
    evidence:
      `${mark(va.passed)} « ${a.label} » : ${va.evidence} | ` +
      `${mark(vb.passed)} « ${b.label} » : ${vb.evidence}`,
  }
}

// ── controls ─────────────────────────────────────────────────────────────────

/** 40 pts — the crawler must see the content without running JS. */
const noJsContentControl: Control = {
  id: "geo.nojscontent",
  topicId: 11,
  label: "Accès au contenu sans JS",
  description:
    "Reprend le critère « Display viewport content without JS » (sujet 6 — JS management) : le HTML serveur porte le contenu du viewport.",
  defaultPoints: 40,
  evaluate: (e) => delegate(noJsViewControl, e),
}

/** 30 pts — the document answers fast and is cached at the edge. */
const ttfbCacheControl: Control = {
  id: "geo.ttfbcache",
  topicId: 11,
  label: "TTFB & Cache HTML",
  description:
    "Reprend « TTFB < 800ms » ET « CDN cache on HTML pages » (sujet 5 — TTFB/Cache). Les deux doivent être validés.",
  defaultPoints: 30,
  evaluate: (e) => both(ttfb800Control, cdnCacheControl, e),
}

/** 20 pts — the document is compressed and served from a distributed edge. */
const compressionCdnControl: Control = {
  id: "geo.compressioncdn",
  topicId: 11,
  label: "Compression & CDN global",
  description:
    "Reprend « Brotli on HTML and text resources » ET « CDN cache by region » (sujet 10 — CDN). Les deux doivent être validés.",
  defaultPoints: 20,
  evaluate: (e) => both(brotliControl, regionControl, e),
}

/** 10 pts — GEO's own criterion: a light page is a cheap page to ingest. */
const weight1mbControl: Control = {
  id: "geo.weight1mb",
  topicId: 11,
  label: "Allègement du payload HTML (< 1 MB)",
  description: "Total transferred bytes across all requests below 1 MB (lab data).",
  defaultPoints: 10,
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

// ── topic module ──────────────────────────────────────────────────────────────

export const geoTopic: TopicModule = {
  id: 11,
  name: "Technical GEO",
  hasNA: false,
  standalone: true,
  controls: [
    noJsContentControl,    // 40
    ttfbCacheControl,      // 30
    compressionCdnControl, // 20
    weight1mbControl,      // 10
  ],
}
