/**
 * Unit tests for Topic 10 — CDN
 * One passing + one failing case per control, using makeEvidence() fixtures.
 */
import { describe, it, expect } from "vitest"
import { makeEvidence } from "../src/core/fixture"
import { cdnTopic, cacheControlMaxAge } from "../src/topics/cdn"

function ctrl(id: string) {
  const c = cdnTopic.controls.find((c) => c.id === id)
  if (!c) throw new Error(`Control not found: ${id}`)
  return c
}

// ── cacheControlMaxAge helper ────────────────────────────────────────────────
describe("cacheControlMaxAge helper", () => {
  it("parses max-age from a cache-control header", () => {
    expect(cacheControlMaxAge("public, max-age=31536000, immutable")).toBe(31536000)
  })

  it("returns -1 when no max-age present", () => {
    expect(cacheControlMaxAge("no-cache, no-store")).toBe(-1)
  })

  it("handles case-insensitive max-age", () => {
    expect(cacheControlMaxAge("Max-Age=86400")).toBe(86400)
  })

  it("handles max-age=0", () => {
    expect(cacheControlMaxAge("max-age=0")).toBe(0)
  })
})

// ── cdn.brotli ────────────────────────────────────────────────────────────────
describe("cdn.brotli", () => {
  it("passes when HTML uses br and majority of text resources use br", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "content-encoding": "br" },
      requests: [
        { url: "style.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "br" }, mimeType: "text/css" },
        { url: "app.js", resourceType: "script", status: 200, fromCache: false, encodedBytes: 20000, decodedBytes: 80000, requestHeaders: {}, responseHeaders: { "content-encoding": "br" }, mimeType: "text/javascript" },
      ],
    })
    const result = ctrl("cdn.brotli").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("br")
  })

  it("passes when HTML uses zstd (also accepted as modern compression)", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "content-encoding": "zstd" },
      requests: [
        { url: "style.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "zstd" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.brotli").evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("fails when HTML uses gzip", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "content-encoding": "gzip" },
      requests: [
        { url: "style.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "gzip" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.brotli").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("gzip")
  })

  it("fails when HTML has no content-encoding", () => {
    const e = makeEvidence({ mainResponseHeaders: {} })
    const result = ctrl("cdn.brotli").evaluate(e)
    expect(result.passed).toBe(false)
  })

  it("ignores third-party CSS/JS — only main-domain resources count", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      mainResponseHeaders: { "content-encoding": "br" },
      requests: [
        // Main domain: all br → should pass regardless of third-party encodings
        { url: "https://example.com/app.js", resourceType: "script", status: 200, fromCache: false, encodedBytes: 20000, decodedBytes: 80000, requestHeaders: {}, responseHeaders: { "content-encoding": "br" }, mimeType: "text/javascript" },
        // Third parties on gzip — must be excluded from the ratio
        { url: "https://cdn.thirdparty.com/a.js", resourceType: "script", status: 200, fromCache: false, encodedBytes: 30000, decodedBytes: 100000, requestHeaders: {}, responseHeaders: { "content-encoding": "gzip" }, mimeType: "text/javascript" },
        { url: "https://other.example.net/b.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "gzip" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.brotli").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("1/1 same-domain")
  })

  it("fails when HTML uses br but most CSS/JS use gzip", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "content-encoding": "br" },
      requests: [
        { url: "style.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "gzip" }, mimeType: "text/css" },
        { url: "app.js", resourceType: "script", status: 200, fromCache: false, encodedBytes: 20000, decodedBytes: 80000, requestHeaders: {}, responseHeaders: { "content-encoding": "gzip" }, mimeType: "text/javascript" },
        { url: "vendor.js", resourceType: "script", status: 200, fromCache: false, encodedBytes: 30000, decodedBytes: 100000, requestHeaders: {}, responseHeaders: { "content-encoding": "br" }, mimeType: "text/javascript" },
      ],
    })
    const result = ctrl("cdn.brotli").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("1/3")
  })
})

