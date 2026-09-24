/**
 * Diagnostic CSV export. One row per PAGE — a site whose pages disagree is the
 * finding, so collapsing them would throw away what the export is for.
 */
import { describe, it, expect } from "vitest"
import { renderDiagCsv, type DiagCsvPage } from "../src/prospect/report"
import type { PageDiagnostic } from "../src/prospect/types"

const metrics = (ratio: number, words: number, anchor: string | null, images: number) => ({
  overlapRatio: ratio, rawWords: words, overlapOk: ratio >= 0.5,
  anchor, anchorInBody: true, imageCount: images,
  thresholds: { textRatio: 0.5, minWords: 120 },
})

const diag = (over: Partial<PageDiagnostic> = {}): PageDiagnostic => ({
  url: "https://x.fr/p",
  speed: "GO", seo: "GO", dynamicRendering: false, flags: [],
  stack: { frameworks: ["nuxt", "vue"], signals: [] },
  navigation: { kind: "mpa" },
  checks: [
    { id: "ssr.user", label: "SSR — utilisateur", passed: true, evidence: "2559 mots", metrics: metrics(0.67, 2559, "h1 non vide", 16) },
    { id: "ssr.bot", label: "SSR — crawler", passed: true, evidence: "2559 mots", metrics: metrics(0.67, 2559, "h1 non vide", 16) },
  ],
  ...over,
})

const row = (csv: string, n: number) => csv.split("\n")[n]

describe("renderDiagCsv", () => {
  it("writes a header and one row per page", () => {
    const csv = renderDiagCsv([
      { site: "a.fr", url: "https://a.fr/p1", status: "DONE", diag: diag() },
      { site: "a.fr", url: "https://a.fr/p2", status: "DONE", diag: diag() },
    ])
    const lines = csv.split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("Site;URL;Statut capture;EdgeSpeed;EdgeSEO;Divergent")
    expect(lines[1]).toContain("https://a.fr/p1")
    expect(lines[2]).toContain("https://a.fr/p2")
  })

  it("carries the measurements for both populations", () => {
    const csv = renderDiagCsv([{ site: "a.fr", url: "https://a.fr/p", status: "DONE", diag: diag() }])
    const cols = row(csv, 1).split(";")
    expect(cols.slice(7, 11)).toEqual(["67%", "2559", "oui", "16"])   // user
    expect(cols.slice(11, 15)).toEqual(["67%", "2559", "oui", "16"])  // Googlebot
  })

  it("flags a site whose pages disagree, on every row of that site", () => {
    const csv = renderDiagCsv([
      { site: "a.fr", url: "https://a.fr/p1", status: "DONE", diag: diag() },
      { site: "a.fr", url: "https://a.fr/p2", status: "DONE", diag: diag({ speed: "NOGO" }) },
      { site: "b.fr", url: "https://b.fr/p", status: "DONE", diag: diag() },
    ])
    expect(row(csv, 1).split(";")[5]).toBe("oui")
    expect(row(csv, 2).split(";")[5]).toBe("oui")
    expect(row(csv, 3).split(";")[5]).toBe("non")
  })

  it("says « bloqué » rather than printing zeros for an unmeasured side", () => {
    // Zeros would read as "measured, and empty" — the opposite of what happened.
    const blocked = diag({
      seo: "UNKNOWN",
      checks: [
        { id: "ssr.user", label: "u", passed: true, evidence: "ok", metrics: metrics(0.7, 2000, "h1", 10) },
        { id: "ssr.bot", label: "c", passed: false, unknown: true, evidence: "fetch crawler bloqué (403)",
          presumption: "présomption favorable, à confirmer" },
      ],
    })
    const cols = row(renderDiagCsv([{ site: "a.fr", url: "https://a.fr/p", status: "DONE", diag: blocked }]), 1).split(";")
    expect(cols[11]).toBe("bloqué")
    expect(cols[12]).toBe("")
    expect(cols[22]).toBe("à confirmer")
  })

  it("spells the presumption out next to the evidence it qualifies", () => {
    const blocked = diag({
      checks: [
        { id: "ssr.user", label: "u", passed: true, evidence: "ok", metrics: metrics(0.7, 2000, "h1", 10) },
        { id: "ssr.bot", label: "c", passed: false, unknown: true, evidence: "bloqué (403)", presumption: "présomption favorable" },
      ],
    })
    const csv = renderDiagCsv([{ site: "a.fr", url: "https://a.fr/p", status: "DONE", diag: blocked }])
    expect(csv).toContain("bloqué (403) — présomption favorable")
  })

  it("keeps an uncaptured page in the export", () => {
    // Dropping it would read as "this page is fine".
    const csv = renderDiagCsv([{ site: "a.fr", url: "https://a.fr/p", status: "FAILED", diag: null }])
    expect(row(csv, 1)).toContain("FAILED")
    expect(row(csv, 1)).toContain("non capturée")
  })

  it("quotes cells containing the delimiter, so columns never shift", () => {
    const withSemicolons = diag({
      checks: [
        { id: "ssr.user", label: "u", passed: true, evidence: "120 mots ; ancrage : h1 ; images : 4", metrics: metrics(0.7, 2000, "h1", 4) },
        { id: "ssr.bot", label: "c", passed: true, evidence: "ok", metrics: metrics(0.7, 2000, "h1", 4) },
      ],
    })
    const csv = renderDiagCsv([{ site: "a.fr", url: "https://a.fr/p", status: "DONE", diag: withSemicolons }])
    expect(csv).toContain('"120 mots ; ancrage : h1 ; images : 4"')
    // Header column count must still match the row column count.
    const count = (s: string) => (s.match(/;/g) || []).length
    expect(count(row(csv, 1).replace(/"[^"]*"/g, "X"))).toBe(count(row(csv, 0)))
  })

  it("sorts by site then URL, so two exports of the same run are comparable", () => {
    const csv = renderDiagCsv([
      { site: "b.fr", url: "https://b.fr/p", status: "DONE", diag: diag() },
      { site: "a.fr", url: "https://a.fr/z", status: "DONE", diag: diag() },
      { site: "a.fr", url: "https://a.fr/a", status: "DONE", diag: diag() },
    ])
    expect(csv.split("\n").slice(1).map((l) => l.split(";")[1])).toEqual([
      "https://a.fr/a", "https://a.fr/z", "https://b.fr/p",
    ])
  })
})
