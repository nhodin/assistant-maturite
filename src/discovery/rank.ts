/**
 * Page discovery — PURE ranking of a site's links into PLP / PDP candidates, and
 * the page-level signals that CONFIRM a candidate once it is opened.
 * No I/O here: see ./index.ts for the orchestration and ../../../docs/DIAGNOSTIC.md,
 * « Découverte des PDP / PLP », for the spec.
 *
 * The URL shapes only RANK candidates. What makes a candidate a fact is what the
 * page says once opened: a listing links to several products, a product page
 * declares ONE product (JSON-LD, Open Graph, microdata). A candidate that was never
 * confirmed is reported as « probable », never as a settled PDP.
 */

/**
 * Paths that are never a PLP nor a PDP, whatever else they match. Editorial and
 * service sections are the main source of false positives: they have the same URL
 * shape as a category ("/services/retrait", "/conseils/…", "/guides-d-achat/…").
 */
export const EXCLUDE =
  /(^|\/)[^/]*(cart|panier|basket|checkout|commande|account|compte|customer|profil|espace-client|espace-pro|login|connexion|signin|register|inscription|wishlist|favoris|store-?locator|magasins?|contact|aide|help|support|faq|avis|blog|journal|actualite|actus?|news|presse|press|dossier|inspiration|conseil|guide|career|carriere|recrutement|jobs|service|livraison|retrait|drive|garantie|detaxe?|cgv|cgu|cgs|mentions?|legal|licence|privacy|vie-privee|confidentialite|cookie|plan-du-site|sitemap|newsletter|configurateur|liens-utiles|relation-client|landing-page|search|recherche)[^/]*(\/|$)/i;

/**
 * A product URL carries an IDENTIFIER — a sku or a numeric id. Without one,
 * "/produits/tapis" and "/produits/salle-de-bain-et-wc" are categories, not products.
 * A long descriptive slug was tried as a second signal and dropped: category slugs are
 * just as long ("tous-les-produits-enfants"), so it only manufactured false positives.
 */
