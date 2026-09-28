/**
 * Page discovery — PURE sitemap reading. `robots.txt` names the sitemaps, a sitemap
 * index names its children, and the children's FILE NAMES usually say what they
 * list: `sitemap_products_1.xml` (Shopify), `sitemap_0-product.xml` (SFCC),
 * `product-sitemap.xml` (WooCommerce/Yoast). A product sitemap is a declaration
 * by the site itself — the strongest list of PDPs there is, and it does not depend
 * on a navigation built in JavaScript.
 */
import { cleanUrl } from "./rank";

/** `Sitemap:` lines of a robots.txt, as absolute URLs (relative ones resolved on `origin`). */
export function robotsSitemaps(robotsTxt: string, origin: string): string[] {
  const out: string[] = [];
  for (const line of robotsTxt.split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (!m) continue;
    const u = cleanUrl(m[1], origin);
    if (u && !out.includes(u.toString())) out.push(u.toString());
  }
  return out;
}

export interface ParsedSitemap {
  /** Child sitemaps of a sitemap index. */
  sitemaps: string[];
  /** Page URLs of a urlset. */
  urls: string[];
}

function locs(block: string, tag: "sitemap" | "url"): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const loc = m[1].match(/<loc\b[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    const u = cleanUrl(loc.trim().replace(/&amp;/gi, "&"));
    if (u) out.push(u.toString());
  }
  return out;
}

/**
 * Children and page URLs of a sitemap document. Tolerates a body cut short (the
 * fetch caps what it reads): every COMPLETE `<url>` entry before the cut is kept.
 */
export function parseSitemap(xml: string): ParsedSitemap {
  return { sitemaps: locs(xml, "sitemap"), urls: locs(xml, "url") };
}

export type SitemapFlavour = "product" | "category" | "other";

/**
 * What a child sitemap lists, read from its URL. Category first: WooCommerce names
 * its category sitemap `product_cat-sitemap.xml`, which also says "product".
 */
export function sitemapFlavour(url: string): SitemapFlavour {
  const name = decodeURIComponent(new URL(url).pathname + new URL(url).search).toLowerCase();
  // "cat" as a word only ("sitemap-cat.xml", castorama), never inside "catalog".
  if (/categor|collection|product[_-]?cat|rayon|listing|plp|univers|(^|[^a-z])cat([^a-z]|$)/.test(name)) return "category";
  if (/image|video|blog|post|news|store|magasin|brand|marque|cms|content|page(?!s?[_-]?prod)/.test(name) &&
      !/produ/.test(name)) {
    return "other";
  }
  // "item" and "prd" as words only: "sitemap" itself contains "item";
  // castorama names its product sitemaps "sitemap-prd.xml", "sitemap-prd2.xml".
  if (/produ|pdp|sku|(^|[^a-z])(items?|prd)([^a-z]|$)/.test(name)) return "product";
  return "other";
}

/** `/fr-fr/` → ["fr-fr", "fr_fr"] — the ways a locale shows up in a sitemap URL. */
function localeTokens(prefix: string): string[] {
  const seg = prefix.split("/").filter(Boolean).join("-").toLowerCase();
  if (!seg) return [];
  return [...new Set([seg, seg.replace(/-/g, "_"), `/${seg.split("-")[0]}/`])];
}

/**
 * Child sitemaps worth opening for `want`, most promising first: the right
 * flavour, then — for a start URL under a locale — the ones naming that locale.
 * Generic children ("other") come last: a Magento or PrestaShop sitemap lists
 * products and categories together under a name that says neither.
 */
export function orderChildSitemaps(
  children: string[],
  want: "product" | "category",
  prefix = "",
): string[] {
  const tokens = localeTokens(prefix);
  const rank = (url: string): number => {
    const flavour = sitemapFlavour(url);
    const base = flavour === want ? 0 : flavour === "other" ? 2 : 4;
    const lower = url.toLowerCase();
    const local = tokens.length && tokens.some((t) => lower.includes(t)) ? 0 : 1;
    return base + local;
  };
  return children
    .map((url, i) => ({ url, i, r: rank(url) }))
    .filter((c) => c.r < 4) // never the wrong flavour
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((c) => c.url);
}
