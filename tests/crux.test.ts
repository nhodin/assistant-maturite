/**
 * Tests for the CrUX lookup chain.
 *
 * CrUX indexes the URL a user actually landed on, so a capture whose inventory
 * URL redirects (https://us.louisvuitton.com/ → /eng-us/homepage) must be looked
 * up on the post-redirect URL, with the inventory URL and then the origin as
 * fallbacks.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchCruxWithFallback, resolveFinalUrl } from "../src/collector/crux"

const FINAL = "https://us.louisvuitton.com/eng-us/homepage"
const INVENTORY = "https://us.louisvuitton.com/"
const ORIGIN = "https://us.louisvuitton.com"

/** A CrUX 200 carrying a single TTFB p75. */
function record(ttfbMs: number) {
  return {
    ok: true,
    json: async () => ({
      record: {
        metrics: { experimental_time_to_first_byte: { percentiles: { p75: ttfbMs } } },
      },
    }),
  }
}

/** CrUX answers 404 for a URL or origin it has no record for. */
const notFound = { ok: false, json: async () => ({}) }

/** Stub fetch with a map of "which key was asked" → response. */
function stubCrux(answer: (body: { url?: string; origin?: string }) => unknown) {
  const calls: Array<{ url?: string; origin?: string }> = []
  vi.stubGlobal("fetch", async (_endpoint: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    return answer(body)
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchCruxWithFallback", () => {
  it("queries the post-redirect URL first", async () => {
    const calls = stubCrux((b) => (b.url === FINAL ? record(736) : notFound))
    const res = await fetchCruxWithFallback({ finalUrl: FINAL, url: INVENTORY }, "k")
    expect(res).toMatchObject({ ttfbMs: 736, scope: "page", urlKey: FINAL })
    expect(calls).toHaveLength(1)
  })

  it("falls back to the inventory URL when the final URL has no record", async () => {
    stubCrux((b) => (b.url === INVENTORY ? record(500) : notFound))
    const res = await fetchCruxWithFallback({ finalUrl: FINAL, url: INVENTORY }, "k")
    expect(res).toMatchObject({ ttfbMs: 500, scope: "page", urlKey: INVENTORY })
  })

  it("falls back to the origin when no URL-level record exists", async () => {
    stubCrux((b) => (b.origin === ORIGIN ? record(910) : notFound))
    const res = await fetchCruxWithFallback({ finalUrl: FINAL, url: INVENTORY }, "k")
    expect(res).toMatchObject({ ttfbMs: 910, scope: "origin", urlKey: ORIGIN })
  })

  it("tries every URL-level key before any origin key", async () => {
    const calls = stubCrux(() => notFound)
    await fetchCruxWithFallback({ finalUrl: FINAL, url: INVENTORY }, "k")
    expect(calls).toEqual([{ url: FINAL, formFactor: "PHONE" }, { url: INVENTORY, formFactor: "PHONE" }, { origin: ORIGIN, formFactor: "PHONE" }])
  })

  it("does not query the same key twice when url === finalUrl", async () => {
    const calls = stubCrux((b) => (b.url === FINAL ? record(300) : notFound))
    await fetchCruxWithFallback({ finalUrl: FINAL, url: FINAL }, "k")
    expect(calls).toEqual([{ url: FINAL, formFactor: "PHONE" }])
  })

  it("returns null when nothing has field data", async () => {
    stubCrux(() => notFound)
    expect(await fetchCruxWithFallback({ finalUrl: FINAL, url: INVENTORY }, "k")).toBeNull()
  })

  it("ignores a record whose metrics are all empty", async () => {
    stubCrux(() => ({
      ok: true,
      json: async () => ({ record: { metrics: { experimental_time_to_first_byte: {} } } }),
    }))
    expect(await fetchCruxWithFallback({ finalUrl: FINAL, url: INVENTORY }, "k")).toBeNull()
  })

  it("skips the network entirely without an API key", async () => {
    const calls = stubCrux(() => record(100))
    expect(await fetchCruxWithFallback({ finalUrl: FINAL }, undefined)).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe("resolveFinalUrl", () => {
  it("returns the URL the response actually came from", async () => {
    vi.stubGlobal("fetch", async () => ({
      url: FINAL,
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    expect(await resolveFinalUrl(INVENTORY)).toBe(FINAL)
  })

  it("returns the input URL when the request fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET")
    })
    expect(await resolveFinalUrl(INVENTORY)).toBe(INVENTORY)
  })
})
