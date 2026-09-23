/**
 * Discover a PLP and a PDP candidate for every site of a project, from its homepage.
 *
 * Plain HTTP requests, no browser: the HP HTML is fetched, its links are ranked by URL
 * shape, then the best candidates are OPENED (up to MAX_PLP_PROBES) and kept only if they
 * link to several products — a listing links to products, a landing page does not. That
 * fact confirms the PLP and yields the PDP in one go. Output is a REVIEW CSV
 * (`domaine;url_plp;url_pdp;plp_score;pdp_score;note`) meant to be checked by a human and
 * then fed to `db:seed-domains --plp-column/--pdp-column`. Nothing is written to the
 * database here.
 *
 * A JS-built navigation or a WAF block leaves the cell empty with the reason in `note` —
 * an empty cell is the honest answer, a guessed URL would silently be audited as a PDP.
 *
 * Run: npm run discover:pages -- --project "Tests prods" [--client Fasterize]
 *        [--out data/discovered-plp-pdp.csv] [--delay 400]
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { prisma } from "./db";

const UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Mobile Safari/537.36";

/** A homepage's markup is all we scan for <a href>; 3 MB is already generous. */
const MAX_BODY_BYTES = 3_000_000;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`missing --${name}`);
    return fallback;
  }
  return v;
}

type Hop =
  | { url: string; status: number; html: string; location?: string }
  | { error: string };

function requestOnce(url: string): Promise<Hop> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve({ error: "URL invalide" });
    }
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
        },
        timeout: 20_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ url: u.toString(), status, html: "", location });
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (c: Buffer) => {
          bytes += c.length;
          if (bytes <= MAX_BODY_BYTES) chunks.push(c);
        });
        res.on("end", () =>
          resolve({ url: u.toString(), status, html: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    req.on("error", (e) => resolve({ error: (e as Error).message }));
    req.end();
  });
}

/**
 * GET following redirects, resolving to the FINAL url + body. A timeout or a socket
 * error is retried once: losing a whole site to one flaky connection is not worth it.
 */
async function get(
  url: string,
  retriesLeft = 1,
): Promise<{ url: string; status: number; html: string } | { error: string }> {
  const r = await getOnce(url);
  if ("error" in r && retriesLeft > 0 && r.error !== "URL invalide") {
    await new Promise((s) => setTimeout(s, 1500));
    return get(url, retriesLeft - 1);
  }
  return r;
}

async function getOnce(
  url: string,
): Promise<{ url: string; status: number; html: string } | { error: string }> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const r = await requestOnce(current);
    if ("error" in r) return r;
    if (r.location) {
      try {
        current = new URL(r.location, r.url).toString();
      } catch {
        return { error: "redirection invalide" };
      }
      continue;
    }
    return { url: r.url, status: r.status, html: r.html };
  }
  return { error: "trop de redirections" };
}

// --- Link ranking ------------------------------------------------------------------

/**
 * Paths that are never a PLP nor a PDP, whatever else they match. Editorial and
 * service sections are the main source of false positives: they have the same URL
 * shape as a category ("/services/retrait", "/conseils/…", "/guides-d-achat/…").
 */
const EXCLUDE =
  /(^|\/)[^/]*(cart|panier|basket|checkout|commande|account|compte|customer|profil|espace-client|espace-pro|login|connexion|signin|register|inscription|wishlist|favoris|store-?locator|magasins?|contact|aide|help|support|faq|avis|blog|journal|actualite|actus?|news|presse|press|dossier|inspiration|conseil|guide|career|carriere|recrutement|jobs|service|livraison|retrait|drive|garantie|detaxe?|cgv|cgu|cgs|mentions?|legal|licence|privacy|vie-privee|confidentialite|cookie|plan-du-site|sitemap|newsletter|configurateur|liens-utiles|relation-client|landing-page|search|recherche)[^/]*(\/|$)/i;

/**
 * A product URL carries an IDENTIFIER — a sku or a numeric id. Without one,
 * "/produits/tapis" and "/produits/salle-de-bain-et-wc" are categories, not products.
 * A long descriptive slug was tried as a second signal and dropped: category slugs are
 * just as long ("tous-les-produits-enfants"), so it only manufactured false positives.
 */
