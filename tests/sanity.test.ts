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

describe("assessCaptureHealth", () => {
  it("OK — normal page with assets loaded", () => {
    const e = makeEvidence({
      rawHtml: "<!doctype html><title>Real product page</title><body><img><img><img><img><img></body>",
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

  it("rejects — document request returns 403 mid-capture", () => {
    const e = makeEvidence({
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

  it("rejects — document request returns 404", () => {
    const e = makeEvidence({
      requests: [req({ resourceType: "document", status: 404 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/HTTP 404/)
  })

  it("rejects — title matches a known bot-challenge pattern", () => {
    const e = makeEvidence({
      rawHtml: "<!doctype html><title>Pardon Our Interruption...</title><body></body>",
      requests: [req({ resourceType: "document", status: 200 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/Pardon Our Interruption/)
    expect(health.reason).toMatch(/pardon our interruption/i)
  })

  it("rejects — title matches a Cloudflare challenge page", () => {
    const e = makeEvidence({
      rawHtml: "<!doctype html><title>Just a moment...</title><body></body>",
      requests: [req({ resourceType: "document", status: 200 })],
    })
    expect(assessCaptureHealth(e).ok).toBe(false)
  })

  it("rejects — raw HTML has images but browser captured none", () => {
    const e = makeEvidence({
      rawHtml:
        "<!doctype html><title>Some Product</title><body>" +
        "<img><img><img><img><img><img></body>",
      requests: [req({ resourceType: "document", status: 200 })],
    })
    const health = assessCaptureHealth(e)
    expect(health.ok).toBe(false)
    expect(health.reason).toMatch(/0 image and 0 stylesheet/)
    expect(health.reason).toMatch(/document:1/)
  })

  it("does not flag a legit asset-light page (few <img> tags)", () => {
    const e = makeEvidence({
      rawHtml: "<!doctype html><title>Text-only article</title><body><img></body>",
      requests: [req({ resourceType: "document", status: 200 })],
    })
    expect(assessCaptureHealth(e).ok).toBe(true)
  })

  it("does not flag a page with images loaded via script requests only (SPA)", () => {
    const e = makeEvidence({
      rawHtml: "<!doctype html><title>SPA Product</title><body><img><img><img><img><img></body>",
      requests: [
        req({ resourceType: "document", status: 200 }),
        req({ resourceType: "script", status: 200, url: "https://example.com/app.js" }),
        req({ resourceType: "image", status: 200, url: "https://example.com/a.jpg" }),
      ],
    })
    expect(assessCaptureHealth(e).ok).toBe(true)
  })
})
