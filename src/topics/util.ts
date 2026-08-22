/**
 * Shared helpers for topic modules. Pure, dependency-free.
 * Keep topic-specific data (e.g. GFW domain lists, 3rd-party category maps) in the
 * relevant topic file; this module holds only generic parsing/URL utilities.
 */
import { getDomain } from "tldts";
import type { HeaderMap, NetworkRequest } from "../core";

/** Hostname (lowercased) of a URL, or "" if unparseable. Handles protocol-relative
 *  ("//cdn.example.com") URLs, which are common in markup. */
export function host(url: string): string {
  try {
    const u = url.startsWith("//") ? "https:" + url : url;
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Registrable domain (eTLD+1) via the Public Suffix List, e.g. "a.b.example.co.uk"
 * → "example.co.uk". Falls back to the last-two-labels heuristic for hostnames
 * `tldts` can't resolve (e.g. bare IPs, single-label hosts like "localhost").
 */
export function registrableDomain(hostname: string): string {
  // allowPrivateDomains: private PSL entries (github.io, vercel.app, ...) host
  // unrelated tenants on subdomains, so treat them like a real eTLD for our
  // first/third-party comparisons instead of collapsing them all into one site.
  const domain = getDomain(hostname, { allowPrivateDomains: true });
  if (domain) return domain;
  const parts = hostname.split(".").filter(Boolean);
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

/** True if both URLs share the same registrable domain (first-party). */
export function sameSite(a: string, b: string): boolean {
  const ha = host(a);
  const hb = host(b);
  return ha !== "" && hb !== "" && registrableDomain(ha) === registrableDomain(hb);
}

/**
 * True if `reqUrl` belongs to the page's own domain ("main domain" / first-party).
 * A relative or unparseable URL has no host of its own, so it resolves against the
 * page origin and is therefore treated as first-party.
 */
export function isFirstParty(reqUrl: string, pageUrl: string): boolean {
  return host(reqUrl) === "" || sameSite(reqUrl, pageUrl);
}

/** True if `reqUrl` is on a different registrable domain than `pageUrl` (third-party). */
export function isThirdParty(reqUrl: string, pageUrl: string): boolean {
  const rd = registrableDomain(host(reqUrl));
  const pd = registrableDomain(host(pageUrl));
  return rd !== "" && pd !== "" && rd !== pd;
}

/** Case-insensitive header lookup (header maps are already lowercased, but be safe). */
export function header(map: HeaderMap, name: string): string | undefined {
  if (!map) return undefined;
  return map[name.toLowerCase()];
}

/** Response headers that can carry an OBSERVED edge-cache verdict. */
const EDGE_HIT_HEADERS = [
  "cf-cache-status",
  "x-cache",
  "x-vercel-cache",
  "akamai-cache-status",
  "x-cache-status",
  "x-cache-remote",
];

/**
 * Header-based observed edge hit, shared by ttfb.cdncache and cdn.ts:isCdnHit so a
 * hit signature added once lands in both. Returns `"name: value"` of the first hit
 * header — one of EDGE_HIT_HEADERS containing "hit" as a word, or a server-timing
 * `cdn-cache; desc=HIT` entry (Akamai's usual signal) — or null when no hit is
 * observed. The `age` policy deliberately stays with each caller: thresholds differ
 * by criterion (ttfb.cdncache accepts age > 0 as edge evidence, cdn.longttl wants
 * age ≥ 3600 to back its countdown-TTL heuristic).
 */
export function edgeHitHeader(map: HeaderMap): string | null {
  for (const name of EDGE_HIT_HEADERS) {
    const v = header(map, name);
    if (v !== undefined && /\bhit\b/i.test(v)) return `${name}: ${v}`;
  }
  const st = header(map, "server-timing") ?? "";
  if (/cdn-cache[^,]*desc\s*=\s*"?hit/i.test(st)) return `server-timing: ${st}`;
  return null;
}

/**
 * `max-age` (and ONLY `max-age`) from a Cache-Control header value, in seconds.
 * Returns null when the directive is absent. **Browser-cache semantics**: a private
 * cache reads `max-age` and ignores `s-maxage`, so this is the helper for anything
 * reasoning about what the browser (or a plain freshness lifetime) will do.
 * For shared/CDN caches use `cacheControlSharedTtl` instead.
 */
export function cacheControlMaxAge(value: string): number | null {
  const m = /\bmax-age\s*=\s*(\d+)/i.exec(value);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Freshness lifetime a **shared (CDN/proxy) cache** will apply, in seconds:
 * `s-maxage` when present (it overrides `max-age` for shared caches), else `max-age`.
 * Returns null when neither directive is present.
 * For browser-cache reasoning use `cacheControlMaxAge` instead.
 */
export function cacheControlSharedTtl(value: string): number | null {
  const smax = /\bs-maxage\s*=\s*(\d+)/i.exec(value);
  if (smax) return parseInt(smax[1]!, 10);
  return cacheControlMaxAge(value);
}

export interface ParsedTag {
  /** Attribute map, names lowercased; valueless attrs map to "". */
  attrs: Record<string, string>;
  /** The raw matched opening tag. */
  raw: string;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[3] ?? m[4] ?? m[5] ?? "";
    attrs[name] = val;
  }
  return attrs;
}

/**
 * Extract all opening tags of a given name from HTML with their attributes.
 * e.g. parseTags(html, "script") → [{ attrs: { src, defer, async, type }, raw }]
 * Regex-based (no DOM) — good enough for attribute presence checks on raw HTML.
 */
export function parseTags(html: string, tag: string): ParsedTag[] {
  const out: ParsedTag[] = [];
  if (!html) return out;
  const re = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ attrs: parseAttrs(m[1]), raw: m[0] });
  }
  return out;
}

/** True if a script tag's attrs mark it non-parser-blocking (defer, async, or type="module"). */
export function isNonBlockingScript(attrs: Record<string, string>): boolean {
  return (
    "defer" in attrs ||
    "async" in attrs ||
    (attrs["type"] ?? "").toLowerCase() === "module"
  );
}

/** The raw <head>…</head> inner HTML, or "" if not found. */
export function headSlice(html: string): string {
  const m = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  return m ? m[1] : "";
}

/** The raw <body>…</body> inner HTML, or the full html if no body tag. */
export function bodySlice(html: string): string {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return m ? m[1] : html;
}

/** Strip scripts/styles/tags and collapse whitespace → visible text. */
export function visibleText(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Visible-text word count. */
export function wordCount(html: string): number {
  const t = visibleText(html);
  return t ? t.split(" ").length : 0;
}

/** Requests filtered by one or more resourceType values. */
export function requestsOfType(
  requests: NetworkRequest[],
  ...types: string[]
): NetworkRequest[] {
  const set = new Set(types);
  return requests.filter((r) => set.has(r.resourceType));
}
