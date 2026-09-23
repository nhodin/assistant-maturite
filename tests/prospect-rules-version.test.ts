/**
 * Rules-version stamping.
 *
 * Why: the EJS views reload per request but the detection code is TypeScript
 * loaded at boot, so a server left running across a rule change keeps scoring
 * with the OLD rules — silently. That produced a confident, wrong NOGO on
 * kiabi.com (scored off a DataDome interstitial, hours after the guard that
 * turns it into « à confirmer » was written), and nothing in the UI could have
 * revealed it. A run now carries the fingerprint of the rules that produced it.
 */
import { describe, it, expect } from "vitest"
import ejs from "ejs"
import path from "node:path"
import {
  diagRulesVersion,
  rulesFreshness,
  resetDiagRulesVersion,
  UNKNOWN_RULES_VERSION,
} from "../src/prospect/rules-version"
import { viewHelpers } from "../src/web/helpers"

describe("diagRulesVersion", () => {
  it("is a short stable hash of the rule sources", () => {
    resetDiagRulesVersion()
    const v = diagRulesVersion()
    expect(v).not.toBe(UNKNOWN_RULES_VERSION)
    expect(v).toMatch(/^[0-9a-f]{12}$/)
    expect(diagRulesVersion()).toBe(v) // memoized, stable within a process
  })
})

describe("rulesFreshness", () => {
  it("reports current for the running version", () => {
    expect(rulesFreshness(diagRulesVersion())).toBe("current")
  })

  it("reports stale for a different known version", () => {
    expect(rulesFreshness("000000000000")).toBe("stale")
  })

  it("never guesses when the stored version is absent", () => {
    // A run captured before stamping existed is unknown, NOT out of date: saying
    // "stale" would be a claim we cannot back.
    expect(rulesFreshness(null)).toBe("unknown")
    expect(rulesFreshness(undefined)).toBe("unknown")
    expect(rulesFreshness("")).toBe("unknown")
    expect(rulesFreshness(UNKNOWN_RULES_VERSION)).toBe("unknown")
  })
})

describe("run-detail banner", () => {
  const ROOT = path.join(import.meta.dirname, "..", "src", "web", "views")
  const run = {
    id: 41, kind: "diag", status: "DONE", browser: "cloak", device: "mobile",
    startedAt: new Date(), finishedAt: new Date(), error: null,
    project: { id: 12, name: "Tests v1" }, runPages: [],
  }
  const render = (diagRules: unknown) =>
    ejs.renderFile(path.join(ROOT, "run-detail.ejs"), {
      ...viewHelpers, active: "runs", title: "Run #41", run, isDiagRun: true,
      diagSites: [], diagPending: 0, diagRules,
      ranking: [], byCategory: [], pendingBySite: {}, unscoredSites: [],
      isLive: false, pendingPages: 0, flash: null,
    }, { root: ROOT })

  it("warns when the run was scored by older rules", async () => {
    const html = await render({ freshness: "stale", stored: "aaaaaaaaaaaa", current: "bbbbbbbbbbbb" })
    expect(html).toMatch(/version antérieure des règles/)
    expect(html).toContain("aaaaaaaaaaaa")
    expect(html).toContain("bbbbbbbbbbbb")
  })

  it("says so plainly when the version is unknown", async () => {
    const html = await render({ freshness: "unknown", stored: null, current: "bbbbbbbbbbbb" })
    expect(html).toMatch(/inconnue/)
    expect(html).not.toMatch(/version antérieure des règles/)
  })

  it("stays silent when the run is current", async () => {
    const html = await render({ freshness: "current", stored: "bbbbbbbbbbbb", current: "bbbbbbbbbbbb" })
    expect(html).not.toMatch(/version antérieure des règles/)
    expect(html).not.toMatch(/Version des règles de détection/)
  })
})
