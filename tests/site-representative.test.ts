/**
 * The one page per site that carries Audience and app web / CDN-WAF in a diag
 * run (src/web/site-representative.ts).
 */
import { describe, it, expect } from "vitest"
import { representativePages } from "../src/web/site-representative"

describe("representativePages", () => {
  it("prefers the HP page, whatever the order", () => {
    const r = representativePages([
      { id: 1, siteId: 7, url: "https://a.fr/p/sku", kind: "PDP" },
      { id: 2, siteId: 7, url: "https://a.fr/fr/", kind: "HP" },
    ])
    expect(r.get(7)).toBe(2)
  })

  it("falls back to the root path, then to the first page", () => {
    const r = representativePages([
      { id: 1, siteId: 1, url: "https://a.fr/hotel/x.shtml", kind: "OTHER" },
      { id: 2, siteId: 1, url: "https://a.fr/", kind: "OTHER" },
      { id: 3, siteId: 2, url: "https://b.fr/c/shoes", kind: "PLP" },
      { id: 4, siteId: 2, url: "https://b.fr/p/sku", kind: "PDP" },
    ])
    expect(r.get(1)).toBe(2)
    expect(r.get(2)).toBe(3)
  })
})
