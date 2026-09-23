/**
 * Prospect diagnostic — parsing of a pasted URL list into sites + pages.
 * PURE (no I/O, no Prisma): see ../../../docs/DIAGNOSTIC.md, "Création d'un projet".
 *
 * One URL per line. Blank lines are ignored, exact duplicate lines are merged,
 * malformed or non-http(s) lines are REJECTED and returned (not silently
 * dropped) so the creation form can list them before anything is persisted.
 * Query strings are kept verbatim — `?l=11`, `?dwvar_size=M` are part of the
 * page, normalising them would break the capture.
 */
import { registrableDomain } from "../topics/util";

/** A pasted line that could not be used, with a short French reason. */
export interface UrlPasteReject {
  line: string;
  reason: string;
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
  counts: {
    /** Distinct valid URLs kept across all sites (homepages included, if added). */
    urls: number;
    sites: number;
    rejected: number;
  };
}

export interface ParseUrlPasteOptions {
  /**
   * Also add `https://<host>/` for every distinct host seen in a site's pages.
   * A home page and a PDP don't necessarily share the same rendering mode, so
   * this is opt-in — default OFF.
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
 * Parse a pasted blob of URLs (one per line) into sites grouped by registrable
 * domain (`fr.shop-orchestra.com` → `shop-orchestra.com`, `travisperkins.co.uk`
 * stays whole — Public Suffix List via `registrableDomain`).
 */
export function parseUrlPaste(
  input: string,
  options: ParseUrlPasteOptions = {},
): UrlPasteResult {
  const lines = (input || "").split(/\r?\n/);
  const seenLines = new Set<string>(); // exact-duplicate merge, across the whole paste
  const rejected: UrlPasteReject[] = [];
  // registrable domain -> pages (insertion order) + distinct hosts seen for it
  const groups = new Map<string, { pages: Set<string>; hosts: Set<string> }>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue; // blank line — ignored
    if (seenLines.has(line)) continue; // exact duplicate — merged
    seenLines.add(line);

    const url = parseHttpUrl(line);
    if (!url) {
      rejected.push({ line, reason: "URL invalide ou non http(s)" });
      continue;
    }
    const host = url.hostname.toLowerCase();
    const domain = registrableDomain(host);
    let group = groups.get(domain);
    if (!group) {
      group = { pages: new Set(), hosts: new Set() };
      groups.set(domain, group);
    }
    group.pages.add(line); // the ORIGINAL string — query strings untouched
    group.hosts.add(host);
  }

  if (options.includeHomepages) {
    for (const group of groups.values()) {
      for (const host of group.hosts) group.pages.add(`https://${host}/`);
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
    counts: { urls, sites: sites.length, rejected: rejected.length },
  };
}