export function hasProductIdentifier(pathname: string): boolean {
  const segments = pathname.replace(/^\/|\/$/g, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  if (/\d{3,}/.test(last)) return true; // sku / numeric id in the last segment
  if (/\d{3,}/.test(pathname) && /\.html?$/i.test(pathname)) return true;
  // A SHORT product marker is a product route on its own: "/p/moustiquaire-porte/"
  // (stores-discount), "/dp/B0…" (Amazon).
  const short = segments.findIndex((s) => /^(p|dp|pd|prd)$/i.test(s));
  if (short >= 0 && short < segments.length - 1) return true;
  // A WORD marker needs SEVERAL segments after it to name one item
  // ("/produits/rosas-premium/1/red"). One segment after it is a category
  // ("/produits/tapis", "/products/tous-les-produits-enfants.html").
  const marker = segments.findIndex((s) => /^(products?|produits?|item)$/i.test(s));
  return marker >= 0 && segments.length - marker - 1 >= 2;
}

/** Strong PDP shapes: a product-detail route with an identifier segment. */
export const PDP_PATTERNS: Array<[RegExp, number]> = [
  [/\/(products?|produits?|item|article)\/[^/]{3,}/i, 6],
  [/\/(p|dp|pd|prd)\/[^/]{3,}/i, 6],
  [/-p-?\d{3,}/i, 6],
  // A segment OPENING on a product id: "/P-3342429-velo_de_route…" (alltricks).
  [/(^|\/)p-?\d{4,}[-_.]/i, 6],
  // "/…/3663602795493_CAFR.prd" (castorama).
  [/\/[^/]*\d{4,}[^/]*\.prd$/i, 6],
  [/\/fiche[-_]?produit\//i, 6],
  [/\/prod\d{3,}/i, 5],
  [/\/[^/]*-\d{5,}\.html?$/i, 5],
  [/\/[^/]+\/[^/]*\d{4,}[^/]*\.html?$/i, 3],
];

/** Category / listing shapes, from the most explicit to the weakest. */
export const PLP_PATTERNS: Array<[RegExp, number]> = [
  [/\/(c|categor(?:y|ie|ies|ia|ias)|rayon|rayons|univers|catalogue|gamme)\/[^/]{2,}/i, 6],
  [/\/collections?\/[^/]{2,}/i, 5],
  // A segment OPENING on a category id: "/C-40400-ville" (alltricks),
  // "/c110503-velo-de-route.html" (materiel-velo).
  [/(^|\/)c-?\d{3,}[-_.][^/]*$/i, 5],
  [/\/(shop|boutique|nos-produits|tous-les-produits|listing)\//i, 4],
  // Descriptive paths, ".html" included (mr-bricolage: "/outillage/…/cles.html").
  [/\/[a-z0-9-]{4,}\/[a-z0-9-]{3,}(\/|\.html?)?$/i, 2],
  [/\/[a-z0-9-]{4,}(\/|\.html?)?$/i, 1],
];

export function score(pathname: string, patterns: Array<[RegExp, number]>): number {
  let best = 0;
  for (const [re, pts] of patterns) if (re.test(pathname)) best = Math.max(best, pts);
  return best;
}

/** URLs that are files, not pages. */
const ASSET_RE = /\.(jpe?g|png|webp|avif|gif|svg|pdf|zip|mp4|css|js|json|xml|txt|ico|woff2?)$/i;

/**
 * Normalises an absolute URL for comparison and de-duplication: no fragment,
 * repeated slashes collapsed ("//catalog//category//" and "/catalog/category/" are
 * the same page). Null when it is not an http(s) URL.
 */
export function cleanUrl(raw: string, base?: string | URL): URL | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.pathname = u.pathname.replace(/\/{2,}/g, "/");
  return u;
}

/**
 * Absolute, http(s) links of a document, de-duplicated. Restricted to the SAME HOST —
 * `blog.` / `aide.` / `support.` subdomains share the registrable domain but are a
 * different site, and their editorial URLs look exactly like categories.
 */
export function sameSiteLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = decodeEntities((m[2] ?? m[3] ?? m[4] ?? "").trim());
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) continue;
    const u = cleanUrl(raw, base);
    if (!u || u.hostname !== base.hostname) continue;
    if (ASSET_RE.test(u.pathname)) continue;
    out.add(u.toString());
  }
  return [...out];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/** Bodies of the JSON-LD blocks of a document. */
function jsonLdBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** `"@type": "Product"` or `"@type": ["Product", …]` — ProductGroup included. */
const LD_PRODUCT_TYPE = /"@type"\s*:\s*(\[[^\]]*"(Product|ProductGroup)"[^\]]*\]|"(Product|ProductGroup)")/g;

/** Product URLs declared in JSON-LD — the most reliable PDP signal when present. */
export function jsonLdProductUrls(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const body of jsonLdBlocks(html)) {
    if (!/"@type"\s*:\s*"?\[?[^"]*Product/i.test(body)) continue;
    for (const raw of body.match(/"url"\s*:\s*"([^"]+)"/gi) ?? []) {
      const v = raw.replace(/^.*"url"\s*:\s*"/i, "").replace(/"$/, "").replace(/\\\//g, "/");
      const u = cleanUrl(v, baseUrl);
      if (u) out.push(u.toString());
    }
  }
  return out;
}

export interface Candidate {
  url: string;
  score: number;
}

/** Whether a path may be proposed at all: never the home, never a service page. */
export function isEligiblePath(pathname: string): boolean {
  return pathname !== "/" && pathname !== "" && !EXCLUDE.test(pathname);
}

/** A URL that reads as a product page: an identifier AND a product route shape. */
export function looksLikePdp(url: string): boolean {
  const p = new URL(url).pathname;
  return isEligiblePath(p) && hasProductIdentifier(p) && score(p, PDP_PATTERNS) >= 3;
}

/** PDP candidates among `urls`, best URL shape first (shortest path on a tie). */
export function pdpCandidates(urls: string[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const p = new URL(url).pathname;
    if (!isEligiblePath(p) || !hasProductIdentifier(p) || seen.has(url)) continue;
    const s = score(p, PDP_PATTERNS);
    if (s === 0) continue;
    seen.add(url);
    out.push({ url, score: s });
  }
  return out.sort((a, b) => b.score - a.score || a.url.length - b.url.length);
}

