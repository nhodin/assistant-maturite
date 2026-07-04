/**
 * Tests for shared topic helpers (src/topics/util.ts), focused on the
 * public-suffix-list-aware registrableDomain/sameSite/isThirdParty behavior.
 */
import { describe, it, expect } from "vitest"
import { registrableDomain, sameSite, isThirdParty, isFirstParty } from "../src/topics/util"

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
