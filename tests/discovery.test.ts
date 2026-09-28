/**
 * Page discovery — PDP/PLP proposals for a diagnostic project.
 * See ../src/discovery/ and ../../docs/DIAGNOSTIC.md, « Découverte des PDP / PLP ».
 */
import { describe, it, expect } from "vitest";
import {
  discoveryStartUrl,
  isHomeLikeUrl,
  localePrefix,
  pdpSignals,
  preferPrefix,
  sameSiteLinks,
} from "../src/discovery/rank";
import { orderChildSitemaps, parseSitemap, robotsSitemaps, sitemapFlavour } from "../src/discovery/sitemap";
import { blockReason, discoverSite, type Fetcher, type FetchResult } from "../src/discovery";
import { decodeBody } from "../src/discovery/http";
import zlib from "node:zlib";

// --- Fixtures ------------------------------------------------------------------

const page = (body: string, head = "") =>
  `<!doctype html><html><head><title>Boutique</title>${head}</head><body>${body}</body></html>`;

const PRODUCT_HEAD =
  '<meta property="og:type" content="product">' +
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Robe"}</script>';

const links = (...hrefs: string[]) => hrefs.map((h) => `<a href="${h}">x</a>`).join("");

/** A fetcher answering from a map; anything else is a 404. Records what it was asked. */
function fakeFetcher(kind: Fetcher["kind"], pages: Record<string, FetchResult | string>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind,
    calls,
    async get(url: string) {
      calls.push(url);
      const hit = pages[url];
      if (hit === undefined) return { url, status: 404, html: page("introuvable") };
      return typeof hit === "string" ? { url, status: 200, html: hit } : hit;
    },
  };
}

const DATADOME = page('<script src="https://ct.captcha-delivery.com/c.js"></script>');

// --- Pure helpers ----------------------------------------------------------------

describe("isHomeLikeUrl / discoveryStartUrl", () => {
  it("recognises the root and locale roots, nothing else", () => {
    expect(isHomeLikeUrl("https://www.shop.fr/")).toBe(true);
    expect(isHomeLikeUrl("https://www.shop.fr")).toBe(true);
    expect(isHomeLikeUrl("https://www.chantelle.com/fr-fr/")).toBe(true);
    expect(isHomeLikeUrl("https://www.printemps.com/fr/fr")).toBe(true);
    expect(isHomeLikeUrl("https://www.shop.fr/?lang=en")).toBe(false);
    expect(isHomeLikeUrl("https://www.shop.fr/matelas")).toBe(false);
    expect(isHomeLikeUrl("https://www.shop.fr/fr/matelas")).toBe(false);
  });

  it("starts from the first home-like URL, else the root of the first host", () => {
    expect(discoveryStartUrl(["https://a.fr/p/1", "https://a.fr/fr-fr/"])).toBe("https://a.fr/fr-fr/");
    expect(discoveryStartUrl(["https://www.a.fr/matelas?x=1"])).toBe("https://www.a.fr/");
    expect(discoveryStartUrl([])).toBeNull();
  });

  it("keeps the locale of the start URL for the sitemap", () => {
    expect(localePrefix("https://a.fr/fr-fr/")).toBe("/fr-fr/");
    expect(localePrefix("https://a.fr/")).toBe("");
    expect(preferPrefix(["https://a.fr/en/p/1", "https://a.fr/fr-fr/p/2"], "/fr-fr/")).toEqual([
      "https://a.fr/fr-fr/p/2",
      "https://a.fr/en/p/1",
    ]);
  });
});

describe("sameSiteLinks", () => {
  it("keeps same-host pages only, decodes entities, drops assets and fragments", () => {
    const html = links(
      "/c/robes",
      "https://blog.shop.fr/c/robes",
      "/img/a.jpg",
      "/p/robe-123?a=1&amp;b=2#top",
      "mailto:x@y.z",
    );
    expect(sameSiteLinks(html, "https://www.shop.fr/")).toEqual([
      "https://www.shop.fr/c/robes",
      "https://www.shop.fr/p/robe-123?a=1&b=2",
    ]);
  });
});