/** PLP candidates among `urls`, best URL shape first (shortest path on a tie). */
export function plpCandidates(urls: string[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const u of urls) {
    const p = new URL(u).pathname;
    if (!isEligiblePath(p)) continue;
    if (score(p, PDP_PATTERNS) >= 5 && hasProductIdentifier(p)) continue; // that's a product
    const s = score(p, PLP_PATTERNS);
    if (s === 0 || seen.has(p)) continue;
    seen.add(p);
    out.push({ url: u, score: s });
  }
  // Best shape first. Among explicit routes the shortest path wins (the canonical
  // category route); among merely descriptive ones the DEEPER wins: "/jardin.html"
  // is a universe of sub-category tiles, "/jardin/…/etendage-exterieur.html" is
  // the leaf that lists products.
  const depth = (u: string) => Math.min(3, new URL(u).pathname.split("/").filter(Boolean).length);
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      (a.score <= 2 ? depth(b.url) - depth(a.url) : 0) ||
      a.url.length - b.url.length,
  );
}

/** Product links of a document — the fact that tells a listing from a landing page. */
export function productLinks(html: string, docUrl: string): string[] {
  return sameSiteLinks(html, docUrl).filter(looksLikePdp);
}

/** A listing links to several products; a landing page links to one or none. */
export const MIN_PRODUCTS_FOR_PLP = 3;

// --- Page-level confirmation --------------------------------------------------

/**
 * What an opened page says about being a product page. `signals` names the
 * evidence found; `listing` is set when the page declares SEVERAL items (a
 * listing whose tiles carry microdata/JSON-LD), which must not pass for a PDP.
 */
export interface PdpSignals {
  signals: string[];
  listing: boolean;
}

/**
 * What a detail page may declare itself as. Prospects are not all e-commerce: a
 * trip, a hotel, a car or an event page is the « PDP » of its site
 * (docs/DIAGNOSTIC.md — a tour or a funeral-service page has no product title).
 */
const ITEM_TYPES = new Set([
  "Product", "ProductGroup", "IndividualProduct", "ProductModel", "Vehicle", "Car", "Motorcycle",
  "Hotel", "LodgingBusiness", "Resort", "Accommodation", "Apartment", "House", "VacationRental",
  "Campground", "TouristTrip", "Trip", "Event", "Course", "Book", "RealEstateListing",
]);
const LISTING_TYPES = new Set(["ItemList", "CollectionPage", "OfferCatalog", "SearchResultsPage"]);

