/**
 * Run 46 regressions: the direct fetch is not always the document a visitor gets.
 *
 * - zarahome / pullandbear / stradivarius / massimodutti: Node got Akamai's
 *   "bm-verify" interstitial (2 KB, title "&nbsp;"), the browser got the page;
 * - marriott: Node got Akamai's behavioural challenge (sec-if-cpt-container);
 * - homeexchange: Node got 28 words, the browser 633 — and the site is already
 *   behind Fasterize.
 * All four read as Speed NOGO. Plus three anchor/image misreads seen on the way.
 */
import { describe, it, expect } from "vitest"
import { blockSignature } from "../src/collector/challenge"
import { ssrUserCheck } from "../src/prospect/checks"
import { detectDynamicRendering, hasRealImage, semanticAnchor, vigilanceFlags } from "../src/prospect/detect"
import { makeEvidence } from "../src/core/fixture"

const words = (n: number, w = "contenu") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ")

const PAGE = `<html><head><title>Échange de maisons | HomeExchange</title></head><body>` +
  `<h1>Rejoignez la communauté n°1 d'échange de maisons</h1><img src="/hero.jpg">` +
  `<p>${words(600, "maison")}</p></body></html>`

const THIN = `<html><head><title>Échange de maisons | HomeExchange</title></head><body>` +
  `<h1>Rejoignez la communauté</h1><img src="/hero.jpg"><p>${words(28)}</p></body></html>`

const BM_VERIFY = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5; URL='/?bm-verify=AAQAAAAO'" />` +
  `<title>&nbsp;</title></head><body><iframe src="/interstitial/ic.html"></iframe>` +
  `<script>function triggerInterstitialChallenge() {}</script></body></html>`

const SEC_CPT = `<!DOCTYPE html><html><body><script src="/KBzxuT/ClI6?v=cba9&t=93"></script>` +
  `<div id="sec-if-cpt-container" role="main" style="display: none"><p class="scf-akamai-protected-by">` +
  `Powered and protected by</p></div></body></html>`

const doc = (html: string, status = 200) => ({ status, html, htmlBytes: html.length })

describe("Akamai interstitials", () => {
  it("recognises the bm-verify interstitial and the behavioural challenge", () => {
    expect(blockSignature(BM_VERIFY)).toBe("interstitiel Akamai Bot Manager")
    expect(blockSignature(SEC_CPT)).toBe("interstitiel Akamai Bot Manager")
  })

  it("does not take the interstitial's '&nbsp;' title for a page identity", () => {
    expect(semanticAnchor(BM_VERIFY).present).toBe(false)
  })
})

describe("visitor judged on the browser's own document", () => {
  it("measures the browser document when the direct fetch got an interstitial", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: BM_VERIFY, renderedHtml: PAGE, browserDoc: doc(PAGE) }))
    expect(check.unknown).toBeUndefined()
    expect(check.passed).toBe(true)
    expect(check.evidence).toMatch(/document reçu par le navigateur \(fetch direct : interstitiel Akamai/)
  })

  it("measures the richer browser document when the direct fetch got a poorer one", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: THIN, renderedHtml: PAGE, browserDoc: doc(PAGE) }))
    expect(check.passed).toBe(true)
    expect(check.evidence).toMatch(/le fetch direct n'a reçu que \d+ mots/)
  })

  it("keeps the direct fetch when it passes, with no note", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: PAGE, renderedHtml: PAGE, browserDoc: doc(THIN) }))
    expect(check.passed).toBe(true)
    expect(check.evidence).not.toMatch(/navigateur/)
  })

  it("is « à confirmer » when both documents were refused", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: BM_VERIFY, renderedHtml: PAGE, browserDoc: doc(SEC_CPT) }))
    expect(check.unknown).toBe(true)
    expect(check.evidence).toMatch(/fetch direct : interstitiel Akamai.*navigateur : interstitiel Akamai/)
  })

  it("ignores an empty browser document", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: BM_VERIFY, renderedHtml: PAGE, browserDoc: doc("") }))
    expect(check.unknown).toBe(true)
  })

  it("sets a 4xx browser document aside like a 4xx fetch", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: THIN, renderedHtml: PAGE, browserDoc: doc(PAGE, 403) }))
    expect(check.passed).toBe(false) // measured on the direct fetch only
    expect(check.evidence).not.toMatch(/navigateur/)
  })

  it("no longer reads a poor direct fetch as dynamic rendering", () => {
    const bot = { userAgent: "Googlebot", status: 200, html: PAGE, htmlBytes: PAGE.length, responseHeaders: {}, blocked: false }
    expect(detectDynamicRendering(makeEvidence({ rawHtml: THIN, renderedHtml: PAGE, bot })).detected).toBe(true)
    expect(detectDynamicRendering(makeEvidence({ rawHtml: THIN, renderedHtml: PAGE, bot, browserDoc: doc(PAGE) })).detected).toBe(false)
  })
})

describe("anchor and image misreads", () => {
  it("ignores an <h1> that only exists inside a <script> string (stellantisandyou.com)", () => {
    const html = `<html><head></head><body><script>window.d.push({"title":"<h1 style=\\"x\\">Bienvenue chez Stellantis &amp;You</h1>"})</script></body></html>`
    expect(semanticAnchor(html).present).toBe(false)
  })

  it("does not count a hidden tracking pixel as an image (ysl.com)", () => {
    const html = `<img src="https://www.ysl.com/akam/13/pixel_7d5898e?a=dD1l" style="visibility: hidden; position: absolute">`
    expect(hasRealImage(html).present).toBe(false)
    expect(hasRealImage(`<img src="/t.gif" width="1" height="1">`).present).toBe(false)
    expect(hasRealImage(`<img src="/hero.jpg" width="1200" height="600">`).present).toBe(true)
  })
})

describe("already a Fasterize customer", () => {
  it("is flagged from the x-fstrz headers", () => {
    const flags = vigilanceFlags(makeEvidence({ mainResponseHeaders: { "x-fstrz": "m-head,Z,p" } }))
    expect(flags.map((f) => f.id)).toContain("fasterize.client")
  })

  it("is flagged from server-timing alone", () => {
    const flags = vigilanceFlags(makeEvidence({ mainResponseHeaders: { "server-timing": 'cdnOrigin;dur=448;desc="fstrz"' } }))
    expect(flags.map((f) => f.id)).toContain("fasterize.client")
  })
})

describe("unavailability wording hidden in a script", () => {
  it("does not read an i18n JSON string as a maintenance page (zarahome.com)", () => {
    const html = `<html><head><title>WorldWide - Zara Home</title></head><body><app-root></app-root>` +
      `<script>window.i18n={"pageNotAvailableTitle":"Page unavailable","pageNotAvailableMessage":"Sorry"}</script></body></html>`
    expect(blockSignature(html)).toBeNull()
  })
})