describe("pdpSignals", () => {
  it("confirms a page that declares ONE product", () => {
    expect(pdpSignals(page("", PRODUCT_HEAD)).signals).toEqual(["og:type product", "JSON-LD Product"]);
    expect(pdpSignals(page('<div itemscope itemtype="https://schema.org/Product"></div>')).signals).toEqual([
      "microdata Product",
    ]);
    expect(pdpSignals(page("", '<meta property="product:price:amount" content="42">')).signals).toEqual([
      "meta prix produit",
    ]);
  });

  it("does not take a listing whose tiles carry Product markup for a PDP", () => {
    const tiles = Array.from({ length: 5 }, () => '<div itemscope itemtype="http://schema.org/Product"></div>').join("");
    const r = pdpSignals(page(tiles));
    expect(r.listing).toBe(true);
    expect(r.signals).toEqual([]);
    const itemList = page("", '<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"Product"}]}</script>');
    expect(pdpSignals(itemList).signals).toEqual([]);
  });

  it("finds nothing on an ordinary page", () => {
    expect(pdpSignals(page("<h1>Bienvenue</h1>")).signals).toEqual([]);
  });

  it("reads only the TOP-LEVEL JSON-LD nodes: variants and related products are neighbours", () => {
    // damart.fr / petit-bateau.fr: a ProductGroup whose variants are Products.
    const group = JSON.stringify({
      "@type": "ProductGroup",
      hasVariant: [{ "@type": "Product" }, { "@type": "Product" }, { "@type": "Product" }],
    });
    const r = pdpSignals(page("", `<script type="application/ld+json">${group}</script>`));
    expect(r).toEqual({ signals: ["JSON-LD ProductGroup"], listing: false });
    const graph = JSON.stringify({ "@graph": [{ "@type": "WebPage", mainEntity: { "@type": "Product" } }, { "@type": "BreadcrumbList" }] });
    expect(pdpSignals(page("", `<script type="application/ld+json">${graph}</script>`)).signals).toEqual(["JSON-LD Product"]);
  });

  it("takes the detail page of a non-retail site at its word (trip, hotel…)", () => {
    const trip = '<script type="application/ld+json">{"@type":"TouristTrip","name":"Costa Rica"}</script>';
    expect(pdpSignals(page("", trip)).signals).toEqual(["JSON-LD TouristTrip"]);
  });

  it("does not take a listing's own aggregate item for a PDP", () => {
    const ld = '<script type="application/ld+json">[{"@type":"CollectionPage"},{"@type":"Product","aggregateRating":{}}]</script>';
    expect(pdpSignals(page("", ld))).toEqual({ signals: [], listing: true });
  });
});

describe("URL shapes seen in the field", () => {
  const links = (html: string) => sameSiteLinks(html, "https://www.shop.fr/");
  it("reads id-prefixed segments: P- products, C- / c123- categories", async () => {
    const { pdpCandidates, plpCandidates } = await import("../src/discovery/rank");
    const urls = links(
      '<a href="/F-41505-velos/P-3342429-velo_de_route_trek"></a><a href="/C-40400-ville"></a>' +
        '<a href="/c110503-velo-de-route.html"></a><a href="/perceuse/3663602795493_CAFR.prd"></a>',
    );
    expect(pdpCandidates(urls).map((c) => c.url)).toEqual([
      "https://www.shop.fr/perceuse/3663602795493_CAFR.prd",
      "https://www.shop.fr/F-41505-velos/P-3342429-velo_de_route_trek",
    ]);
    expect(plpCandidates(urls).map((c) => c.url)).toEqual([
      "https://www.shop.fr/C-40400-ville",
      "https://www.shop.fr/c110503-velo-de-route.html",
    ]);
  });

  it("takes a short /p/ marker for a product route, a word marker needs more", async () => {
    const { hasProductIdentifier } = await import("../src/discovery/rank");
    expect(hasProductIdentifier("/p/moustiquaire-porte/")).toBe(true);
    expect(hasProductIdentifier("/produits/tapis")).toBe(false);
    expect(hasProductIdentifier("/produits/tapis/berbere-rouge")).toBe(true);
  });

  it("prefers a leaf category among descriptive paths, the canonical one among explicit routes", async () => {
    const { plpCandidates } = await import("../src/discovery/rank");
    const urls = links('<a href="/jardin.html"></a><a href="/jardin/amenager/etendage-exterieur.html"></a>');
    expect(plpCandidates(urls)[0].url).toBe("https://www.shop.fr/jardin/amenager/etendage-exterieur.html");
  });
});

