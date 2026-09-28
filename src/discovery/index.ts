/**
 * Page discovery — finds ONE PDP (and optionally ONE PLP) for a site, starting from
 * its home, for the operator to validate. Spec: ../../../docs/DIAGNOSTIC.md,
 * « Découverte des PDP / PLP ».
 *
 * Sources, cheapest first:
 *  1. the home's links (and its JSON-LD products);
 *  2. the sitemaps named by robots.txt — a product sitemap is the site's own list
 *     of PDPs, and it does not depend on a navigation built in JavaScript;
 *  3. candidate categories OPENED until one proves it is a listing by linking to
 *     several products — which hands over live PDP candidates at the same time.
 *
 * Every PDP candidate is then OPENED and kept as « confirmed » only if the page
 * declares a product (./rank.ts, pdpSignals). A candidate nobody could confirm is
 * « probable », and a site where nothing turned up is reported NOT FOUND with the
 * reason: an empty answer is honest, a guessed URL would silently be diagnosed as
 * a PDP.
 *
 * HTTP first; the browser (./browser.ts) takes over for the rest of the site as
 * soon as HTTP is refused by a WAF, or when the home's navigation is built in JS.
 */
import { blockSignature } from "../collector/challenge";
import {
  MIN_PRODUCTS_FOR_PLP,
  cleanUrl,
  jsonLdProductUrls,
  localePrefix,
  looksLikePdp,
  pdpCandidates,
  pdpSignals,
  plpCandidates,
  preferPrefix,
  productLinks,
  sameSiteLinks,
  isEligiblePath,
} from "./rank";
import { orderChildSitemaps, parseSitemap, robotsSitemaps, sitemapFlavour } from "./sitemap";
import type {
  DiscoveryOutcome,
  FetchedDoc,
  FetchResult,
  Fetcher,
  Proposal,
  SiteDiscovery,
} from "./types";

export * from "./types";
export { discoveryStartUrl, isHomeLikeUrl } from "./rank";

/** Pages opened per site, by fetcher: a browser navigation costs ten requests. */
const BUDGET = {
  http: { plpProbes: 6, pdpChecks: 3 },
  browser: { plpProbes: 3, pdpChecks: 2 },
} as const;
/** Sitemap documents read per site (robots.txt excluded). */
const MAX_SITEMAP_FETCHES = 4;
/** URLs kept from the sitemaps, per list. */
const MAX_SITEMAP_URLS = 40;
/** Alternatives offered next to a proposal. */
const MAX_ALTERNATIVES = 3;

export interface DiscoverOptions {
  want: { pdp: boolean; plp: boolean };
  http: Fetcher;
  /** Lazily creates the browser fetcher — omitted, discovery is HTTP only. */
  browser?: () => Fetcher;
  /** Pause between two requests to the same site, ms. */
  delayMs?: number;
}

/**
 * Why a response cannot be read as the site's page: a network failure, a WAF
 * status, or an interstitial / block page served in place of the document. Null
 * when it is a usable document. A 404 is NOT a block — just a dead URL.
 */
export function blockReason(r: FetchResult): string | null {
  if ("error" in r) return `échec (${r.error})`;
  if ([401, 403, 405, 406, 429, 503].includes(r.status)) return `HTTP ${r.status}`;
  if (r.status >= 400) return null;
  return blockSignature(r.html);
}

function isDoc(r: FetchResult): r is FetchedDoc {
  return !("error" in r);
}

/** Same host, `www.` aside: a sitemap may list the apex for a `www.` site. */
function sameHost(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  try {
    return strip(new URL(a).hostname) === strip(new URL(b).hostname);
  } catch {
    return false;
  }
}

/**
 * Fetching state of ONE site: which fetcher is in use (HTTP until it is refused,
 * then the browser for the rest of the site), the pacing, and the facts worth
 * reporting to the operator.
 */
class SiteSession {
  current: Fetcher;
  private browserFetcher: Fetcher | null = null;
  private requests = 0;
  /** Set when HTTP was refused and the browser took over. */
  switchedBecause: string | null = null;

  constructor(private readonly opts: DiscoverOptions) {
    this.current = opts.http;
  }

