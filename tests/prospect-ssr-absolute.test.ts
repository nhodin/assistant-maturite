/**
 * The SSR criterion is ABSOLUTE: is the page's content in the served HTML —
 * not "what share of the final text was already there".
 *
 * Measured on the prospect corpus, the share-based rule produced two confident
 * false NOGOs: shop-orchestra.com (45% overlap, 2664 words, h1, 66 images) and
 * byredo.com (34%, 663 words, h1, 49 images) both serve their product in full,
 * and were only penalised for loading menus, reviews and recommendations in JS.
 * The ratio is still reported, it just no longer decides.
 *
 * The anti-shell guard replaces what the ratio really protected against: a page
 * whose header and footer alone carry enough words while the content is
 * client-side. See docs/DIAGNOSTIC.md.
 */
import { describe, it, expect } from "vitest"
import { evaluateSsr, semanticAnchor, anchorPresentInBody, SSR_MIN_WORDS } from "../src/prospect/detect"

const words = (n: number, w = "contenu") => Array.from({ length: n }, () => w).join(" ")

/** Server-rendered product page whose rendered DOM adds a lot of client-side text. */
const SERVED = `<html><head><title>Maillot anti-UV fleurs | Orchestra</title></head><body>` +
  `<h1>Maillot 1 pièce manches longues anti-UV imprimé fleurs</h1>` +
  `<img src="/p/maillot.jpg"><p>${words(300, "maillot")}</p></body></html>`
const RENDERED_WITH_EXTRAS = `<html><body>` +
  `<h1>Maillot 1 pièce manches longues anti-UV imprimé fleurs</h1>` +
  `<img src="/p/maillot.jpg"><p>${words(300, "maillot")}</p>` +
  `<section>${words(1200, "avis")}</section><section>${words(1200, "recommandation")}</section>` +
  `</body></html>`

describe("evaluateSsr — absolute criterion", () => {
  it("passes a server-rendered page whose rendered DOM adds much more text", () => {
    const r = evaluateSsr(SERVED, RENDERED_WITH_EXTRAS)
    expect(r.passed).toBe(true)
    expect(r.metrics.overlapRatio).toBeLessThan(0.5) // the old rule would have failed it
    expect(r.evidence).toMatch(/indicatif, n'entre pas dans le verdict/)
  })

  it("still fails a page with no server-rendered content", () => {
    const shell = `<html><head><title>Boutique</title></head><body><div id="app"></div></body></html>`
    expect(evaluateSsr(shell, RENDERED_WITH_EXTRAS).passed).toBe(false)
  })

  it("still fails a page below the word threshold", () => {
    const thin = `<html><head><title>Produit</title></head><body><h1>Produit</h1>` +
      `<img src="/a.jpg"><p>${words(SSR_MIN_WORDS - 50)}</p></body></html>`
    const r = evaluateSsr(thin, RENDERED_WITH_EXTRAS)
    expect(r.passed).toBe(false)
    expect(r.evidence).toMatch(/insuffisant/)
  })

  it("still fails a page with no image resolvable without JS", () => {
    const noImg = `<html><head><title>Produit</title></head><body><h1>Produit</h1>` +
      `<img data-src="/a.jpg"><p>${words(300)}</p></body></html>`
    expect(evaluateSsr(noImg, RENDERED_WITH_EXTRAS).passed).toBe(false)
  })
})

describe("anti-shell guard", () => {
  // Header + footer boilerplate is long enough to clear the word threshold, but the
  // page's own subject — which only the <title> names — is nowhere in the body.
  const SHELL = `<html><head><title>Bermuda en molleton léger bleu | Kiabi</title></head><body>` +
    `<nav>${words(200, "navigation")}</nav><img src="/logo.png">` +
    `<footer>${words(200, "mentions")}</footer></body></html>`

  it("fails a shell whose head-only anchor is absent from the body", () => {
    const r = evaluateSsr(SHELL, RENDERED_WITH_EXTRAS)
    expect(r.passed).toBe(false)
    expect(r.evidence).toMatch(/page coquille/)
    expect(r.metrics.anchorInBody).toBe(false)
  })

  it("passes when the title's subject is genuinely in the body", () => {
    const served = `<html><head><title>Bermuda en molleton léger bleu | Kiabi</title></head><body>` +
      `<img src="/p.jpg"><p>Bermuda en molleton léger, coupe droite. ${words(300, "bermuda")}</p></body></html>`
    expect(evaluateSsr(served, RENDERED_WITH_EXTRAS).passed).toBe(true)
  })

  it("never applies to an h1 anchor — it is in the body by construction", () => {
    expect(anchorPresentInBody(semanticAnchor(SERVED), SERVED)).toBe(true)
  })

  it("abstains when the anchor carries too few usable words to look for", () => {
    const html = `<html><head><title>Kiabi</title></head><body><p>${words(300)}</p></body></html>`
    expect(anchorPresentInBody(semanticAnchor(html), html)).toBeNull()
  })

  it("does not fail a page whose title puts the site name FIRST (snipes.com)", () => {
    // Regression (run 45): 1711 served words, 96% of the final text, but the
    // guard only read "SNIPES Onlineshop" and "Onlineshop" is not in the body.
    const html = `<html><head><title>SNIPES Onlineshop - Sneaker, Streetwear &amp; Accessories!</title></head>` +
      `<body><img src="/p.jpg"><nav>SNIPES Sneaker Streetwear Accessories</nav><p>${words(300, "schuhe")}</p></body></html>`
    expect(anchorPresentInBody(semanticAnchor(html), html)).toBe(true)
    expect(evaluateSsr(html, RENDERED_WITH_EXTRAS).passed).toBe(true)
  })

  it("waives the guard when the served HTML already carries most of the final text", () => {
    // snipes.com: English title over a German body — 2 of 5 title words match,
    // yet the served HTML IS the final page. A shell never serves most of it.
    const html = `<html><head><title>SNIPES Onlineshop - Sneaker, Streetwear &amp; Accessories!</title></head>` +
      `<body><img src="/p.jpg"><nav>Snipes Schuhe Sneaker Accessoires</nav><p>${words(300, "schuhe")}</p></body></html>`
    expect(anchorPresentInBody(semanticAnchor(html), html)).toBe(false)
    const r = evaluateSsr(html, html) // served == rendered: 100% overlap
    expect(r.passed).toBe(true)
    expect(r.metrics.anchorInBody).toBeNull()
    // The same served HTML against a much richer final page stays a shell.
    expect(evaluateSsr(html, RENDERED_WITH_EXTRAS).metrics.anchorInBody).toBe(false)
  })

  it("decodes entities, so &amp; is not a word and &eacute; matches é", () => {
    const html = `<html><head><title>Bermuda l&eacute;ger &amp; molleton</title></head>` +
      `<body><p>Bermuda léger en molleton. ${words(300)}</p></body></html>`
    expect(anchorPresentInBody(semanticAnchor(html), html)).toBe(true)
  })

  it("strips the site-name suffix before looking (title vs body wording)", () => {
    const html = `<html><head><title>Rose Of No Man's Land — Byredo</title></head><body>` +
      `<img src="/p.jpg"><p>Rose of no man's land, eau de parfum. ${words(300, "parfum")}</p></body></html>`
    expect(anchorPresentInBody(semanticAnchor(html), html)).toBe(true)
  })
})
