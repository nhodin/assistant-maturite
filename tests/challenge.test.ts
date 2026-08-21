/**
 * Tests for the bot-challenge wait (src/collector/challenge.ts) — the phase that
 * lets a self-clearing Cloudflare/Akamai interstitial hand over to the real page
 * before the capture measures anything.
 */
import { describe, it, expect } from "vitest"
import type { Page } from "playwright"
import {
  isChallengeTitle,
  isChallengeHtml,
  waitForChallengeToSettle,
  challengeTimeoutFromEnv,
} from "../src/collector/challenge"

/**
 * Minimal Page stand-in: `titles` is consumed one entry per poll, so a test can
 * script "challenge, challenge, real page". The last entry sticks.
 */
function fakePage(titles: string[], opts: { throwOn?: number } = {}): Page {
  let call = 0
  return {
    async title() {
      const index = call++
      if (opts.throwOn === index) throw new Error("Execution context was destroyed")
      return titles[Math.min(index, titles.length - 1)]
    },
    async evaluate() {
      return false
    },
    async waitForLoadState() {
      return undefined
    },
  } as unknown as Page
}

describe("isChallengeTitle / isChallengeHtml", () => {
  it("matches known self-clearing interstitials", () => {
    expect(isChallengeTitle("Just a moment...")).toBe(true)
    expect(isChallengeTitle("Attention Required! | Cloudflare")).toBe(true)
    expect(isChallengeTitle("Pardon Our Interruption")).toBe(true)
  })

  it("does not match a real page, nor a permanent error page", () => {
    expect(isChallengeTitle("KENZO Parfums — Homepage")).toBe(false)
    // A 404 never resolves itself, so waiting on it would only burn capture time.
    expect(isChallengeTitle("Page not found")).toBe(false)
  })

  it("reads the title out of raw HTML", () => {
    expect(isChallengeHtml("<html><head><title>Just a moment...</title></head></html>")).toBe(true)
    expect(isChallengeHtml("<html><head><title>Sac Cabas</title></head></html>")).toBe(false)
    expect(isChallengeHtml("")).toBe(false)
  })
})

describe("waitForChallengeToSettle", () => {
  it("returns at once on a normal page", async () => {
    const outcome = await waitForChallengeToSettle(fakePage(["Real page"]))
    expect(outcome).toEqual({ challenged: false, cleared: false, waitedMs: 0 })
  })

  it("waits out a challenge that hands over to the real page", async () => {
    const page = fakePage(["Just a moment...", "Just a moment...", "Real page"])
    const outcome = await waitForChallengeToSettle(page, { pollMs: 5, timeoutMs: 2000 })
    expect(outcome.challenged).toBe(true)
    expect(outcome.cleared).toBe(true)
  })

  it("treats a destroyed execution context as still-challenged, then settles", async () => {
    // Mid-handover the context dies; the next poll sees the new document.
    const page = fakePage(["Just a moment...", "", "Real page"], { throwOn: 1 })
    const outcome = await waitForChallengeToSettle(page, { pollMs: 5, timeoutMs: 2000 })
    expect(outcome.cleared).toBe(true)
  })

  it("gives up on a challenge that never clears (interactive one, left alone)", async () => {
    const page = fakePage(["Just a moment..."])
    const outcome = await waitForChallengeToSettle(page, { pollMs: 5, timeoutMs: 60 })
    expect(outcome).toMatchObject({ challenged: true, cleared: false })
  })
})

describe("challengeTimeoutFromEnv", () => {
  it("defaults to 30s, and takes an explicit override", () => {
    expect(challengeTimeoutFromEnv({})).toBe(30000)
    expect(challengeTimeoutFromEnv({ CAPTURE_CHALLENGE_TIMEOUT_MS: "90000" })).toBe(90000)
    // 0 disables the wait entirely — a challenged capture is then rejected at once.
    expect(challengeTimeoutFromEnv({ CAPTURE_CHALLENGE_TIMEOUT_MS: "0" })).toBe(0)
  })

  it("falls back to the default on garbage or negative values", () => {
    expect(challengeTimeoutFromEnv({ CAPTURE_CHALLENGE_TIMEOUT_MS: "soon" })).toBe(30000)
    expect(challengeTimeoutFromEnv({ CAPTURE_CHALLENGE_TIMEOUT_MS: "-5" })).toBe(30000)
    expect(challengeTimeoutFromEnv({ CAPTURE_CHALLENGE_TIMEOUT_MS: "  " })).toBe(30000)
  })
})
