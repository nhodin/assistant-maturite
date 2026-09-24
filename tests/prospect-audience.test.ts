/**
 * Audience column of a diagnostic: CrUX popularity rank (BigQuery dataset, FR +
 * worldwide) and mobile share (CrUX API). Informational — never part of the verdict.
 */
import { describe, it, expect, vi } from "vitest"
import { audienceTier, monthLabel, rankLabel, withRankFailure, withRanks } from "../src/prospect/audience"
import { candidateMonths, classifyBqError, cruxBqConfig, foldCruxRanks, rankFailureWarning, type CruxRankRow } from "../src/collector/crux-rank"
import { parseCruxFormFactors } from "../src/collector/crux"
import { renderDiagCsv } from "../src/prospect/report"
import type { PageDiagnostic } from "../src/prospect"

describe("audienceTier", () => {
  it("is high up to top 10k FR, mid up to top 100k, low beyond or out of the ranking", () => {
    expect(audienceTier(1000)).toBe("high")
    expect(audienceTier(10000)).toBe("high")
    expect(audienceTier(50000)).toBe("mid")
    expect(audienceTier(100000)).toBe("mid")
    expect(audienceTier(500000)).toBe("low")
    expect(audienceTier(null)).toBe("low")
  })
})

describe("labels", () => {
  it("formats rank buckets and dataset months", () => {
    expect(rankLabel(1000)).toBe("Top 1k")
    expect(rankLabel(50000)).toBe("Top 50k")
    expect(rankLabel(1000000)).toBe("Top 1M")
    expect(rankLabel(50000000)).toBe("Top 50M")
    expect(monthLabel(202608)).toBe("2026-08")
  })
})

describe("candidateMonths", () => {
  it("asks for the three previous months, across a year boundary", () => {
    expect(candidateMonths(new Date(Date.UTC(2026, 8, 24)))).toEqual([202608, 202607, 202606])
    expect(candidateMonths(new Date(Date.UTC(2026, 0, 5)))).toEqual([202512, 202511, 202510])
  })
})

describe("foldCruxRanks", () => {
  const a = "https://www.a.fr"
  const b = "https://www.b.fr"
  const c = "https://www.c.fr"

  it("reads each scope at its own latest month, origins absent that month are null", () => {
    const rows: CruxRankRow[] = [
      { scope: "country", yyyymm: 202607, origin: a, rank: 5000 },
      { scope: "country", yyyymm: 202607, origin: b, rank: 100000 },
      // b was ranked in June too — the older month must not win
      { scope: "country", yyyymm: 202606, origin: b, rank: 50000 },
      // c only in June: out of the July ranking → null, not the stale June rank
      { scope: "country", yyyymm: 202606, origin: c, rank: 10000 },
      // the global table is already published for August
      { scope: "global", yyyymm: 202608, origin: a, rank: 50000 },
    ]
    const r = foldCruxRanks([a, b, c], rows, "fr")
    expect(r.monthCountry).toBe(202607)
    expect(r.monthGlobal).toBe(202608)
    expect(r.ranks.get(a)).toEqual({ origin: a, rankCountry: 5000, rankGlobal: 50000 })
    expect(r.ranks.get(b)).toEqual({ origin: b, rankCountry: 100000, rankGlobal: null })
    expect(r.ranks.get(c)).toEqual({ origin: c, rankCountry: null, rankGlobal: null })
  })

  it("leaves the months undefined when no origin was found at all", () => {
    const r = foldCruxRanks([a], [], "fr")
    expect(r.monthCountry).toBeUndefined()
    expect(r.ranks.get(a)).toEqual({ origin: a, rankCountry: null, rankGlobal: null })
  })
})