// ── cdn.longttl ────────────────────────────────────────────────────────────────
describe("cdn.longttl", () => {
  it("passes when majority of static assets have long TTL (max-age ≥ 180d)", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.jpg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 50000, decodedBytes: 80000, requestHeaders: {}, responseHeaders: { "cache-control": "public, max-age=31536000" }, mimeType: "image/jpeg" },
        { url: "b.js", resourceType: "script", status: 200, fromCache: false, encodedBytes: 20000, decodedBytes: 60000, requestHeaders: {}, responseHeaders: { "cache-control": "public, max-age=31536000, immutable" }, mimeType: "text/javascript" },
        { url: "c.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "cache-control": "no-cache" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.longttl").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("2/3")
  })

  it("passes when assets use immutable directive", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.js", resourceType: "script", status: 200, fromCache: false, encodedBytes: 20000, decodedBytes: 60000, requestHeaders: {}, responseHeaders: { "cache-control": "public, max-age=3600, immutable" }, mimeType: "text/javascript" },
        { url: "b.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "cache-control": "public, immutable" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.longttl").evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("fails when majority of assets have short TTL", () => {
    const e = makeEvidence({
      requests: [
        { url: "a.jpg", resourceType: "image", status: 200, fromCache: false, encodedBytes: 50000, decodedBytes: 80000, requestHeaders: {}, responseHeaders: { "cache-control": "max-age=3600" }, mimeType: "image/jpeg" },
        { url: "b.js", resourceType: "script", status: 200, fromCache: false, encodedBytes: 20000, decodedBytes: 60000, requestHeaders: {}, responseHeaders: { "cache-control": "max-age=3600" }, mimeType: "text/javascript" },
        { url: "c.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "cache-control": "max-age=86400" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.longttl").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("0/3")
  })

  it("fails when no static assets observed", () => {
    const e = makeEvidence({ requests: [] })
    const result = ctrl("cdn.longttl").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no static/i)
  })
})

// ── cdn.region ────────────────────────────────────────────────────────────────
describe("cdn.region", () => {
  it("passes when cf-ray header is present (Cloudflare fingerprint)", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "cf-ray": "abc123-CDG", "cf-cache-status": "HIT" },
    })
    const result = ctrl("cdn.region").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("cf-ray")
    expect(result.evidence).toContain("inferred")
  })

  it("passes when x-amz-cf-pop header is present (CloudFront fingerprint)", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "x-amz-cf-pop": "CDG50-P1" },
    })
    const result = ctrl("cdn.region").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("x-amz-cf-pop")
  })

  it("passes when x-cache header is present (generic CDN)", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "x-cache": "Hit from cloudfront" },
    })
    const result = ctrl("cdn.region").evaluate(e)
    expect(result.passed).toBe(true)
  })

  it("fails when no CDN fingerprint headers found", () => {
    const e = makeEvidence({ mainResponseHeaders: { "content-type": "text/html", "server": "nginx" } })
    const result = ctrl("cdn.region").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no known cdn/i)
  })
})

// ── cdn.tls13 ────────────────────────────────────────────────────────────────
describe("cdn.tls13", () => {
  it("passes when TLSv1.3 and ipv6 are both true", () => {
    const e = makeEvidence({
      network: { tlsVersion: "TLSv1.3", ipv6: true, alpn: "h2", http3: true },
    })
    const result = ctrl("cdn.tls13").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("TLSv1.3")
    expect(result.evidence).toContain("true")
  })

  it("fails when TLS is 1.2 even with IPv6", () => {
    const e = makeEvidence({
      network: { tlsVersion: "TLSv1.2", ipv6: true, alpn: "h2", http3: false },
    })
    const result = ctrl("cdn.tls13").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("TLSv1.2")
  })

  it("fails when TLS is 1.3 but IPv6 is false", () => {
    const e = makeEvidence({
      network: { tlsVersion: "TLSv1.3", ipv6: false, alpn: "h2", http3: false },
    })
    const result = ctrl("cdn.tls13").evaluate(e)
    expect(result.passed).toBe(false)
  })

  it("fails when both are null (unknown)", () => {
    const e = makeEvidence({
      network: { tlsVersion: null, ipv6: null, alpn: null, http3: null },
    })
    const result = ctrl("cdn.tls13").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("unknown")
  })
})

