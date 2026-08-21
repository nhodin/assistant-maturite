/**
 * Tests for the capture health check (src/collector/sanity.ts) — the gate that
 * rejects captures which landed on an error/bot-block page instead of the real
 * site, so the run executor doesn't silently score a broken page.
 */
import { describe, it, expect } from "vitest"
import { assessCaptureHealth } from "../src/collector/sanity"
import { makeEvidence } from "../src/core/fixture"
import type { NetworkRequest } from "../src/core"

function req(overrides: Partial<NetworkRequest> = {}): NetworkRequest {
  return {
    url: "https://example.com/",
    resourceType: "document",
    status: 200,
    fromCache: false,
    encodedBytes: 1000,
    decodedBytes: 1000,
    requestHeaders: {},
    responseHeaders: {},
    mimeType: "text/html",
    ...overrides,
  }
}

// Non-empty main-document headers, so tests exercise a code path *past* the new
// empty-rawHtml / empty-headers gates unless they're deliberately testing those.
const HEADERS = { "content-type": "text/html; charset=utf-8" }

// Filler that pushes rawHtml past the 500-byte "near-empty" threshold. Kept as an
// HTML comment so it doesn't add <img>/<title>/etc. markup the checks look at.
const FILLER = `<!-- ${"padding ".repeat(80)} -->`

/** Build a rawHtml document that clears the near-empty gate, preserving `inner`. */
function html(inner: string): string {
  return `<!doctype html><html><head></head><body>${inner}${FILLER}</body></html>`
}

describe("assessCaptureHealth", () => {
  it("OK — normal page with assets loaded", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Real product page</title><img><img><img><img><img>"),
      mainResponseHeaders: HEADERS,
      requests: [
        req({ resourceType: "document", status: 200 }),
        req({ resourceType: "image", status: 200, url: "https://example.com/a.jpg" }),
        req({ resourceType: "stylesheet", status: 200, url: "https://example.com/a.css" }),
      ],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(true)
    expect(health.reason).toBeNull()
  })

  it("rejects — raw HTML fetch failed / near-empty document", () => {
    const e = makeEvidence({
      rawHtml: "",
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/raw.?HTML/i)
    expect(health.reason).toMatch(/< 500|near-empty|empty/i)
  })

  it("rejects — no main-document response headers captured", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Real product page</title>"),
      mainResponseHeaders: {},
      requests: [req({ resourceType: "document", status: 200 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/response headers/i)
    expect(health.reason).toMatch(/header-based/i)
  })

  it("rejects — document request returns 403 mid-capture", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Real product page</title>"),
      mainResponseHeaders: HEADERS,
      requests: [
        req({ resourceType: "document", status: 200 }),
        req({
          resourceType: "document",
          status: 403,
          phase: "interaction",
          url: "https://example.com/product.html",
        }),
      ],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/HTTP 403/)
    expect(health.reason).toMatch(/interaction/)
    expect(health.reason).toMatch(/https:\/\/example\.com\/product\.html/)
  })

  it("OK — a 403 challenge followed by a 200 on the same URL (challenge waited out)", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Real product page</title>"),
      mainResponseHeaders: HEADERS,
      requests: [
        req({ resourceType: "document", status: 403 }),
        req({ resourceType: "document", status: 200 }),
        req({ resourceType: "image", status: 200, url: "https://example.com/a.jpg" }),
      ],
    })
    expect(assessCaptureHealth(e).ok).toBe(true)
  })

  it("rejects — a 200 followed by a 403 on the same URL (blocked after the fact)", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Real product page</title>"),
      mainResponseHeaders: HEADERS,
      requests: [
        req({ resourceType: "document", status: 200 }),
        req({ resourceType: "document", status: 403 }),
      ],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.kind).toBe("blocked")
  })

  it("rejects — document request returns 404", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Real product page</title>"),
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 404 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/HTTP 404/)
  })

  it("rejects — title matches a known bot-challenge pattern", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Pardon Our Interruption...</title>"),
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/Pardon Our Interruption/)
    expect(health.reason).toMatch(/pardon our interruption/i)
  })

  it("rejects — title matches a Cloudflare challenge page", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Just a moment...</title>"),
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    expect(assessCaptureHealth(e).ok).toBe(false)
  })

  it("rejects — raw HTML has images but browser captured none", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Some Product</title><img><img><img><img><img><img>"),
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/0 image and 0 stylesheet/)
    expect(health.reason).toMatch(/document:1/)
  })

  it("does not flag a legit asset-light page (few <img> tags)", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Text-only article</title><img>"),
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    expect(assessCaptureHealth(e).ok).toBe(true)
  })

  it("does not flag a page with images loaded via script requests only (SPA)", () => {
    const e = makeEvidence({
      rawHtml: html("<title>SPA Product</title><img><img><img><img><img>"),
      mainResponseHeaders: HEADERS,
      requests: [
        req({ resourceType: "document", status: 200 }),
        req({ resourceType: "script", status: 200, url: "https://example.com/app.js" }),
        req({ resourceType: "image", status: 200, url: "https://example.com/a.jpg" }),
      ],
    })
    expect(assessCaptureHealth(e).ok).toBe(true)
  })
})

/**
 * The failure KIND drives the run executor's retry policy: a WAF verdict means
 * further attempts from the same IP mostly harden the block, a technical failure
 * costs nothing to retry with another provider.
 */
describe("assessCaptureHealth — failure kind", () => {
  it("classifies a WAF status on the document as blocked", () => {
    for (const status of [401, 403, 429, 503]) {
      const e = makeEvidence({
        rawHtml: html("<title>Real page</title>"),
        mainResponseHeaders: HEADERS,
        requests: [req({ resourceType: "document", status })],
      })
      expect(assessCaptureHealth(e).kind).toBe("blocked")
    }
  })

  it("classifies a broken URL (404/410) as unusable, not blocked", () => {
    for (const status of [404, 410]) {
      const e = makeEvidence({
        rawHtml: html("<title>Real page</title>"),
        mainResponseHeaders: HEADERS,
        requests: [req({ resourceType: "document", status })],
      })
      expect(assessCaptureHealth(e).kind).toBe("unusable")
    }
  })

  it("classifies a challenge-page title as blocked", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Just a moment...</title>"),
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    expect(assessCaptureHealth(e).kind).toBe("blocked")
  })

  it("classifies markup-with-no-assets as blocked", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Some Product</title><img><img><img><img><img><img>"),
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    expect(assessCaptureHealth(e).kind).toBe("blocked")
  })

  it("classifies an empty raw-HTML capture as unusable — the cause is unknown", () => {
    const e = makeEvidence({
      rawHtml: "",
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    expect(assessCaptureHealth(e).kind).toBe("unusable")
  })

  it("leaves kind unset on a healthy capture", () => {
    const e = makeEvidence({
      rawHtml: html("<title>Text-only article</title><img>"),
      mainResponseHeaders: HEADERS,
      requests: [req({ resourceType: "document", status: 200 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(true)
    expect(health.kind).toBeUndefined()
  })
})
