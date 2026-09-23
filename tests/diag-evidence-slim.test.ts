/**
 * A diag capture must survive storage in a re-readable form. The maturity stub
 * (rawHtml cut to 2 KB, renderedHtml emptied) would make a stored diagnostic
 * impossible to re-examine — and the documents must still be capped, or a heavy
 * page blows past MySQL's max_allowed_packet and the write fails outright.
 */
import { describe, it, expect } from "vitest"
import { slimEvidence } from "../src/web/runner"
import { makeEvidence } from "../src/core/fixture"

const big = (n: number) => "a".repeat(n)

describe("slimEvidence", () => {
  const bundle = makeEvidence({
    rawHtml: big(300_000),
    renderedHtml: big(300_000),
    bot: {
      userAgent: "Googlebot",
      status: 200,
      html: big(300_000),
      htmlBytes: 300_000,
      responseHeaders: {},
      blocked: false,
    },
  })

  it("keeps the maturity stub unchanged", () => {
    const slim = slimEvidence(bundle) as any
    expect(slim.rawHtml.length).toBe(2000)
    expect(slim.renderedHtml).toBe("")
  })

  it("keeps a readable excerpt of all three documents on a diag run", () => {
    const slim = slimEvidence(bundle, true) as any
    expect(slim.rawHtml.length).toBe(120_000)
    expect(slim.renderedHtml.length).toBe(120_000)
    expect(slim.bot.html.length).toBe(120_000)
  })

  it("stays well inside a 1 MB MySQL packet", () => {
    const slim = slimEvidence(bundle, true)
    expect(Buffer.byteLength(JSON.stringify(slim), "utf-8")).toBeLessThan(900_000)
  })

  it("tolerates a diag capture with no bot fetch", () => {
    const slim = slimEvidence(makeEvidence({ rawHtml: big(10) }), true) as any
    expect(slim.bot).toBeNull()
  })
})