// ── cdn.zstd ─────────────────────────────────────────────────────────────────
describe("cdn.zstd", () => {
  it("passes when main HTML uses zstd encoding", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "content-encoding": "zstd" },
    })
    const result = ctrl("cdn.zstd").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("zstd")
  })

  it("passes when a CSS resource uses zstd encoding", () => {
    const e = makeEvidence({
      requests: [
        { url: "style.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "zstd" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.zstd").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("zstd")
  })

  it("ignores zstd on a third-party resource (only main domain counts)", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      mainResponseHeaders: { "content-encoding": "br" },
      requests: [
        { url: "https://cdn.thirdparty.com/style.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "zstd" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.zstd").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no zstd/i)
  })

  it("passes when a same-domain CSS resource uses zstd", () => {
    const e = makeEvidence({
      finalUrl: "https://example.com/",
      mainResponseHeaders: { "content-encoding": "br" },
      requests: [
        { url: "https://example.com/style.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "zstd" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.zstd").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("zstd")
  })

  it("fails when no zstd encoding found", () => {
    const e = makeEvidence({
      mainResponseHeaders: { "content-encoding": "br" },
      requests: [
        { url: "style.css", resourceType: "stylesheet", status: 200, fromCache: false, encodedBytes: 5000, decodedBytes: 20000, requestHeaders: {}, responseHeaders: { "content-encoding": "br" }, mimeType: "text/css" },
      ],
    })
    const result = ctrl("cdn.zstd").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatch(/no zstd/i)
  })
})

// ── cdn.http3 ─────────────────────────────────────────────────────────────────
describe("cdn.http3", () => {
  it("passes when network.http3 is true", () => {
    const e = makeEvidence({
      network: { tlsVersion: "TLSv1.3", ipv6: true, alpn: "h3", http3: true },
    })
    const result = ctrl("cdn.http3").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toMatch(/http\/3 negotiated/i)
  })

  it("fails when network.http3 is false", () => {
    const e = makeEvidence({
      network: { tlsVersion: "TLSv1.3", ipv6: true, alpn: "h2", http3: false },
    })
    const result = ctrl("cdn.http3").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("false")
  })

  it("fails when network.http3 is null", () => {
    const e = makeEvidence({
      network: { tlsVersion: null, ipv6: null, alpn: null, http3: null },
    })
    const result = ctrl("cdn.http3").evaluate(e)
    expect(result.passed).toBe(false)
  })
})

// ── cdn.alpn ──────────────────────────────────────────────────────────────────
describe("cdn.alpn", () => {
  it("passes when ALPN is h2", () => {
    const e = makeEvidence({
      network: { tlsVersion: "TLSv1.3", ipv6: true, alpn: "h2", http3: false },
    })
    const result = ctrl("cdn.alpn").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("h2")
  })

  it("passes when ALPN is h3", () => {
    const e = makeEvidence({
      network: { tlsVersion: "TLSv1.3", ipv6: true, alpn: "h3", http3: true },
    })
    const result = ctrl("cdn.alpn").evaluate(e)
    expect(result.passed).toBe(true)
    expect(result.evidence).toContain("h3")
  })

  it("fails when ALPN is null", () => {
    const e = makeEvidence({
      network: { tlsVersion: null, ipv6: null, alpn: null, http3: null },
    })
    const result = ctrl("cdn.alpn").evaluate(e)
    expect(result.passed).toBe(false)
    expect(result.evidence).toContain("null")
  })

  it("fails when ALPN is an empty string", () => {
    const e = makeEvidence({
      network: { tlsVersion: "TLSv1.3", ipv6: false, alpn: "", http3: false },
    })
    const result = ctrl("cdn.alpn").evaluate(e)
    expect(result.passed).toBe(false)
  })
})

// ── meta: verify topic structure ───────────────────────────────────────────────
describe("cdnTopic metadata", () => {
  it("has topicId 10", () => {
    expect(cdnTopic.id).toBe(10)
  })

  it("has 7 controls", () => {
    expect(cdnTopic.controls).toHaveLength(7)
  })

  it("total defaultPoints sum to 100", () => {
    const total = cdnTopic.controls.reduce((sum, c) => sum + c.defaultPoints, 0)
    expect(total).toBe(100)
  })

  it("has hasNA=false and standalone=false", () => {
    expect(cdnTopic.hasNA).toBe(false)
    expect(cdnTopic.standalone).toBe(false)
  })
})