describe("cruxBqConfig", () => {
  const key = { type: "service_account", project_id: "crux-api-fetch", client_email: "sa@x.iam", private_key: "-----K-----" }
  const creds = { client_email: "sa@x.iam", private_key: "-----K-----" }

  it("is null when nothing is configured", () => {
    expect(cruxBqConfig({})).toBeNull()
  })

  it("takes the key content as raw JSON, the billed project from its project_id", () => {
    expect(cruxBqConfig({ CRUX_BQ_CREDENTIALS: JSON.stringify(key) })).toEqual({ projectId: "crux-api-fetch", credentials: creds })
  })

  it("accepts the key base64-encoded, CRUX_BQ_PROJECT overriding the project", () => {
    const b64 = Buffer.from(JSON.stringify(key, null, 2)).toString("base64")
    expect(cruxBqConfig({ CRUX_BQ_CREDENTIALS: b64, CRUX_BQ_PROJECT: "other" })).toEqual({ projectId: "other", credentials: creds })
  })

  it("falls back to Application Default Credentials with CRUX_BQ_PROJECT alone", () => {
    expect(cruxBqConfig({ CRUX_BQ_PROJECT: "p" })).toEqual({ projectId: "p" })
  })

  it("ignores a malformed key instead of crashing the run", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(cruxBqConfig({ CRUX_BQ_CREDENTIALS: "not a key" })).toBeNull()
    expect(cruxBqConfig({ CRUX_BQ_CREDENTIALS: JSON.stringify({ project_id: "p" }) })).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("withRanks", () => {
  it("merges the run-wide lookup into a page's audience, keeping the mobile share", () => {
    const ranks = foldCruxRanks(
      ["https://www.a.fr"],
      [{ scope: "country", yyyymm: 202607, origin: "https://www.a.fr", rank: 1000 }],
      "fr",
    )
    expect(withRanks({ origin: "https://www.a.fr", mobileShare: 0.8 }, ranks)).toEqual({
      origin: "https://www.a.fr",
      mobileShare: 0.8,
      rankCountry: 1000,
      rankGlobal: null,
      monthCountry: 202607,
      monthGlobal: undefined,
    })
    // an origin the query was not asked about is out of the ranking, not "not queried"
    expect(withRanks({ origin: "https://other.fr" }, ranks).rankCountry).toBeNull()
  })
})

describe("parseCruxFormFactors", () => {
  it("reads the device split, string fractions included", () => {
    expect(
      parseCruxFormFactors({
        record: { metrics: { form_factors: { fractions: { phone: 0.78, desktop: "0.2", tablet: 0.02 } } } },
      }),
    ).toEqual({ phone: 0.78, desktop: 0.2, tablet: 0.02 })
  })
  it("is null without a split", () => {
    expect(parseCruxFormFactors({ record: { metrics: {} } })).toBeNull()
    expect(parseCruxFormFactors(null)).toBeNull()
  })
})

describe("CSV export", () => {
  const base: PageDiagnostic = {
    url: "https://www.a.fr/",
    checks: [],
    speed: "GO",
    seo: "GO",
    dynamicRendering: false,
    flags: [],
  }
  const cols = (csv: string, line: number) => csv.split("\n")[line].split(";")
  const header = (csv: string) => cols(csv, 0)

  it("writes the raw rank bound, 'hors classement', the mobile share and the dataset month", () => {
    const csv = renderDiagCsv([
      {
        site: "A",
        url: base.url,
        status: "DONE",
        diag: {
          ...base,
          audience: {
            origin: "https://www.a.fr",
            rankCountry: 5000,
            rankGlobal: null,
            mobileShare: 0.78,
            monthCountry: 202607,
          },
        },
      },
    ])
    const h = header(csv)
    const row = cols(csv, 1)
    expect(row[h.indexOf("Rang CrUX FR")]).toBe("5000")
    expect(row[h.indexOf("Rang CrUX monde")]).toBe("hors classement")
    expect(row[h.indexOf("Part mobile")]).toBe("78%")
    expect(row[h.indexOf("Mois CrUX")]).toBe("2026-07")
  })

  it("leaves the cells empty when the rank was never queried", () => {
    const csv = renderDiagCsv([
      { site: "A", url: base.url, status: "DONE", diag: { ...base, audience: { origin: "https://www.a.fr" } } },
    ])
    const h = header(csv)
    const row = cols(csv, 1)
    expect(row[h.indexOf("Rang CrUX FR")]).toBe("")
    expect(row[h.indexOf("Rang CrUX monde")]).toBe("")
  })
})

describe("rank query failure", () => {
  it("classifies BigQuery errors: quota, our byte cap, access, other", () => {
    expect(classifyBqError({ code: 403, errors: [{ reason: "quotaExceeded" }], message: "Quota exceeded: Your project exceeded quota for free query bytes scanned" }).kind).toBe("quota")
    expect(classifyBqError({ code: 403, errors: [{ reason: "rateLimitExceeded" }], message: "Exceeded rate limits" }).kind).toBe("quota")
    expect(classifyBqError({ code: 400, errors: [{ reason: "bytesBilledLimitExceeded" }], message: "Query exceeded limit for bytes billed" }).kind).toBe("cap")
    expect(classifyBqError({ code: 403, errors: [{ reason: "accessDenied" }], message: "Access Denied: User does not have bigquery.jobs.create permission" }).kind).toBe("auth")
    expect(classifyBqError(new Error("invalid_grant: Invalid JWT Signature.")).kind).toBe("auth")
    expect(classifyBqError(new Error("socket hang up")).kind).toBe("other")
  })

  it("words a warning that says the diagnostic itself is complete", () => {
    const w = rankFailureWarning(classifyBqError({ errors: [{ reason: "quotaExceeded" }], message: "Quota exceeded" }))
    expect(w).toContain("quota BigQuery dépassé")
    expect(w).toContain("Le diagnostic est complet")
    expect(w).toContain("Quota exceeded")
  })

  it("marks pages 'rank unavailable', keeping a rank an earlier pass already read", () => {
    const f = classifyBqError({ errors: [{ reason: "quotaExceeded" }], message: "q" })
    expect(withRankFailure({ origin: "https://a.fr", mobileShare: 0.5 }, f)).toEqual({ origin: "https://a.fr", mobileShare: 0.5, rankUnavailable: "quota" })
    const ranked = { origin: "https://a.fr", rankCountry: 5000, rankGlobal: null, monthCountry: 202607 }
    expect(withRankFailure(ranked, f)).toBe(ranked)
  })

  it("a later successful query clears the failure mark", () => {
    const ranks = foldCruxRanks(["https://a.fr"], [{ scope: "country", yyyymm: 202607, origin: "https://a.fr", rank: 1000 }], "fr")
    const a = withRanks({ origin: "https://a.fr", rankUnavailable: "quota" }, ranks)
    expect(a.rankUnavailable).toBeUndefined()
    expect(a.rankCountry).toBe(1000)
  })
})
