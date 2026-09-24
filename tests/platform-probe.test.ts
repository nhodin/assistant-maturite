/**
 * Tests for the web-application + CDN/WAF fingerprint (src/collector/platform-probe.ts)
 * — informational only (docs/DIAGNOSTIC.md), never part of the diagnostic verdict.
 */
import { describe, it, expect } from "vitest"
import { detectPlatform, firstPartyCookieNames, PLATFORM_WINDOW_GLOBALS, type PlatformFacts } from "../src/collector/platform-probe"

const facts = (over: Partial<PlatformFacts> = {}): PlatformFacts => ({
  pageUrl: "https://www.brand.com/fr/",
  renderedHtml: "<html><body></body></html>",
  requestUrls: [],
  headers: {},
  ...over,
})

describe("detectPlatform — web application", () => {
  it("detects SFCC from a demandware.static request", () => {
    const r = detectPlatform(facts({
      requestUrls: ["https://www.brand.com/on/demandware.static/Sites-FR-Site/-/fr/v1/js/main.js"],
    }))
    expect(r.platforms).toEqual(["Salesforce Commerce Cloud"])
    expect(r.platformSignals[0]).toMatch(/demandware\.static/)
  })

  it("detects SFCC from its first-party session cookie", () => {
    expect(detectPlatform(facts({ cookieNames: ["dwsid"] })).platforms).toEqual(["Salesforce Commerce Cloud"])
  })

  it("reports PWA Kit alone rather than PWA Kit + SFCC", () => {
    const r = detectPlatform(facts({
      requestUrls: ["https://www.brand.com/mobify/bundle/1234/main.js"],
      cookieNames: ["dwsid"],
    }))
    expect(r.platforms).toEqual(["Salesforce Commerce Cloud (PWA Kit)"])
  })

  it("detects Shopify from headers and cdn.shopify.com", () => {
    const r = detectPlatform(facts({
      headers: { "X-ShopId": "123" },
      requestUrls: ["https://cdn.shopify.com/s/files/1/theme.js"],
    }))
    expect(r.platforms).toEqual(["Shopify"])
  })

  it("detects Hybris from yCmsContentSlot markup", () => {
    const r = detectPlatform(facts({ renderedHtml: `<div class="yCmsContentSlot">x</div>` }))
    expect(r.platforms).toEqual(["SAP Commerce Cloud (Hybris)"])
  })

  it("detects Magento from x-magento-init", () => {
    const r = detectPlatform(facts({ renderedHtml: `<script type="text/x-magento-init">{}</script>` }))
    // The marker is an ATTRIBUTE of the <script> tag, so it survives body stripping.
    expect(r.platforms).toEqual(["Magento / Adobe Commerce"])
  })

  it("detects AEM from a first-party /etc.clientlibs/ request", () => {
    const r = detectPlatform(facts({ requestUrls: ["https://www.brand.com/etc.clientlibs/brand/clientlibs/site.min.js"] }))
    expect(r.platforms).toEqual(["Adobe Experience Manager"])
  })

  it("ignores a first-party-only URL pattern served by a third party", () => {
    const r = detectPlatform(facts({ requestUrls: ["https://blog.partner.com/wp-content/themes/x/style.css"] }))
    expect(r.platforms).toEqual([])
  })

  it("does not read a platform name in a script body", () => {
    const html = `<script>var s = "yCmsContentSlot"; var t = 'text/x-magento-init';</script>`
    expect(detectPlatform(facts({ renderedHtml: html })).platforms).toEqual([])
  })

  it("detects via window globals", () => {
    expect(detectPlatform(facts({ windowGlobals: ["Shopify"] })).platforms).toEqual(["Shopify"])
    expect(PLATFORM_WINDOW_GLOBALS).toContain("dwAnalytics")
  })
})

describe("detectPlatform — CDN / WAF", () => {
  it("detects Akamai + Bot Manager", () => {
    const r = detectPlatform(facts({
      headers: { "server-timing": "cdn-cache; desc=HIT, edge; dur=1, ak_p; desc=\"1_2_3\"" },
      cookieNames: ["_abck", "bm_sz"],
    }))
    expect(r.edge).toEqual(["Akamai Bot Manager", "Akamai"])
  })

  it("detects Cloudflare from cf-ray", () => {
    expect(detectPlatform(facts({ headers: { "cf-ray": "8a-CDG" } })).edge).toEqual(["Cloudflare"])
  })

  it("detects Imperva from its cookies", () => {
    expect(detectPlatform(facts({ cookieNames: ["visid_incap_123", "incap_ses_1_2"] })).edge).toEqual(["Imperva"])
  })

  it("detects Fastly and CloudFront", () => {
    expect(detectPlatform(facts({ headers: { "x-served-by": "cache-par-lfpg1960045-PAR" } })).edge).toEqual(["Fastly"])
    expect(detectPlatform(facts({ headers: { via: "1.1 abc.cloudfront.net (CloudFront)", "x-amz-cf-pop": "CDG50-C1" } })).edge)
      .toEqual(["Amazon CloudFront"])
  })

  it("detects Fasterize", () => {
    expect(detectPlatform(facts({ headers: { "x-fstrz": "p,t,Hi" } })).edge).toContain("Fasterize")
  })

  it("does not infer a CDN from a CSP listing its hostname", () => {
    const r = detectPlatform(facts({
      headers: { "content-security-policy": "script-src https://cdnjs.cloudflare.com https://*.akamaihd.net" },
    }))
    expect(r.edge).toEqual([])
  })

  it("empty facts → empty lists, not undefined", () => {
    const r = detectPlatform(facts())
    expect(r).toEqual({ platforms: [], platformSignals: [], edge: [], edgeSignals: [] })
  })
})

describe("firstPartyCookieNames", () => {
  it("keeps host-only and same-site cookies, drops other domains", () => {
    const names = firstPartyCookieNames([
      "_abck=abc; Domain=.brand.com; Path=/; Secure",
      "dwsid=xyz; Path=/; HttpOnly",
      "__cf_bm=1; Domain=.vendor.io; Path=/",
      "dwsid=dup; Path=/",
    ], "https://www.brand.com/fr/")
    expect(names).toEqual(["_abck", "dwsid"])
  })
})

describe("detectPlatform — layered edges", () => {
  it("names Cloudflare as SFCC's eCDN when the platform is SFCC", () => {
    const r = detectPlatform(facts({ headers: { "cf-ray": "x", "x-akamai-transformed": "9" }, cookieNames: ["dwsid"] }))
    expect(r.edge).toEqual(["Akamai", "Cloudflare (eCDN SFCC)"])
  })
})
