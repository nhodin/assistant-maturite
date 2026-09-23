/**
 * A blocked VISITOR document must be « à confirmer », never a NOGO.
 *
 * Regression: Kiabi was diagnosed "Speed NOGO" off a 772-byte DataDome
 * interstitial titled "kiabi.com" — the site had simply refused the capture, and
 * measuring SSR on the block page read as "no SSR". The crawler side had this
 * guard from the start; the visitor side did not, and `isChallengeHtml` only
 * looked at the <title>, which DataDome fills with the site's own name.
 */
import { describe, it, expect } from "vitest"
import { isChallengeHtml, challengeSignature, blockSignature } from "../src/collector/challenge"
import { ssrUserCheck, ssrBotCheck } from "../src/prospect/checks"
import { decide } from "../src/prospect/verdict"
import { makeEvidence } from "../src/core/fixture"

/** The interstitial actually captured on kiabi.com, trimmed. */
const DATADOME = `<html lang="fr"><head><title>kiabi.com</title><style>#cmsg{animation: A 1.5s;}</style></head>` +
  `<body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>` +
  `<script data-cfasync="false">var dd={'rt':'i','cid':'AHrlqAAA','host':'geo.captcha-delivery.com'}</script>` +
  `<script data-cfasync="false" src="https://ct.captcha-delivery.com/i.js"></script></body></html>`

const REAL_PAGE = `<html><head><title>Bermuda en molleton léger bleu | Kiabi</title></head><body>` +
  `<h1>Bermuda en molleton léger</h1><img src="/p/bermuda.jpg">` +
  `<p>${"Un bermuda en molleton léger, coupe droite, taille élastiquée. ".repeat(12)}</p></body></html>`

describe("isChallengeHtml", () => {
  it("catches a DataDome interstitial that keeps the site's own title", () => {
    expect(isChallengeHtml(DATADOME)).toBe(true)
    expect(challengeSignature(DATADOME)).toBe("interstitiel DataDome")
  })

  it("still catches a challenge by title", () => {
    expect(isChallengeHtml("<html><head><title>Just a moment…</title></head><body></body></html>")).toBe(true)
  })

  it("leaves a real page alone", () => {
    expect(isChallengeHtml(REAL_PAGE)).toBe(false)
    expect(challengeSignature(REAL_PAGE)).toBeNull()
  })

  it("does not fire on editorial prose that merely mentions blocking", () => {
    const article = `<html><head><title>Guide</title></head><body><h1>Access denied ?</h1>` +
      `<p>Que faire quand un site affiche « access denied » ou vous demande si vous êtes un robot.</p></body></html>`
    expect(isChallengeHtml(article)).toBe(false)
  })
})

describe("ssrUserCheck on a blocked document", () => {
  it("is unknown, not a failure verdict, and names the reason", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: DATADOME, renderedHtml: REAL_PAGE }))
    expect(check.unknown).toBe(true)
    expect(check.passed).toBe(false) // unmeasurable never flatters a verdict
    expect(check.evidence).toMatch(/DataDome/)
    expect(check.metrics).toBeUndefined() // nothing was measured, so nothing is reported
  })

  it("turns EdgeSpeed into « à confirmer » rather than NOGO", () => {
    const user = ssrUserCheck(makeEvidence({ rawHtml: DATADOME, renderedHtml: REAL_PAGE }))
    const { speed } = decide([user, { id: "ssr.bot", label: "SSR — crawler", passed: false, unknown: true, evidence: "403" }])
    expect(speed).toBe("UNKNOWN")
  })

  it("still measures normally when the document is the real page", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: REAL_PAGE, renderedHtml: REAL_PAGE }))
    expect(check.unknown).toBeUndefined()
    expect(check.metrics).toBeDefined()
  })
})

describe("self-branded block page (no vendor signature)", () => {
  // Captured on printemps.com: a product URL answered with a 10.9 KB page under
  // the site's own generic title. No DataDome/Cloudflare/Imperva marker, not
  // short enough to look empty — it scored as "no SSR" and produced a wrong NOGO.
  const PRINTEMPS = `<html><head><title>Printemps.com - Mode homme, femme et beauté de luxe</title></head><body>` +
    `<h1>Oh non...</h1><p>Une activité anormale a été détectée sur cette adresse IP 77.128.253.184 (a3f81d87fe8a4a32). ` +
    `L'accès à notre site a été bloqué automatiquement par notre pare-feu. Si vous pensez que ce blocage est anormal, ` +
    `nous vous invitons à contacter notre service client, en mentionnant votre adresse IP.</p></body></html>`

  it("is recognised as a block, and names the refused IP", () => {
    expect(isChallengeHtml(PRINTEMPS)).toBe(true)
    expect(blockSignature(PRINTEMPS)).toMatch(/77\.128\.253\.184/)
  })

  it("makes the visitor check « à confirmer » rather than a NOGO", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: PRINTEMPS, renderedHtml: REAL_PAGE }))
    expect(check.unknown).toBe(true)
    expect(check.evidence).toMatch(/page de blocage/)
  })

  it("does not fire on a long illustrated article about firewalls", () => {
    // Blocking vocabulary alone must never conclude: the corroborating signal
    // (tiny document, or the visitor's IP echoed back) is what separates the two.
    const article = `<html><head><title>Comprendre les pare-feux</title></head><body><h1>Pare-feu</h1>` +
      `<img src="/img/firewall.jpg">` +
      `<p>Quand un site détecte une activité anormale, il peut bloquer une adresse. ` +
      `${"Nous expliquons ici comment fonctionnent ces protections et comment les configurer. ".repeat(400)}</p>` +
      `</body></html>`
    expect(Buffer.byteLength(article, "utf-8")).toBeGreaterThan(25_000)
    expect(isChallengeHtml(article)).toBe(false)
  })
})