  get canUseBrowser(): boolean {
    return !!this.opts.browser && this.current.kind === "http";
  }

  private async pace(): Promise<void> {
    if (this.requests++ > 0 && (this.opts.delayMs ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs));
    }
  }

  /** Switches the rest of the site to the browser. False when there is none. */
  useBrowser(reason: string): boolean {
    if (!this.canUseBrowser) return false;
    this.browserFetcher ??= this.opts.browser!();
    this.current = this.browserFetcher;
    this.switchedBecause = reason;
    return true;
  }

  /**
   * A page through the current fetcher. When HTTP is refused (WAF status, block
   * page, network failure) the browser takes over and the page is fetched again.
   */
  async page(url: string): Promise<{ doc: FetchedDoc | null; reason: string | null }> {
    await this.pace();
    let r = await this.current.get(url);
    let reason = blockReason(r);
    if (reason && this.useBrowser(reason)) {
      await this.pace();
      r = await this.current.get(url);
      reason = blockReason(r);
    }
    if (reason || !isDoc(r)) return { doc: null, reason: reason ?? "échec" };
    return { doc: r, reason: null };
  }

  /** A plain HTTP read (robots.txt, sitemaps): never worth a browser. */
  async raw(url: string): Promise<FetchedDoc | null> {
    await this.pace();
    const r = await this.opts.http.get(url);
    return isDoc(r) && r.status < 400 ? r : null;
  }

  get budget() {
    return BUDGET[this.current.kind];
  }
}

interface SitemapFindings {
  products: string[];
  categories: string[];
  /** What was read, for the note. */
  note: string;
}

/**
 * Product and category URLs from the site's sitemaps, same host only, the start
 * URL's locale first. Children are opened by what their name says they list; a
 * sitemap that says neither (Magento, PrestaShop) is classified URL by URL.
 */
async function readSitemaps(
  s: SiteSession,
  startUrl: string,
  want: DiscoverOptions["want"],
): Promise<SitemapFindings> {
  const origin = new URL(startUrl).origin;
  const prefix = localePrefix(startUrl);
  const robots = await s.raw(`${origin}/robots.txt`);
  let roots = robots ? robotsSitemaps(robots.html, origin) : [];
  if (!roots.length) roots = [`${origin}/sitemap.xml`];

  const products: string[] = [];
  const categories: string[] = [];
  let fetched = 0;
  const seen = new Set<string>();

  const absorb = (urls: string[], flavour: ReturnType<typeof sitemapFlavour>) => {
    for (const url of urls) {
      if (!sameHost(url, startUrl)) continue;
      const path = new URL(url).pathname;
      if (!isEligiblePath(path)) continue;
      if (flavour === "product") products.push(url);
      else if (flavour === "category") categories.push(url);
      else if (looksLikePdp(url)) products.push(url);
      else if (plpCandidates([url]).length) categories.push(url);
    }
  };

  const children: string[] = [];
  for (const root of roots.slice(0, 2)) {
    if (fetched >= MAX_SITEMAP_FETCHES || seen.has(root)) continue;
    seen.add(root);
    fetched++;
    const doc = await s.raw(root);
    if (!doc) continue;
    const parsed = parseSitemap(doc.html);
    children.push(...parsed.sitemaps);
    absorb(parsed.urls, sitemapFlavour(root));
  }

  // Children worth opening: the product ones for a PDP, one category one for a PLP.
  const queue = [
    ...(want.pdp ? orderChildSitemaps(children, "product", prefix).slice(0, 2) : []),
    ...(want.plp ? orderChildSitemaps(children, "category", prefix).slice(0, 1) : []),
  ];
  for (const child of queue) {
    if (fetched >= MAX_SITEMAP_FETCHES || seen.has(child)) continue;
    seen.add(child);
    fetched++;
    const doc = await s.raw(child);
    if (!doc) continue;
    absorb(parseSitemap(doc.html).urls, sitemapFlavour(child));
  }

  const dedupe = (xs: string[]) => preferPrefix([...new Set(xs)], prefix).slice(0, MAX_SITEMAP_URLS);
  const note = !robots && fetched === 0 ? "" : `sitemap : ${products.length} URL(s) produit, ${categories.length} catégorie(s)`;
  return { products: dedupe(products), categories: dedupe(categories), note };
}

