/**
 * Tests for the bot fetch (src/collector/bot-fetch.ts) — the "HTML bot" side of
 * the prospect diagnostic's GO/NOGO table (docs/DIAGNOSTIC.md). Only the pure
 * `classifyBotFetch` verdict is unit-tested here; `fetchBotHtml` itself does a
 * real network call and is exercised indirectly through the collector.
 */
import { describe, it, expect } from "vitest"
import { classifyBotFetch, fetchBotHtml, rescueBotFetch, GOOGLEBOT_SMARTPHONE_UA } from "../src/collector/bot-fetch"

describe("GOOGLEBOT_SMARTPHONE_UA", () => {
  it("identifies as Googlebot", () => {
    expect(GOOGLEBOT_SMARTPHONE_UA).toMatch(/Googlebot/)
    expect(GOOGLEBOT_SMARTPHONE_UA).toMatch(/Mobile/)
  })
})

describe("classifyBotFetch", () => {
  const REAL_PAGE = `<html><head><title>Sac Cabas</title></head><body>${"contenu ".repeat(50)}</body></html>`

  it("serves normally: not blocked", () => {
    expect(classifyBotFetch(200, REAL_PAGE)).toEqual({ blocked: false })
  })

  it("blocked on HTTP status >= 400", () => {
    const v = classifyBotFetch(403, REAL_PAGE)
    expect(v.blocked).toBe(true)
    expect(v.blockReason).toMatch(/403/)
  })

  it("blocked on a 5xx status too", () => {
    expect(classifyBotFetch(503, REAL_PAGE).blocked).toBe(true)
  })

  it("blocked on a WAF challenge title even with HTTP 200", () => {
    const challenge = "<html><head><title>Just a moment...</title></head><body></body></html>"
    const v = classifyBotFetch(200, challenge)
    expect(v.blocked).toBe(true)
    expect(v.blockReason).toMatch(/challenge/i)
  })

  it("blocked on an empty body", () => {
    const v = classifyBotFetch(200, "")
    expect(v.blocked).toBe(true)
    expect(v.blockReason).toMatch(/vide|courte/i)
  })

  it("blocked on a very short body", () => {
    expect(classifyBotFetch(200, "<html></html>").blocked).toBe(true)
  })

  it("not blocked on a real, sufficiently long 200 page without a challenge title", () => {
    expect(classifyBotFetch(200, REAL_PAGE).blocked).toBe(false)
  })
})

describe("fetchBotHtml", () => {
  const served = {
    html: `<html><head><title>Sac Cabas</title></head><body>${"contenu ".repeat(50)}</body></html>`,
    headers: { "content-type": "text/html" },
    finalUrl: "https://example.com/p/sac",
    earlyHints: null,
    status: 200,
  }

  it("sends the Googlebot UA and reports a served document", async () => {
    let sentUa = ""
    const bot = await fetchBotHtml("https://example.com/p/sac", async (_u, _t, _r, ua) => {
      sentUa = ua ?? ""
      return served
    })
    expect(sentUa).toBe(GOOGLEBOT_SMARTPHONE_UA)
    expect(bot.blocked).toBe(false)
    expect(bot.status).toBe(200)
    expect(bot.htmlBytes).toBe(Buffer.byteLength(served.html, "utf-8"))
    expect(bot.responseHeaders["content-type"]).toBe("text/html")
  })

  it("reports a network failure as blocked rather than throwing", async () => {
    const bot = await fetchBotHtml("https://example.com/", async () => {
      throw new Error("ECONNRESET")
    })
    expect(bot.blocked).toBe(true)
    expect(bot.status).toBe(0)
    expect(bot.blockReason).toMatch(/ECONNRESET/)
  })
})

describe("rescueBotFetch", () => {
  const realPage = `<html><head><title>Sac</title></head><body>${"contenu ".repeat(60)}</body></html>`
  const reply = (status: number, body: string) => ({
    ok: () => status < 400, status: () => status, text: async () => body,
    headers: () => ({ "content-type": "text/html" }),
  })

  it("sends the Googlebot UA through the browser session", async () => {
    let sent: Record<string, string> | undefined
    const bot = await rescueBotFetch("https://x.fr/p", {
      get: async (_u, o) => { sent = o?.headers; return reply(200, realPage) },
    })
    expect(sent?.["user-agent"]).toBe(GOOGLEBOT_SMARTPHONE_UA)
    expect(bot?.blocked).toBe(false)
    expect(bot?.html).toBe(realPage)
  })

  it("returns null when the rescue is refused too — the original reason is kept", async () => {
    const bot = await rescueBotFetch("https://x.fr/p", { get: async () => reply(403, "nope") })
    expect(bot).toBeNull()
  })

  it("returns null on a challenge served with a 200", async () => {
    const challenge = `<html><head><title>Just a moment…</title></head><body></body></html>`
    const bot = await rescueBotFetch("https://x.fr/p", { get: async () => reply(200, challenge) })
    expect(bot).toBeNull()
  })

  it("never throws when the request itself fails", async () => {
    const bot = await rescueBotFetch("https://x.fr/p", {
      get: async () => { throw new Error("ECONNRESET") },
    })
    expect(bot).toBeNull()
  })
})