function typesOf(node: unknown): string[] {
  const t = (node as Record<string, unknown> | null)?.["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
}

/**
 * The TOP-LEVEL nodes of a JSON-LD block (`@graph` members, and the `mainEntity`
 * of a page node). Only they say what the page is: the Products nested in a
 * ProductGroup's variants or in « related products » are the page's neighbours —
 * counting them made damart.fr and petit-bateau.fr PDPs read as listings.
 * Null when the block is not valid JSON.
 */
function topLevelNodes(body: string): unknown[] | null {
  let json: unknown;
  try {
    json = JSON.parse(body.trim().replace(/^<!--/, "").replace(/-->$/, ""));
  } catch {
    return null;
  }
  const roots = (Array.isArray(json) ? json : [json]).flatMap((n) => {
    const graph = (n as Record<string, unknown> | null)?.["@graph"];
    return Array.isArray(graph) ? graph : [n];
  });
  return roots.flatMap((n) => {
    const main = (n as Record<string, unknown> | null)?.mainEntity;
    return main && typeof main === "object" && !Array.isArray(main) ? [n, main] : [n];
  });
}

/**
 * Detail-page signals of a document. Each one is a declaration a listing does not
 * make about itself: `og:type=product`, a `product:price` / `og:price` meta, ONE or
 * two top-level JSON-LD items (Product, Hotel, TouristTrip…) or an ItemPage, ONE
 * microdata `schema.org/Product`. A page that declares a listing (ItemList,
 * CollectionPage…), or three items or more, is the opposite fact.
 */
export function pdpSignals(html: string): PdpSignals {
  const signals: string[] = [];

  const ogProduct =
    /<meta\b[^>]*property\s*=\s*["']og:type["'][^>]*content\s*=\s*["'](og:)?product(\.item)?["']/i.test(html) ||
    /<meta\b[^>]*content\s*=\s*["'](og:)?product(\.item)?["'][^>]*property\s*=\s*["']og:type["']/i.test(html);
  if (ogProduct) signals.push("og:type product");
  if (/<meta\b[^>]*property\s*=\s*["'](product|og):price:amount["']/i.test(html)) {
    signals.push("meta prix produit");
  }

  const items: string[] = [];
  let ldListing = false;
  let itemPage = false;
  for (const body of jsonLdBlocks(html)) {
    const nodes = topLevelNodes(body);
    if (nodes) {
      for (const n of nodes) {
        const types = typesOf(n);
        const item = types.find((t) => ITEM_TYPES.has(t));
        if (item) items.push(item);
        if (types.some((t) => LISTING_TYPES.has(t))) ldListing = true;
        if (types.includes("ItemPage")) itemPage = true;
      }
    } else {
      // Invalid JSON (trailing comma, raw entities…): count the Product types seen.
      for (let i = (body.match(LD_PRODUCT_TYPE) ?? []).length; i > 0; i--) items.push("Product");
      if (/"@type"\s*:\s*"(ItemList|CollectionPage|OfferCatalog|SearchResultsPage)"/.test(body)) ldListing = true;
    }
  }
  // A listing may carry an item of its own (an aggregate rating on the category):
  // only a page that does NOT declare a listing is taken at its JSON-LD word.
  if (!ldListing && items.length >= 1 && items.length <= 2) signals.push(`JSON-LD ${items[0]}`);
  if (!ldListing && itemPage && !items.length) signals.push("JSON-LD ItemPage");

  const microdata = (html.match(/itemtype\s*=\s*["']https?:\/\/schema\.org\/Product["']/gi) ?? []).length;
  if (microdata === 1 && !ldListing) signals.push("microdata Product");

  const listing =
    !signals.length && (ldListing || items.length >= MIN_PRODUCTS_FOR_PLP || microdata >= MIN_PRODUCTS_FOR_PLP);
  return { signals, listing };
}

// --- Start point ---------------------------------------------------------------

/** A locale path segment: `fr`, `fr-fr`, `en_GB`. */
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z]{2})?$/i;

/**
 * Whether a URL is a home page: the root, or a locale root (`/fr`, `/fr-fr/`,
 * `/fr/fr`) — at most two locale segments, no query string. Used to label a pasted
 * URL as HP and to pick where discovery starts.
 */
export function isHomeLikeUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.search) return false;
  const segments = u.pathname.split("/").filter(Boolean);
  return segments.length <= 2 && segments.every((s) => LOCALE_SEGMENT.test(s));
}

/**
 * Where to start discovering a site's PDP/PLP: its first home-like URL (a locale
 * root keeps discovery in that locale), else the root of its first URL's host.
 */
export function discoveryStartUrl(urls: readonly string[]): string | null {
  const home = urls.find(isHomeLikeUrl);
  if (home) return home;
  for (const url of urls) {
    try {
      return `${new URL(url).origin}/`;
    } catch {
      /* not a URL — try the next one */
    }
  }
  return null;
}

/**
 * The locale prefix of a start URL (`/fr-fr/` → "/fr-fr/"), or "" at the root. A
 * sitemap lists every locale of a site; the one the operator pasted comes first.
 */
export function localePrefix(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  if (!segments.length || !segments.every((s) => LOCALE_SEGMENT.test(s))) return "";
  return `/${segments.join("/")}/`;
}

/** Stable sort putting the URLs under `prefix` first (no-op for an empty prefix). */
export function preferPrefix(urls: string[], prefix: string): string[] {
  if (!prefix) return urls;
  const inside = urls.filter((u) => (new URL(u).pathname + "/").toLowerCase().startsWith(prefix.toLowerCase()));
  const outside = urls.filter((u) => !inside.includes(u));
  return [...inside, ...outside];
}