/** Result of opening PLP candidates until one links to enough products. */
interface PlpProbe {
  url: string;
  products: string[];
  source: string;
}

/**
 * Opens candidate categories until one links to enough products. Links the HOME
 * also carries do not count: they are the site's navigation, repeated on every
 * page. but.fr names its categories `/cuisine/index-a10315.html` — a product
 * shape — and a landing page linking to its menu would otherwise pass for a
 * listing of 25 products.
 */
async function probePlps(
  s: SiteSession,
  candidates: Array<{ url: string; source: string }>,
  homeLinks: ReadonlySet<string>,
): Promise<{ found: PlpProbe | null; opened: number }> {
  let opened = 0;
  for (const c of candidates) {
    if (opened >= s.budget.plpProbes) break;
    opened++;
    const { doc } = await s.page(c.url);
    if (!doc || doc.status >= 400) continue;
    const products = productLinks(doc.html, doc.url).filter((u) => !homeLinks.has(u));
    if (products.length >= MIN_PRODUCTS_FOR_PLP) {
      return { found: { url: doc.url, products, source: c.source }, opened };
    }
  }
  return { found: null, opened };
}

/** Why a PDP candidate did not confirm, for the note. */
type CheckFailure = "blocked" | "dead" | "moved" | "no-signal" | "listing";

async function checkPdp(
  s: SiteSession,
  url: string,
): Promise<{ ok: true; signals: string[]; finalUrl: string } | { ok: false; why: CheckFailure }> {
  const { doc } = await s.page(url);
  if (!doc) return { ok: false, why: "blocked" };
  if (doc.status >= 400) return { ok: false, why: "dead" };
  // A removed product often redirects to its category or to the home.
  const landed = new URL(doc.url).pathname;
  if (landed !== new URL(url).pathname && !isEligiblePath(landed)) return { ok: false, why: "moved" };
  const sig = pdpSignals(doc.html);
  if (sig.listing) return { ok: false, why: "listing" };
  if (!sig.signals.length) return { ok: false, why: "no-signal" };
  return { ok: true, signals: sig.signals, finalUrl: doc.url };
}

const FAILURE_LABEL: Record<CheckFailure, string> = {
  blocked: "bloqué",
  dead: "page morte (4xx)",
  moved: "redirigé hors produit",
  "no-signal": "aucun signal produit",
  listing: "c'est une liste",
};

/** Ordered PDP candidates with their source, first-seen wins on duplicates. */
function mergeCandidates(groups: Array<{ urls: string[]; source: string }>): Array<{ url: string; source: string }> {
  const out: Array<{ url: string; source: string }> = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const url of g.urls) {
      const key = cleanUrl(url)?.toString() ?? url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: key, source: g.source });
    }
  }
  return out;
}

function via(s: SiteSession): Proposal["via"] {
  return s.current.kind;
}

function browserNote(s: SiteSession): string {
  return s.switchedBecause ? ` · navigateur utilisé (HTTP refusé : ${s.switchedBecause})` : "";
}

/**
 * Discovers the PDP (and/or PLP) of the site whose home is `startUrl`. Never
 * throws: every failure ends up as a NOT FOUND with its reason.
 */
