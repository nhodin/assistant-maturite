/**
 * Prospect diagnostic — parsing of a pasted URL list into sites + pages.
 * PURE (no I/O, no Prisma): see ../../../docs/DIAGNOSTIC.md, "Création d'un projet".
 *
 * One URL per line. Blank lines are ignored, duplicates are merged under their
 * CANONICAL form (see canonicalUrlKey), malformed or non-http(s) lines are
 * REJECTED and returned (not silently dropped) so the creation form can list
 * them before anything is persisted. Query strings are kept verbatim — `?l=11`,
 * `?dwvar_size=M` are part of the page, normalising them would break the capture.
 */
import { registrableDomain } from "../topics/util";

/** A pasted line that could not be used, with a short French reason. */
export interface UrlPasteReject {
  line: string;
  reason: string;
}

/** A pasted URL merged into an earlier one that has the same canonical form. */
export interface UrlPasteDuplicate {
  line: string;
  /** The URL kept in its place, as it was first written. */
  duplicateOf: string;
}

/** One grouped site: its registrable domain (also the site name) and the
 *  distinct page URLs that belong to it, in first-seen order. */
export interface UrlPasteSite {
  site: string;
  pages: string[];
}

export interface UrlPasteResult {
  sites: UrlPasteSite[];
  rejected: UrlPasteReject[];
  duplicates: UrlPasteDuplicate[];
  counts: {
    /** Distinct valid URLs kept across all sites (homepages included, if added). */
    urls: number;
    sites: number;
    rejected: number;
    duplicates: number;
  };
}

export interface ParseUrlPasteOptions {
  /**
   * Also add `https://<host>/` for every distinct host seen in a site's pages,
   * unless that host's home is already in the paste, however it was written
   * (`http://`, no trailing slash, upper-case host…). A home page and a PDP don't
   * necessarily share the same rendering mode, so this is opt-in — default OFF.
   */
  includeHomepages?: boolean;
}

/** Parses one line as an absolute http(s) URL, or returns null. */
function parseHttpUrl(line: string): URL | null {
  let u: URL;
  try {
    u = new URL(line);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u;
}

/**
 * The form two URLs are compared under to decide they are the same page: host
 * lower-cased (with its port, if any), path without its trailing slash, query
 * string and fragment verbatim, scheme ignored. `http://WWW.Shop.fr/fr/` and
 * `https://www.shop.fr/fr` share a key; `/fr?l=11` and `/fr?l=12` do not. Used
 * both inside a paste and against the pages already stored, so the same page
 * never gets two rows because it was written two ways. A string that is not an
 * http(s) URL is its own key (trimmed).
 */
export function canonicalUrlKey(url: string): string {
  const trimmed = (url || "").trim();
  const u = parseHttpUrl(trimmed);
  if (!u) return trimmed;
  return `${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}${u.hash}`;
}

/**
 * The first of `candidates` (in their order) whose URL has the same canonical
 * form as `url`, or undefined. Stored pages are passed oldest first, so an
 * inventory already holding two spellings of a page resolves to the older row.
 */
export function findCanonicalMatch<T extends { url: string }>(
  candidates: readonly T[],
  url: string,
): T | undefined {
  const key = canonicalUrlKey(url);
  return candidates.find((c) => canonicalUrlKey(c.url) === key);
}

/**
 * Parse a pasted blob of URLs (one per line) into sites grouped by registrable
 * domain (`fr.shop-orchestra.com` → `shop-orchestra.com`, `travisperkins.co.uk`
 * stays whole — Public Suffix List via `registrableDomain`).
 */
export function parseUrlPaste(
  input: string,
  options: ParseUrlPasteOptions = {},
): UrlPasteResult {
  const lines = (input || "").split(/\r?\n/);
  // canonical key -> the URL kept for it, across the whole paste. Rejected lines
  // are deduplicated on their own: "www.shop.fr" (rejected, no scheme) must not
  // be swallowed by the key of a valid https://www.shop.fr/.
  const kept = new Map<string, string>();
  const seenRejects = new Set<string>();
  const rejected: UrlPasteReject[] = [];
  const duplicates: UrlPasteDuplicate[] = [];
  // registrable domain -> pages (insertion order) + distinct hosts seen for it
  const groups = new Map<string, { pages: string[]; hosts: Set<string> }>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue; // blank line — ignored

    const url = parseHttpUrl(line);
    if (!url) {
      if (seenRejects.has(line)) continue;
      seenRejects.add(line);
      rejected.push({ line, reason: "URL invalide ou non http(s)" });
      continue;
    }
    const key = canonicalUrlKey(line);
    const first = kept.get(key);
    if (first !== undefined) {
      // The same page again, possibly written another way — merged into the first.
      // A strictly identical line is not worth reporting.
      if (first !== line) duplicates.push({ line, duplicateOf: first });
      continue;
    }
    kept.set(key, line);

    const host = url.hostname.toLowerCase();
    const domain = registrableDomain(host);
    let group = groups.get(domain);
    if (!group) {
      group = { pages: [], hosts: new Set() };
      groups.set(domain, group);
    }
    group.pages.push(line); // the ORIGINAL string — query strings untouched
    group.hosts.add(host);
  }

  if (options.includeHomepages) {
    for (const group of groups.values()) {
      for (const host of group.hosts) {
        const home = `https://${host}/`;
        const key = canonicalUrlKey(home);
        if (kept.has(key)) continue; // the host already has its home, in some spelling
        kept.set(key, home);
        group.pages.push(home);
      }
    }
  }

  const sites: UrlPasteSite[] = [...groups.entries()].map(([site, g]) => ({
    site,
    pages: [...g.pages],
  }));

  const urls = sites.reduce((n, s) => n + s.pages.length, 0);
  return {
    sites,
    rejected,
    duplicates,
    counts: {
      urls,
      sites: sites.length,
      rejected: rejected.length,
      duplicates: duplicates.length,
    },
  };
}