function hasProductIdentifier(pathname: string): boolean {
  const segments = pathname.replace(/^\/|\/$/g, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  if (/\d{3,}/.test(last)) return true; // sku / numeric id in the last segment
  if (/\d{3,}/.test(pathname) && /\.html?$/i.test(pathname)) return true;
  // A product route with SEVERAL segments after its marker names one item
  // ("/p/rosas-premium/1/red"). One segment after the marker is a category
  // ("/produits/tapis", "/products/tous-les-produits-enfants.html").
  const marker = segments.findIndex((s) => /^(p|dp|pd|prd|products?|produits?|item)$/i.test(s));
  return marker >= 0 && segments.length - marker - 1 >= 2;
}

/** Strong PDP shapes: a product-detail route with an identifier segment. */
const PDP_PATTERNS: Array<[RegExp, number]> = [
  [/\/(products?|produits?|item|article)\/[^/]{3,}/i, 6],
  [/\/(p|dp|pd|prd)\/[^/]{3,}/i, 6],
  [/-p-?\d{3,}/i, 6],
  [/\/fiche[-_]?produit\//i, 6],
  [/\/prod\d{3,}/i, 5],
  [/\/[^/]*-\d{5,}\.html?$/i, 5],
  [/\/[^/]+\/[^/]*\d{4,}[^/]*\.html?$/i, 3],
];

/** Category / listing shapes, from the most explicit to the weakest. */
const PLP_PATTERNS: Array<[RegExp, number]> = [
  [/\/(c|categor(?:y|ie|ies|ia|ias)|rayon|rayons|univers|catalogue|gamme)\/[^/]{2,}/i, 6],
  [/\/collections?\/[^/]{2,}/i, 5],
  [/\/(shop|boutique|nos-produits|tous-les-produits|listing)\//i, 4],
  [/\/[a-z0-9-]{4,}\/[a-z0-9-]{4,}\/?$/i, 2],
  [/\/[a-z0-9-]{4,}\/?$/i, 1],
];

function score(pathname: string, patterns: Array<[RegExp, number]>): number {
  let best = 0;
  for (const [re, pts] of patterns) if (re.test(pathname)) best = Math.max(best, pts);
  return best;
}

/**
 * Absolute, http(s) links of a document, de-duplicated. Restricted to the SAME HOST —
 * `blog.` / `aide.` / `support.` subdomains share the registrable domain but are a
 * different site, and their editorial URLs look exactly like categories.
 */
function sameSiteLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) continue;
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.hostname !== base.hostname) continue;
    if (/\.(jpe?g|png|webp|avif|gif|svg|pdf|zip|mp4|css|js)$/i.test(u.pathname)) continue;
    u.hash = "";
    // "//catalog//category//" and "/catalog/category/" are the same page: collapsing
    // repeated slashes keeps the de-duplication (and the PLP≠PDP check) honest.
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    out.add(u.toString());
  }
  return [...out];
}

/** Product URLs declared in JSON-LD — the most reliable PDP signal when present. */
function jsonLdProductUrls(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const body = m[1];
    if (!/"@type"\s*:\s*"?\[?[^"]*Product/i.test(body)) continue;
    for (const raw of body.match(/"url"\s*:\s*"([^"]+)"/gi) ?? []) {
      const v = raw.replace(/^.*"url"\s*:\s*"/i, "").replace(/"$/, "");
      try {
        out.push(new URL(v, baseUrl).toString());
      } catch {
        /* not a usable url */
      }
    }
  }
  return out;
}

type Pick = { url: string; score: number } | null;

function pick(
  candidates: string[],
  patterns: Array<[RegExp, number]>,
  opts: { requireIdentifier?: boolean; reject?: (url: string) => boolean } = {},
): Pick {
  let best: Pick = null;
  for (const c of candidates) {
    const p = new URL(c).pathname;
    if (p === "/" || p === "") continue; // the homepage is never a PLP nor a PDP
    if (EXCLUDE.test(p)) continue;
    if (opts.requireIdentifier && !hasProductIdentifier(p)) continue;
    if (opts.reject?.(c)) continue;
    const s = score(p, patterns);
    if (s === 0) continue;
    // Ties go to the shortest path: the canonical route rather than a deep variant.
    if (!best || s > best.score || (s === best.score && c.length < best.url.length)) {
      best = { url: c, score: s };
    }
  }
  return best;
}

/** Best PDP of one document: a JSON-LD Product url first, else a strong URL shape. */
function findPdp(html: string, docUrl: string, reject?: (url: string) => boolean): Pick {
  const ld = jsonLdProductUrls(html, docUrl).filter(
    (u) => !EXCLUDE.test(new URL(u).pathname) && new URL(u).pathname !== "/" && !reject?.(u),
  );
  if (ld.length) return { url: ld[0], score: 9 };
  return pick(sameSiteLinks(html, docUrl), PDP_PATTERNS, { requireIdentifier: true, reject });
}

/** Product links of a document — the fact that tells a listing from a landing page. */
function productLinks(html: string, docUrl: string): string[] {
  return sameSiteLinks(html, docUrl).filter((u) => {
    const p = new URL(u).pathname;
    return !EXCLUDE.test(p) && hasProductIdentifier(p) && score(p, PDP_PATTERNS) >= 3;
  });
}

/** A listing links to several products; a landing page links to one or none. */
const MIN_PRODUCTS_FOR_PLP = 3;
/** How many candidate categories we are willing to open per site. */
const MAX_PLP_PROBES = 6;