describe("presumption on a blocked crawler", () => {
  const SERVED = `<html><head><title>Bermuda en molleton léger | Kiabi</title></head><body>` +
    `<h1>Bermuda en molleton léger</h1><img src="/p/bermuda.jpg">` +
    `<p>${"Un bermuda en molleton léger, coupe droite, taille élastiquée. ".repeat(20)}</p></body></html>`
  const blockedBot = { userAgent: "Googlebot", status: 403, html: "", htmlBytes: 0,
    responseHeaders: {}, blocked: true, blockReason: "réponse HTTP 403" }

  it("notes the reasoning when the visitor document IS server-rendered", () => {
    const check = ssrBotCheck(makeEvidence({ rawHtml: SERVED, renderedHtml: SERVED, bot: blockedBot }))
    expect(check.unknown).toBe(true)
    expect(check.presumption).toMatch(/présomption favorable/)
    expect(check.presumption).toMatch(/ne le retire pas aux crawlers/)
  })

  it("is an INDICATION, never a verdict — the check stays « à confirmer »", () => {
    const check = ssrBotCheck(makeEvidence({ rawHtml: SERVED, renderedHtml: SERVED, bot: blockedBot }))
    expect(check.passed).toBe(false)
    expect(decide([{ id: "ssr.user", label: "u", passed: true, evidence: "ok" }, check]).seo).toBe("UNKNOWN")
  })

  it("says nothing when the visitor document is not server-rendered", () => {
    const shell = `<html><head><title>Boutique</title></head><body><div id="app"></div></body></html>`
    const check = ssrBotCheck(makeEvidence({ rawHtml: shell, renderedHtml: SERVED, bot: blockedBot }))
    expect(check.presumption).toBeUndefined()
  })

  it("says nothing when the visitor document is itself a block page", () => {
    // Both sides refused: there is nothing to reason from, and guessing a
    // direction would be worse than staying silent.
    const check = ssrBotCheck(makeEvidence({ rawHtml: DATADOME, renderedHtml: SERVED, bot: blockedBot }))
    expect(check.presumption).toBeUndefined()
  })
})

describe("site-wide unavailability page (sarenza.com, run 45)", () => {
  // A full branded 550 KB page — header, footer, the site's own title — answered
  // with a 403. Too big for the size corroboration, no IP, no vendor mark.
  const SARENZA = `<html><head><title>Sarenza | Serious about shoes and clothes</title></head><body>` +
    `<header><nav>${"Femme Homme Enfant Marques Soldes ".repeat(40)}</nav></header>` +
    `<h1 class="title-edito">Page momentanément indisponible.</h1>` +
    `<p>Nous sommes en maintenance actuellement... Revenez un peu plus tard !</p>` +
    `<footer>${"Aide Livraison Retours Contact ".repeat(40)}</footer></body></html>`

  it("is recognised by its headline, whatever its size", () => {
    expect(isChallengeHtml(SARENZA)).toBe(true)
    expect(blockSignature(SARENZA)).toMatch(/indisponible \/ maintenance/)
  })

  it("leaves a product page with an out-of-stock notice alone", () => {
    const pdp = `<html><head><title>Basket Stan Smith | Sarenza</title></head><body><h1>Basket Stan Smith</h1>` +
      `<img src="/p.jpg"><p>Article temporairement indisponible dans cette taille.</p>` +
      `<p>${"Cuir blanc, semelle caoutchouc, lacets. ".repeat(30)}</p></body></html>`
    expect(blockSignature(pdp)).toBeNull()
  })

  it("leaves a long help page that merely mentions maintenance alone", () => {
    const help = `<html><head><title>Aide | Sarenza</title></head><body><h1>Questions fréquentes</h1>` +
      `<p>Le site peut être en maintenance quelques minutes la nuit.</p>` +
      `<p>${"Vos commandes, vos retours et vos remboursements. ".repeat(40)}</p></body></html>`
    expect(blockSignature(help)).toBeNull()
  })
})

describe("visitor document served with an error status", () => {
  it("is « à confirmer » even when the body looks like a real page", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: REAL_PAGE, renderedHtml: REAL_PAGE, rawStatus: 403 }))
    expect(check.unknown).toBe(true)
    expect(check.passed).toBe(false)
    expect(check.evidence).toMatch(/HTTP 403/)
  })

  it("is measured as usual on a 200", () => {
    const check = ssrUserCheck(makeEvidence({ rawHtml: REAL_PAGE, renderedHtml: REAL_PAGE, rawStatus: 200 }))
    expect(check.unknown).toBeUndefined()
  })
})