export async function discoverSite(startUrl: string, opts: DiscoverOptions): Promise<SiteDiscovery> {
  const s = new SiteSession(opts);
  const result: SiteDiscovery = { startUrl };
  const want = opts.want;
  if (!want.pdp && !want.plp) return result;

  // ── 1. Home ──────────────────────────────────────────────────────────────────
  let { doc: home, reason: homeBlocked } = await s.page(startUrl);
  let homeLinks = home ? sameSiteLinks(home.html, home.url) : [];
  // Nothing to rank in the served HTML: the navigation is built in JavaScript.
  // The browser reads the rendered DOM, and the rest of the site goes through it.
  if (home && !plpCandidates(homeLinks).length && !pdpCandidates(homeLinks).length &&
      s.useBrowser(`navigation construite en JS (${homeLinks.length} lien(s) dans le HTML)`)) {
    const rendered = await s.page(startUrl);
    if (rendered.doc) {
      home = rendered.doc;
      homeLinks = sameSiteLinks(home.html, home.url);
    }
  }

  // ── 2. Sitemaps ──────────────────────────────────────────────────────────────
  const sitemap = await readSitemaps(s, startUrl, want);

  // ── 3. Listings ──────────────────────────────────────────────────────────────
  // Live product links first: a JSON-LD product declared by the home (the site says
  // it is one — only the home itself and other hosts are excluded), then links of
  // an explicit product shape.
  const homeProducts = home
    ? [
        ...jsonLdProductUrls(home.html, home.url).filter(
          (u) => sameHost(u, startUrl) && isEligiblePath(new URL(u).pathname),
        ),
        ...pdpCandidates(homeLinks).filter((c) => c.score >= 5).map((c) => c.url),
      ]
    : [];
  const plpList = mergeCandidates([
    { urls: plpCandidates(homeLinks).map((c) => c.url), source: "lien de la home" },
    { urls: sitemap.categories, source: "sitemap catégories" },
  ]);
  const needListing = want.plp || (want.pdp && !homeProducts.length && !sitemap.products.length);
  const probe = needListing ? await probePlps(s, plpList, new Set(homeLinks)) : { found: null, opened: 0 };

  // ── 4. PDP ───────────────────────────────────────────────────────────────────
  if (want.pdp) {
    const candidates = mergeCandidates([
      { urls: homeProducts, source: "lien produit de la home" },
      { urls: probe.found?.products ?? [], source: "lien de la PLP" },
      { urls: sitemap.products, source: "sitemap produits" },
      { urls: pdpCandidates(homeLinks).map((c) => c.url), source: "forme d'URL (home)" },
    ]).filter((c) => c.url !== probe.found?.url);
    result.pdp = await choosePdp(s, candidates, { home, homeBlocked, homeLinks, sitemap });
  }

  // ── 5. PLP ───────────────────────────────────────────────────────────────────
  if (want.plp) result.plp = choosePlp(s, probe, plpList, { home, homeBlocked, homeLinks, sitemap });

  return result;
}

interface HomeFacts {
  home: FetchedDoc | null;
  homeBlocked: string | null;
  homeLinks: string[];
  sitemap: SitemapFindings;
}

/** Why nothing could be proposed — the most telling fact first. */
function notFoundNote(s: SiteSession, facts: HomeFacts, what: string): string {
  const parts: string[] = [];
  if (!facts.home) parts.push(`home illisible (${facts.homeBlocked ?? "échec"})`);
  else if (!facts.homeLinks.length) parts.push("aucun lien dans la home (navigation en JS ?)");
  else parts.push(`aucun ${what} parmi les ${facts.homeLinks.length} liens de la home`);
  parts.push(facts.sitemap.note || "pas de sitemap exploitable");
  return parts.join(" · ") + browserNote(s);
}

/**
 * Opens PDP candidates until one declares a product. What an opened page shows
 * decides what may still be proposed:
 *  - dead, redirected away, or a listing → never proposed;
 *  - readable but declaring no product → not proposed either (a product page
 *    nearly always declares itself, for its rich results), but kept as a lead the
 *    operator can pick — after one more try in the browser, since a SPA may
 *    inject its JSON-LD in JavaScript;
 *  - unreadable (blocked) or not opened at all (budget spent) → « probable »: we
 *    know nothing against it, and nothing for it.
 */