/** PLP candidates of a homepage, best URL shape first. */
function plpCandidates(html: string, docUrl: string): Array<{ url: string; score: number }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; score: number }> = [];
  for (const u of sameSiteLinks(html, docUrl)) {
    const p = new URL(u).pathname;
    if (p === "/" || EXCLUDE.test(p)) continue;
    if (score(p, PDP_PATTERNS) >= 5 && hasProductIdentifier(p)) continue; // that's a product
    const s = score(p, PLP_PATTERNS);
    if (s === 0 || seen.has(p)) continue;
    seen.add(p);
    out.push({ url: u, score: s });
  }
  // Best shape first, shortest path as the tie-breaker (the canonical category route).
  out.sort((a, b) => b.score - a.score || a.url.length - b.url.length);
  return out;
}

function csvCell(v: string): string {
  return v.includes(";") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main() {
  const projectName = arg("project");
  const clientName = process.argv.includes("--client") ? arg("client") : undefined;
  const outPath = path.resolve(arg("out", "data/discovered-plp-pdp.csv"));
  const delay = Number(arg("delay", "400"));

  const project = await prisma.project.findFirst({
    where: { name: projectName, ...(clientName ? { client: { name: clientName } } : {}) },
    include: { pages: { include: { page: { include: { site: true } } } } },
  });
  if (!project) throw new Error(`project not found: ${projectName}`);

  // One entry per site: the HP is what we crawl (falling back to any page of that site).
  const sites = new Map<number, { name: string; hp: string }>();
  for (const pp of project.pages) {
    const s = pp.page.site;
    const known = sites.get(s.id);
    if (!known || pp.page.kind === "HP") {
      sites.set(s.id, { name: s.name, hp: s.homepage ?? pp.page.url });
    }
  }

  const rows: string[] = ["domaine;url_plp;url_pdp;plp_score;pdp_score;note"];
  let found = 0;
  let i = 0;
  for (const [, s] of sites) {
    i++;
    const res = await get(s.hp);
    let plp = "";
    let pdp = "";
    let plpScore = "";
    let pdpScore = "";
    let note = "";

    if ("error" in res) {
      note = `fetch KO: ${res.error}`;
    } else if (res.status >= 400) {
      note = `HTTP ${res.status} (blocage WAF probable)`;
    } else {
      const links = sameSiteLinks(res.html, res.url);
      const candidates = plpCandidates(res.html, res.url);

      // Open the best candidates until one PROVES it is a listing by linking to
      // several products. That fact replaces the word-list guesswork: a landing page
      // ("/configurateur/dressing", "/liens-utiles/cgv-national") never passes it,
      // and the products it lists hand us the PDP at the same time.
      let probes = 0;
      for (const c of candidates.slice(0, MAX_PLP_PROBES)) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        probes++;
        const plpRes = await get(c.url);
        if ("error" in plpRes || plpRes.status >= 400) continue;
        const products = productLinks(plpRes.html, plpRes.url);
        if (products.length < MIN_PRODUCTS_FOR_PLP) continue;
        plp = c.url;
        plpScore = `${c.score} (${products.length} produits)`;
        pdp = products[0];
        pdpScore = "via PLP";
        break;
      }

      if (!plp) {
        // Nothing confirmed. A JSON-LD Product on the homepage still gives a real PDP,
        // and the best-shaped category is reported as UNCONFIRMED rather than as a fact.
        const bestPdp = findPdp(res.html, res.url);
        if (bestPdp) {
          pdp = bestPdp.url;
          pdpScore = String(bestPdp.score);
        }
        const fallback = candidates.find((c) => c.score >= 5);
        if (fallback) {
          plp = fallback.url;
          plpScore = `${fallback.score} (non confirmée)`;
        }
        if (!candidates.length && !pdp) {
          note = `aucun lien exploitable (${links.length} liens, nav en JS ?)`;
        } else if (!plp) {
          note = `PLP non confirmée (${probes} candidat(s) ouvert(s) sur ${candidates.length})`;
        } else if (!pdp) {
          note = "PDP non trouvée";
        }
      }
    }

    // A PDP without a numeric id in its last segment was matched on its route alone
    // ("/produits/revetement-sol/vinyle-lino-pvc"): often right, sometimes a deep
    // category. Flag it for review rather than presenting it as a settled fact.
    if (pdp && !/\d{3,}/.test(new URL(pdp).pathname.replace(/\/$/, "").split("/").pop() ?? "")) {
      note = note ? `${note} ; PDP à vérifier (pas d'identifiant)` : "PDP à vérifier (pas d'identifiant)";
    }

    if (plp || pdp) found++;
    rows.push([s.name, plp, pdp, plpScore, pdpScore, note].map(csvCell).join(";"));
    console.log(
      `[${i}/${sites.size}] ${s.name} → PLP ${plp || "-"} | PDP ${pdp || "-"}${note ? ` (${note})` : ""}`,
    );
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rows.join("\n") + "\n", "utf-8");
  console.log(
    `\nDone. ${found}/${sites.size} site(s) avec au moins un candidat → ${outPath}\n` +
      `Relis le CSV, puis importe-le :\n` +
      `  npm run db:seed-domains -- --client <client> --project "${projectName}" \\\n` +
      `    --csv ${outPath} --delimiter ";" --plp-column url_plp --pdp-column url_pdp`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
