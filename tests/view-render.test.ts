/**
 * The run view must render even when a view helper is missing.
 *
 * Regression: the diagnostic's verdict rule interpolated `SSR_MIN_WORDS`, which
 * reaches EJS through `viewHelpers`. Views are re-read on every request but the
 * helpers are TypeScript loaded at boot, so a server started before the helper
 * existed threw "SSR_MIN_WORDS is not defined" and returned a 500 for the WHOLE
 * page — the diagnostic became unreachable over one interpolated number.
 */
import { describe, it, expect } from "vitest"
import ejs from "ejs"
import path from "node:path"
import { viewHelpers } from "../src/web/helpers"
import { SSR_MIN_WORDS } from "../src/prospect/detect"

const ROOT = path.join(import.meta.dirname, "..", "src", "web", "views")

// Rendered WITHOUT ejs async mode, like the app: in async mode `include` returns a
// promise and every partial renders as "[object Promise]" — a test artefact that
// would hide exactly what these tests check.

const metrics = {
  overlapRatio: 0.45, rawWords: 2664, overlapOk: false,
  anchor: "h1 non vide", anchorInBody: true, imageCount: 66,
  thresholds: { textRatio: 0.5, minWords: SSR_MIN_WORDS },
}
const run = {
  id: 40, kind: "diag", status: "DONE", browser: "cloak", device: "mobile",
  startedAt: new Date(), finishedAt: new Date(), error: null,
  project: { id: 12, name: "Tests v1" },
  runPages: [{
    id: 1, status: "DONE", url: "https://x.fr/p/a", error: null,
    page: { site: { name: "x.fr", id: 1 }, siteId: 1, kind: "OTHER", label: null },
    diagJson: {
      speed: "GO", seo: "GO", dynamicRendering: false, flags: [],
      stack: { frameworks: [], signals: [] }, navigation: { kind: "mpa" },
      checks: [
        { id: "ssr.user", label: "SSR — utilisateur", passed: true, evidence: "…", metrics },
        { id: "ssr.bot", label: "SSR — crawler", passed: true, evidence: "…", metrics },
      ],
    },
  }],
}
const base = {
  active: "runs", title: "Run #40", run, isDiagRun: true,
  diagSites: [{ siteId: 1 }], diagPending: 0,
  ranking: [], byCategory: [], pendingBySite: {}, unscoredSites: [],
  isLive: false, pendingPages: 0, flash: null,
}

const render = (ctx: Record<string, unknown>) =>
  ejs.renderFile(path.join(ROOT, "run-detail.ejs"), ctx, { root: ROOT })

describe("run-detail, diagnostic run", () => {
  it("states the verdict rule with the REAL threshold, not a copy", async () => {
    const html = await render({ ...viewHelpers, ...base })
    expect(html).toContain("Comment le verdict est établi")
    expect(html).toContain(`au moins ${SSR_MIN_WORDS} mots`)
    expect(html).toContain("Garde anti-coquille")
  })

  it("still renders when the threshold helper is missing (stale server)", async () => {
    const { SSR_MIN_WORDS: _omitted, ...helpersWithout } = viewHelpers as Record<string, unknown>
    const html = await render({ ...helpersWithout, ...base })
    expect(html).toContain("Comment le verdict est établi")
    expect(html).toContain("un minimum de mots")
  })
})

describe("run-progress, live diagnostic run", () => {
  const liveRun = {
    ...run, status: "RUNNING", donePages: 1, totalPages: 18, finishedAt: null,
  }

  it("states the same verdict rule as the finished run — the criteria matter while the results appear", async () => {
    const html = await ejs.renderFile(path.join(ROOT, "partials", "run-progress.ejs"),
      { ...viewHelpers, run: liveRun }, { root: ROOT })
    expect(html).toContain("Comment le verdict est établi")
    expect(html).toContain(`au moins ${SSR_MIN_WORDS} mots`)
    expect(html).toContain("Garde anti-coquille")
  })

  it("leaves the maturity live view alone", async () => {
    const html = await ejs.renderFile(path.join(ROOT, "partials", "run-progress.ejs"),
      { ...viewHelpers, run: { ...liveRun, kind: "maturity", runPages: [] } }, { root: ROOT })
    expect(html).not.toContain("Comment le verdict est établi")
  })
})

describe("crawler cell", () => {
  // The crawler document is judged on the SAME four conditions as the visitor one,
  // but only the visitor's anchor and images have their own columns. A crawler cell
  // showing a healthy word count next to a NOGO would read as a contradiction.
  const metrics = (rawWords: number, anchor: string | null, imageCount: number) => ({
    overlapRatio: 0.7, rawWords, overlapOk: true, anchor, anchorInBody: true, imageCount,
    thresholds: { textRatio: 0.5, minWords: 120 },
  })
  const render = (botPassed: boolean, botMetrics: object, evidence: string) =>
    ejs.renderFile(path.join(ROOT, "partials", "diag-page-table.ejs"), {
      ...viewHelpers,
      run: {
        id: 42, kind: "diag",
        runPages: [{
          id: 2, status: "DONE", url: "https://b.fr/p", error: null,
          page: { site: { name: "b.fr", id: 2 }, siteId: 2, kind: "OTHER", label: null },
          diagJson: {
            speed: "GO", seo: botPassed ? "GO" : "NOGO", dynamicRendering: false, flags: [],
            stack: { frameworks: [], signals: [] }, navigation: { kind: "mpa" },
            checks: [
              { id: "ssr.user", label: "u", passed: true, evidence: "ok", metrics: metrics(2000, "h1 non vide", 20) },
              { id: "ssr.bot", label: "c", passed: botPassed, evidence, metrics: botMetrics },
            ],
          },
        }],
      },
    }, { root: ROOT })

  it("names the cause when the crawler fails on something other than word count", async () => {
    const html = await render(false, metrics(1500, null, 0),
      "1500 mots dans le HTML servi (seuil 120) — OK ; ancrage sémantique : aucun ancrage sémantique")
    expect(html).toContain("1500 mots")
    expect(html).toContain("aucun ancrage sémantique") // the reason, not just the numbers
    expect(html).toContain("titre / H1") // the condition is now shown for the crawler too
  })

  it("stays clean when the crawler document passes", async () => {
    const html = await render(true, metrics(1500, "h1 non vide", 12), "1500 mots … ancrage : h1 … images : 12")
    expect(html).toContain("1500 mots")
    const botCell = html.slice(html.indexOf("1500 mots"), html.indexOf("1500 mots") + 400)
    expect(botCell).toContain("12 images sans JS")
  })
})