describe("sitemaps", () => {
  it("reads Sitemap lines of robots.txt, relative ones included", () => {
    const robots = "User-agent: *\nDisallow: /cart\nSitemap: https://a.fr/sitemap_index.xml\nsitemap: /other.xml\n";
    expect(robotsSitemaps(robots, "https://a.fr")).toEqual(["https://a.fr/sitemap_index.xml", "https://a.fr/other.xml"]);
  });

  it("parses an index and a urlset, CDATA and &amp; included, and a body cut short", () => {
    const index = `<sitemapindex><sitemap><loc>https://a.fr/sitemap_products_1.xml?from=1&amp;to=9</loc></sitemap>
      <sitemap><loc><![CDATA[https://a.fr/sitemap_collections_1.xml]]></loc></sitemap></sitemapindex>`;
    expect(parseSitemap(index).sitemaps).toEqual([
      "https://a.fr/sitemap_products_1.xml?from=1&to=9",
      "https://a.fr/sitemap_collections_1.xml",
    ]);
    const cut = "<urlset><url><loc>https://a.fr/p/1</loc></url><url><loc>https://a.fr/p/2</lo";
    expect(parseSitemap(cut).urls).toEqual(["https://a.fr/p/1"]);
  });

  it("tells product, category and other sitemaps apart by name", () => {
    expect(sitemapFlavour("https://a.fr/sitemap_products_1.xml")).toBe("product");
    expect(sitemapFlavour("https://a.fr/sitemap_0-product.xml")).toBe("product");
    expect(sitemapFlavour("https://a.fr/product-sitemap.xml")).toBe("product");
    expect(sitemapFlavour("https://a.fr/product_cat-sitemap.xml")).toBe("category");
    expect(sitemapFlavour("https://a.fr/sitemap_collections_1.xml")).toBe("category");
    expect(sitemapFlavour("https://a.fr/fstrz/sm/sitemap-prd2.xml")).toBe("product");
    expect(sitemapFlavour("https://a.fr/fstrz/sm/sitemap-cat.xml")).toBe("category");
    expect(sitemapFlavour("https://a.fr/sitemap-catalog.xml")).toBe("other");
    expect(sitemapFlavour("https://a.fr/sitemap_pages_1.xml")).toBe("other");
    expect(sitemapFlavour("https://a.fr/sitemap.xml")).toBe("other");
  });

  it("opens the right flavour first, in the start URL's locale, never the wrong one", () => {
    const children = [
      "https://a.fr/sitemap_en_product.xml",
      "https://a.fr/sitemap_category.xml",
      "https://a.fr/sitemap_generic.xml",
      "https://a.fr/sitemap_fr-fr_product.xml",
    ];
    expect(orderChildSitemaps(children, "product", "/fr-fr/")).toEqual([
      "https://a.fr/sitemap_fr-fr_product.xml",
      "https://a.fr/sitemap_en_product.xml",
      "https://a.fr/sitemap_generic.xml",
    ]);
  });

  it("decodes a gzip sitemap file and a truncated gzip stream", () => {
    const xml = "<urlset><url><loc>https://a.fr/p/1</loc></url></urlset>";
    expect(decodeBody(zlib.gzipSync(xml))).toBe(xml);
    const big = "<urlset>" + "<url><loc>https://a.fr/p/1</loc></url>".repeat(2000) + "</urlset>";
    const gz = zlib.gzipSync(big);
    expect(decodeBody(gz.subarray(0, gz.length - 20))).toContain("<url><loc>https://a.fr/p/1</loc></url>");
  });
});

describe("blockReason", () => {
  it("names WAF statuses and interstitials, never a plain 404", () => {
    expect(blockReason({ error: "timeout" })).toBe("échec (timeout)");
    expect(blockReason({ url: "u", status: 403, html: "" })).toBe("HTTP 403");
    expect(blockReason({ url: "u", status: 200, html: DATADOME })).toBe("interstitiel DataDome");
    expect(blockReason({ url: "u", status: 404, html: page("") })).toBeNull();
    expect(blockReason({ url: "u", status: 200, html: page("<h1>ok</h1>") })).toBeNull();
  });
});

