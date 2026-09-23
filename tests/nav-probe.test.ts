/**
 * Tests for the navigation probe's pure parts (src/collector/nav-probe.ts):
 * link selection and the spa/mpa/unknown decision table. `probeNavigation`
 * itself drives a real Playwright Page and is not unit-tested here.
 */
import { describe, it, expect } from "vitest"
import { pickInternalLinks, pickInternalLink, decideNavigation } from "../src/collector/nav-probe"

describe("pickInternalLink", () => {
  const PAGE_URL = "https://www.example.com/fr/home"

  it("picks a same-domain internal link", () => {
    const links = [{ href: "/fr/products" }]
    expect(pickInternalLink(links, PAGE_URL)).toBe("https://www.example.com/fr/products")
  })

  it("resolves a relative href against the page URL", () => {
    const links = [{ href: "products/shoes" }]
    expect(pickInternalLink(links, PAGE_URL)).toBe("https://www.example.com/fr/products/shoes")
  })

  it("skips a hash-only link", () => {
    const links = [{ href: "#section" }]
    expect(pickInternalLink(links, PAGE_URL)).toBeNull()
  })

  it("skips javascript: links", () => {
    const links = [{ href: "javascript:void(0)" }]
    expect(pickInternalLink(links, PAGE_URL)).toBeNull()
  })

  it("skips mailto: and tel: links", () => {
    const links = [{ href: "mailto:a@b.com" }, { href: "tel:+33100000000" }]
    expect(pickInternalLink(links, PAGE_URL)).toBeNull()
  })

  it("skips target=_blank links", () => {
    const links = [{ href: "/fr/products", targetBlank: true }]
    expect(pickInternalLink(links, PAGE_URL)).toBeNull()
  })

  it("skips a link that resolves to the current URL", () => {
    const links = [{ href: PAGE_URL }]
    expect(pickInternalLink(links, PAGE_URL)).toBeNull()
  })

  it("skips a link that resolves to the current URL plus a hash", () => {
    const links = [{ href: PAGE_URL + "#top" }]
    expect(pickInternalLink(links, PAGE_URL)).toBeNull()
  })

  it("skips a third-party domain link", () => {
    const links = [{ href: "https://other.com/page" }]
    expect(pickInternalLink(links, PAGE_URL)).toBeNull()
  })

  it("accepts a different subdomain of the same registrable domain", () => {
    const links = [{ href: "https://shop.example.com/cart" }]
    expect(pickInternalLink(links, PAGE_URL)).toBe("https://shop.example.com/cart")
  })

  it("skips ineligible links and picks the first eligible one", () => {
    const links = [
      { href: "#top" },
      { href: "javascript:void(0)" },
      { href: "https://other.com/x" },
      { href: "/fr/products" },
      { href: "/fr/about" },
    ]
    expect(pickInternalLink(links, PAGE_URL)).toBe("https://www.example.com/fr/products")
  })

  it("returns null when nothing qualifies", () => {
    const links = [{ href: "#top" }, { href: "https://other.com/x" }]
    expect(pickInternalLink(links, PAGE_URL)).toBeNull()
  })

  it("returns null when the page URL itself is unparseable", () => {
    expect(pickInternalLink([{ href: "/a" }], "not a url")).toBeNull()
  })
})

describe("decideNavigation", () => {
  it("unknown when no eligible link was found", () => {
    const r = decideNavigation({ linkUrl: null, clicked: false })
    expect(r.kind).toBe("unknown")
    expect(r.note).toMatch(/aucun lien/i)
  })

  it("unknown when the click itself failed", () => {
    const r = decideNavigation({ linkUrl: "https://example.com/a", clicked: false })
    expect(r.kind).toBe("unknown")
    expect(r.note).toMatch(/clic/i)
  })

  it("spa when the window marker survived the click", () => {
    const r = decideNavigation({
      linkUrl: "https://example.com/a",
      clicked: true,
      landedUrl: "https://example.com/a",
      contextSurvived: true,
      documentRequested: false,
    })
    expect(r.kind).toBe("spa")
    expect(r.contextSurvived).toBe(true)
  })

  it("spa takes precedence even if a document request also fired", () => {
    const r = decideNavigation({
      linkUrl: "https://example.com/a",
      clicked: true,
      contextSurvived: true,
      documentRequested: true,
    })
    expect(r.kind).toBe("spa")
  })

  it("mpa when the marker is gone and a new document request was observed", () => {
    const r = decideNavigation({
      linkUrl: "https://example.com/a",
      clicked: true,
      landedUrl: "https://example.com/a",
      contextSurvived: false,
      documentRequested: true,
    })
    expect(r.kind).toBe("mpa")
  })

  it("unknown when neither signal fired", () => {
    const r = decideNavigation({
      linkUrl: "https://example.com/a",
      clicked: true,
      contextSurvived: false,
      documentRequested: false,
    })
    expect(r.kind).toBe("unknown")
    expect(r.note).toMatch(/ni routing/i)
  })

  it("unknown with a timeout note when the navigation never settled", () => {
    const r = decideNavigation({
      linkUrl: "https://example.com/a",
      clicked: true,
      contextSurvived: false,
      documentRequested: false,
      timedOut: true,
    })
    expect(r.kind).toBe("unknown")
    expect(r.note).toMatch(/délai/i)
  })
})

describe("pickInternalLinks", () => {
  const page = "https://shop.example.com/p/item"

  it("returns several candidates, not just the header logo", () => {
    const links = [
      { href: "/" },                       // logo — usually under a sticky header/overlay
      { href: "#main" },                   // skipped: hash
      { href: "/category/shoes" },
      { href: "https://facebook.com/x" },  // skipped: third party
      { href: "/p/other", targetBlank: true }, // skipped: new tab
      { href: "/help" },
    ]
    expect(pickInternalLinks(links, page)).toEqual([
      "https://shop.example.com/",
      "https://shop.example.com/category/shoes",
      "https://shop.example.com/help",
    ])
  })

  it("caps the list and drops duplicates", () => {
    const links = [{ href: "/a" }, { href: "/a" }, { href: "/b" }, { href: "/c" }]
    expect(pickInternalLinks(links, page, 2)).toEqual([
      "https://shop.example.com/a",
      "https://shop.example.com/b",
    ])
  })

  it("returns nothing when no link qualifies", () => {
    expect(pickInternalLinks([{ href: "#x" }, { href: "mailto:a@b.c" }], page)).toEqual([])
  })
})