describe("merged columns", () => {
  const metrics = (rawWords: number, anchor: string | null, imageCount: number) => ({
    overlapRatio: 0.67, rawWords, overlapOk: true, anchor, anchorInBody: true, imageCount,
    thresholds: { textRatio: 0.5, minWords: 120 },
  })
  const html = () =>
    ejs.renderFile(path.join(ROOT, "partials", "diag-page-table.ejs"), {
      ...viewHelpers,
      run: {
        id: 43, kind: "diag",
        runPages: [{
          id: 3, status: "DONE", url: "https://c.fr/p", error: null,
          page: { site: { name: "c.fr", id: 3 }, siteId: 3, kind: "OTHER", label: null },
          diagJson: {
            speed: "GO", seo: "GO", dynamicRendering: false, flags: [],
            stack: { frameworks: ["nuxt", "vue"], signals: ["Nuxt : …"] },
            navigation: { kind: "mpa" },
            checks: [
              { id: "ssr.user", label: "u", passed: true, evidence: "évidence user", metrics: metrics(2222, "h1 non vide", 9) },
              { id: "ssr.bot", label: "c", passed: true, evidence: "évidence crawler", metrics: metrics(2222, "h1 non vide", 9) },
            ],
          },
        }],
      },
    }, { root: ROOT })

  it("shows the same conditions on both populations", async () => {
    const out = await html()
    // Counted in the table BODY only: the legend above it names the same
    // conditions, and counting those would make this test pass for the wrong reason.
    const body = out.slice(out.indexOf("<tbody>"))
    expect((body.match(/titre \/ H1/g) || []).length).toBe(2)
    expect((body.match(/9 images sans JS/g) || []).length).toBe(2)
    expect((body.match(/2222 mots/g) || []).length).toBe(2)
  })

  it("keeps the tooltips and marks them with an icon", async () => {
    const out = await html()
    expect(out).toContain("évidence user")
    expect(out).toContain("évidence crawler")
    expect((out.match(/info-mark/g) || []).length).toBe(2)
  })

  it("merges navigation and stack into one Techno column", async () => {
    const out = await html()
    expect(out).toContain(">Techno<")
    expect(out).not.toContain(">Stack<")
    expect(out).not.toContain(">Nav<")
    expect(out).toContain("MPA")
    expect(out).toContain("nuxt + vue")
  })
})

describe("status and SPA caveat", () => {
  const metrics = (words: number) => ({
    overlapRatio: 0.67, rawWords: words, overlapOk: true, anchor: "h1 non vide",
    anchorInBody: true, imageCount: 9, thresholds: { textRatio: 0.5, minWords: 120 },
  })
  const page = (status: string, over: Record<string, unknown> = {}) => ({
    id: 5, status, url: "https://d.fr/p", error: null,
    page: { site: { name: "d.fr", id: 5 }, siteId: 5, kind: "OTHER", label: null },
    diagJson: status === "DONE" ? {
      speed: "GO", seo: "GO", dynamicRendering: false, flags: [],
      stack: { frameworks: ["nuxt"], signals: [] }, navigation: { kind: "mpa" },
      checks: [
        { id: "ssr.user", label: "u", passed: true, evidence: "ok", metrics: metrics(2222) },
        { id: "ssr.bot", label: "c", passed: true, evidence: "ok", metrics: metrics(2222) },
      ],
      ...over,
    } : null,
  })
  const render = (rp: unknown) =>
    ejs.renderFile(path.join(ROOT, "partials", "diag-page-table.ejs"),
      { ...viewHelpers, run: { id: 45, kind: "diag", runPages: [rp] } }, { root: ROOT })

  it("drops the status column — a DONE page said nothing", async () => {
    const out = await render(page("DONE"))
    const headers = [...out.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1].trim())
    expect(headers).not.toContain("Statut")
    expect(out.slice(out.indexOf("<tbody>"))).not.toContain("b-DONE")
  })

  it("shows a non-DONE status on the site cell instead", async () => {
    const out = await render(page("FAILED"))
    const siteCell = out.slice(out.indexOf("<tbody>"), out.indexOf("</td>", out.indexOf("<tbody>")))
    expect(siteCell).toContain("d.fr")
    expect(siteCell).toContain("FAILED")
  })

  it("warns about client-side routing under a Speed GO", async () => {
    const out = await render(page("DONE", { navigation: { kind: "spa" } }))
    expect(out).toContain("SPA")
    expect(out).toContain("diag-warn")
    expect(out).toContain("premier chargement") // the reason lives in the tooltip, not the label
  })

  it("stays silent on an MPA, and on a SPA that is not a Speed GO", async () => {
    expect(await render(page("DONE"))).not.toContain("diag-warn")
    const nogo = await render(page("DONE", { speed: "NOGO", navigation: { kind: "spa" } }))
    expect(nogo).not.toContain("diag-warn")
  })
})