// --- Orchestration ---------------------------------------------------------------

const HOME = "https://www.shop.fr/";

describe("discoverSite", () => {
  it("confirms a PLP by its product links, and a PDP from it by its product markup", async () => {
    const http = fakeFetcher("http", {
      [HOME]: page(links("/c/robes", "/aide/faq")),
      "https://www.shop.fr/c/robes": page(links("/p/robe-rouge-12345", "/p/robe-bleue-23456", "/p/robe-verte-34567")),
      "https://www.shop.fr/p/robe-rouge-12345": page("<h1>Robe</h1>", PRODUCT_HEAD),
    });
    const r = await discoverSite(HOME, { want: { pdp: true, plp: true }, http });
    expect(r.plp).toMatchObject({ found: true, url: "https://www.shop.fr/c/robes", confidence: "confirmed", via: "http" });
    expect(r.pdp).toMatchObject({
      found: true,
      url: "https://www.shop.fr/p/robe-rouge-12345",
      confidence: "confirmed",
      source: "lien de la PLP",
    });
    if (r.pdp?.found) {
      expect(r.pdp.note).toContain("og:type product");
      expect(r.pdp.alternatives).toEqual(["https://www.shop.fr/p/robe-bleue-23456", "https://www.shop.fr/p/robe-verte-34567"]);
    }
  });

  it("finds the PDP in the product sitemap when the home has no usable link", async () => {
    const http = fakeFetcher("http", {
      [HOME]: page("<div id=app></div>"),
      "https://www.shop.fr/robots.txt": "Sitemap: https://www.shop.fr/sitemap_index.xml",
      "https://www.shop.fr/sitemap_index.xml":
        "<sitemapindex><sitemap><loc>https://www.shop.fr/sitemap_products_1.xml</loc></sitemap></sitemapindex>",
      "https://www.shop.fr/sitemap_products_1.xml":
        "<urlset><url><loc>https://www.shop.fr/products/robe-lin</loc></url></urlset>",
      "https://www.shop.fr/products/robe-lin": page("<h1>Robe lin</h1>", PRODUCT_HEAD),
    });
    const r = await discoverSite(HOME, { want: { pdp: true, plp: false }, http });
    expect(r.pdp).toMatchObject({ found: true, url: "https://www.shop.fr/products/robe-lin", confidence: "confirmed", source: "sitemap produits" });
    expect(r.plp).toBeUndefined();
  });

  it("hands the site to the browser when HTTP gets a WAF interstitial, and says so", async () => {
    const http = fakeFetcher("http", { [HOME]: { url: HOME, status: 403, html: DATADOME } });
    const browser = fakeFetcher("browser", {
      [HOME]: page(links("/c/robes")),
      "https://www.shop.fr/c/robes": page(links("/p/a-11111", "/p/b-22222", "/p/c-33333")),
      "https://www.shop.fr/p/a-11111": page("", PRODUCT_HEAD),
    });
    let opened = 0;
    const r = await discoverSite(HOME, {
      want: { pdp: true, plp: false },
      http,
      browser: () => (opened++, browser),
    });
    expect(opened).toBe(1);
    expect(r.pdp).toMatchObject({ found: true, url: "https://www.shop.fr/p/a-11111", confidence: "confirmed", via: "browser" });
    if (r.pdp?.found) expect(r.pdp.note).toContain("navigateur utilisé (HTTP refusé : HTTP 403)");
    // Pages after the switch no longer go through HTTP; sitemaps still do.
    expect(http.calls.filter((u) => u.includes("/p/") || u.includes("/c/"))).toEqual([]);
  });

  it("reads the rendered DOM when the served HTML has no navigation", async () => {
    const http = fakeFetcher("http", { [HOME]: page("<div id=root></div>") });
    const browser = fakeFetcher("browser", {
      [HOME]: page(links("/produit/chaise-98765")),
      "https://www.shop.fr/produit/chaise-98765": page("", PRODUCT_HEAD),
    });
    const r = await discoverSite(HOME, { want: { pdp: true, plp: false }, http, browser: () => browser });
    expect(r.pdp).toMatchObject({ found: true, confidence: "confirmed", via: "browser" });
    if (r.pdp?.found) expect(r.pdp.note).toContain("navigation construite en JS");
  });

  it("does not propose a readable page that declares no product, but keeps it as a lead", async () => {
    const http = fakeFetcher("http", {
      [HOME]: page(links("/p/robe-12345")),
      "https://www.shop.fr/p/robe-12345": page("<h1>Robe</h1>"),
    });
    const r = await discoverSite(HOME, { want: { pdp: true, plp: false }, http });
    expect(r.pdp).toMatchObject({ found: false, alternatives: ["https://www.shop.fr/p/robe-12345"] });
    if (r.pdp && !r.pdp.found) expect(r.pdp.note).toContain("aucun ne déclare de produit");
  });

  it("gives a bare product page a second chance in the browser (JSON-LD injected in JS)", async () => {
    const http = fakeFetcher("http", {
      [HOME]: page(links("/p/robe-12345")),
      "https://www.shop.fr/p/robe-12345": page("<div id=app></div>"),
    });
    const browser = fakeFetcher("browser", { "https://www.shop.fr/p/robe-12345": page("<h1>Robe</h1>", PRODUCT_HEAD) });
    const r = await discoverSite(HOME, { want: { pdp: true, plp: false }, http, browser: () => browser });
    expect(r.pdp).toMatchObject({ found: true, confidence: "confirmed", via: "browser" });
    if (r.pdp?.found) expect(r.pdp.note).toContain("aucun signal produit dans le HTML servi");
  });

  it("proposes a candidate it could not read as probable, never as confirmed", async () => {
    const http = fakeFetcher("http", {
      [HOME]: page(links("/p/robe-12345")),
      "https://www.shop.fr/p/robe-12345": { url: "https://www.shop.fr/p/robe-12345", status: 403, html: DATADOME },
    });
    const r = await discoverSite(HOME, { want: { pdp: true, plp: false }, http });
    expect(r.pdp).toMatchObject({ found: true, url: "https://www.shop.fr/p/robe-12345", confidence: "probable" });
    if (r.pdp?.found) expect(r.pdp.note).toContain("illisible (blocage)");
  });

  it("does not confirm a listing on links that are the site's navigation", async () => {
    // but.fr: categories have a product shape (/cuisine/index-a10315.html), and a
    // landing page repeating the menu must not pass for a listing.
    const menu = links("/cuisine/index-a10315.html", "/jardin/index-a10324.html", "/salon/index-a10330.html");
    const http = fakeFetcher("http", {
      [HOME]: page(menu + links("/lp/but-pro")),
      "https://www.shop.fr/lp/but-pro": page(menu),
    });
    const r = await discoverSite(HOME, { want: { pdp: false, plp: true }, http });
    expect(r.plp?.found && r.plp.confidence === "confirmed").toBe(false);
  });

  it("does not propose a dead product URL", async () => {
    const http = fakeFetcher("http", { [HOME]: page(links("/p/robe-12345")) }); // the PDP 404s
    const r = await discoverSite(HOME, { want: { pdp: true, plp: false }, http });
    expect(r.pdp).toMatchObject({ found: false });
    if (r.pdp && !r.pdp.found) expect(r.pdp.note).toContain("page morte");
  });

  it("reports NOT FOUND with the reason when the site stays blocked", async () => {
    const http = fakeFetcher("http", { [HOME]: { url: HOME, status: 403, html: DATADOME } });
    const browser = fakeFetcher("browser", { [HOME]: { url: HOME, status: 200, html: DATADOME } });
    const r = await discoverSite(HOME, { want: { pdp: true, plp: true }, http, browser: () => browser });
    expect(r.pdp).toMatchObject({ found: false, via: "browser" });
    if (r.pdp && !r.pdp.found) expect(r.pdp.note).toContain("home illisible (interstitiel DataDome)");
    expect(r.plp).toMatchObject({ found: false });
  });

  it("stays HTTP-only when no browser is given", async () => {
    const http = fakeFetcher("http", { [HOME]: { error: "timeout" } });
    const r = await discoverSite(HOME, { want: { pdp: true, plp: false }, http });
    expect(r.pdp).toMatchObject({ found: false, via: "http" });
  });
});
