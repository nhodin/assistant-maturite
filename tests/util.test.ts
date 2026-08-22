/**
 * Tests for shared topic helpers (src/topics/util.ts), focused on the
 * public-suffix-list-aware registrableDomain/sameSite/isThirdParty behavior.
 */
import { describe, it, expect } from "vitest"
import {
  registrableDomain,
  sameSite,
  isThirdParty,
  isFirstParty,
  cacheControlMaxAge,
  cacheControlSharedTtl,
} from "../src/topics/util"

describe("registrableDomain", () => {
  it("simple two-label domain", () => {
    expect(registrableDomain("example.com")).toBe("example.com")
  })
  it("subdomain of a simple TLD", () => {
    expect(registrableDomain("a.b.example.com")).toBe("example.com")
  })
  it("multi-part TLD (co.uk)", () => {
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk")
  })
  it("multi-part TLD (com.au)", () => {
    expect(registrableDomain("www.example.com.au")).toBe("example.com.au")
  })
  it("public suffix host as its own registrable domain (github.io)", () => {
    expect(registrableDomain("foo.github.io")).toBe("foo.github.io")
  })
})

describe("sameSite with multi-part TLDs", () => {
  it("two different github.io subdomains are NOT the same site", () => {
    expect(sameSite("https://foo.github.io/", "https://bar.github.io/")).toBe(false)
  })
  it("two subdomains of the same co.uk site ARE the same site", () => {
    expect(sameSite("https://shop.example.co.uk/", "https://cdn.example.co.uk/a.js")).toBe(true)
  })
  it("a co.uk site vs. an unrelated co.uk site are NOT the same site", () => {
    expect(isThirdParty("https://other.co.uk/x.js", "https://example.co.uk/")).toBe(true)
  })
  it("relative URLs resolve as first-party", () => {
    expect(isFirstParty("/a.js", "https://example.co.uk/")).toBe(true)
  })
})

// ── cache-control parsing ─────────────────────────────────────────────────────
describe("cacheControlMaxAge (browser semantics — max-age only)", () => {
  it("parses max-age", () => {
    expect(cacheControlMaxAge("public, max-age=31536000, immutable")).toBe(31536000)
  })
  it("IGNORES s-maxage and reads max-age", () => {
    expect(cacheControlMaxAge("public, max-age=60, s-maxage=3600")).toBe(60)
  })
  it("returns null when s-maxage is present but max-age is not", () => {
    expect(cacheControlMaxAge("public, s-maxage=3600")).toBeNull()
  })
  it("returns null when no max-age present", () => {
    expect(cacheControlMaxAge("no-cache, no-store")).toBeNull()
  })
  it("is case-insensitive", () => {
    expect(cacheControlMaxAge("Max-Age=86400")).toBe(86400)
  })
  it("handles max-age=0 (distinct from absent)", () => {
    expect(cacheControlMaxAge("max-age=0")).toBe(0)
  })
})

describe("cacheControlSharedTtl (shared/CDN semantics — s-maxage wins)", () => {
  it("prefers s-maxage over max-age", () => {
    expect(cacheControlSharedTtl("public, max-age=60, s-maxage=3600")).toBe(3600)
  })
  it("falls back to max-age", () => {
    expect(cacheControlSharedTtl("public, max-age=600")).toBe(600)
  })
  it("returns null when neither present", () => {
    expect(cacheControlSharedTtl("no-store")).toBeNull()
  })
  it("is case-insensitive on s-maxage", () => {
    expect(cacheControlSharedTtl("public, S-MAXAGE=120")).toBe(120)
  })
  it("handles s-maxage=0 (distinct from absent)", () => {
    expect(cacheControlSharedTtl("public, s-maxage=0, max-age=600")).toBe(0)
  })
})