async function choosePdp(
  s: SiteSession,
  candidates: Array<{ url: string; source: string }>,
  facts: HomeFacts,
): Promise<DiscoveryOutcome> {
  if (!candidates.length) {
    return { found: false, note: notFoundNote(s, facts, "lien produit"), via: via(s), alternatives: [] };
  }
  const failures: string[] = [];
  const verdict = new Map<string, CheckFailure>();
  let checked = 0;

  const tryOne = async (c: { url: string; source: string }): Promise<Proposal | null> => {
    checked++;
    const r = await checkPdp(s, c.url);
    if (r.ok) {
      const alternatives = candidates
        .filter((x) => x.url !== c.url && !isRuledOut(verdict.get(x.url)))
        .slice(0, MAX_ALTERNATIVES)
        .map((x) => x.url);
      return {
        found: true,
        url: r.finalUrl,
        confidence: "confirmed",
        source: c.source,
        note: `page ouverte : ${r.signals.join(", ")}${browserNote(s)}`,
        alternatives,
        via: via(s),
      };
    }
    failures.push(FAILURE_LABEL[r.why]);
    verdict.set(c.url, r.why);
    return null;
  };

  for (const c of candidates.slice(0, s.budget.pdpChecks)) {
    const hit = await tryOne(c);
    if (hit) return hit;
  }
  // Readable pages without any product markup: their markup may be built in JS.
  const bare = candidates.filter((c) => verdict.get(c.url) === "no-signal");
  if (bare.length && s.useBrowser("aucun signal produit dans le HTML servi")) {
    for (const c of bare.slice(0, s.budget.pdpChecks)) {
      const hit = await tryOne(c);
      if (hit) return hit;
    }
  }

  // Pages that were read and are not detail pages say the candidates' SHAPE is
  // wrong for this site (lapeyre.fr: "/produits/salle-bains-wc/espace-wc" is a
  // category): their unopened siblings are leads then, not proposals. A dead or
  // redirected URL only says the list was stale.
  const shapeWrong = [...verdict.values()].some((v) => v === "no-signal" || v === "listing");
  const leads = candidates
    .filter((c) => verdict.get(c.url) === "no-signal" || (shapeWrong && !verdict.has(c.url)))
    .map((c) => c.url);
  const unknown = candidates.filter((c) => {
    const v = verdict.get(c.url);
    return v === "blocked" || (v === undefined && !shapeWrong);
  });
  if (!unknown.length) {
    return {
      found: false,
      note: `${checked} candidat(s) ouvert(s), aucun ne déclare de produit (${failures.join(", ")})${browserNote(s)}`,
      via: via(s),
      alternatives: leads.slice(0, MAX_ALTERNATIVES),
    };
  }
  const [best, ...rest] = unknown;
  return {
    found: true,
    url: best.url,
    confidence: "probable",
    source: best.source,
    note: `non vérifiée : ${checked} candidat(s) ouvert(s) (${failures.join(", ")}), celle-ci ${verdict.get(best.url) === "blocked" ? "illisible (blocage)" : "non ouverte"}${browserNote(s)}`,
    alternatives: [...rest.map((x) => x.url), ...leads].slice(0, MAX_ALTERNATIVES),
    via: via(s),
  };
}

/** A candidate the page itself disproved. */
function isRuledOut(v: CheckFailure | undefined): boolean {
  return v === "dead" || v === "moved" || v === "listing";
}

function choosePlp(
  s: SiteSession,
  probe: { found: PlpProbe | null; opened: number },
  plpList: Array<{ url: string; source: string }>,
  facts: HomeFacts,
): DiscoveryOutcome {
  const others = (url: string) => plpList.filter((c) => c.url !== url).slice(0, MAX_ALTERNATIVES).map((c) => c.url);
  if (probe.found) {
    return {
      found: true,
      url: probe.found.url,
      confidence: "confirmed",
      source: probe.found.source,
      note: `page ouverte : ${probe.found.products.length} liens produits${browserNote(s)}`,
      alternatives: others(probe.found.url),
      via: via(s),
    };
  }
  // Nothing proved to be a listing. A category route of explicit shape (or a URL
  // the category sitemap declares) is still worth showing — as unconfirmed.
  const fallback =
    plpList.find((c) => c.source === "sitemap catégories") ??
    plpList.find((c) => (plpCandidates([c.url])[0]?.score ?? 0) >= 5);
  if (fallback) {
    return {
      found: true,
      url: fallback.url,
      confidence: "probable",
      source: fallback.source,
      note: `non confirmée : ${probe.opened} catégorie(s) ouverte(s), aucune ne liste ${MIN_PRODUCTS_FOR_PLP} produits${browserNote(s)}`,
      alternatives: others(fallback.url),
      via: via(s),
    };
  }
  return {
    found: false,
    note: notFoundNote(s, facts, "lien de catégorie"),
    via: via(s),
    alternatives: plpList.slice(0, MAX_ALTERNATIVES).map((c) => c.url),
  };
}
