/**
 * One page per site carries the SITE-level facts of a diagnostic — Audience
 * (CrUX popularity of the origin) and the web application / CDN-WAF lines of
 * the Techno column. Repeating them on every page of the site said nothing new,
 * and recomputing them per page cost fetches for the same answer.
 *
 * The representative is the home: a page of kind HP, else a page whose path is
 * "/", else the first eligible page in the given order. Pure — shared by the
 * diag table (display) and runner.enrichRun* (recompute).
 */
export interface RepresentativeCandidate {
  id: number;
  siteId: number;
  url: string;
  kind?: string | null;
}

function isRootPath(url: string): boolean {
  try {
    return new URL(url).pathname === "/";
  } catch {
    return false;
  }
}

/**
 * Representative page id per site. `pages` must be the ELIGIBLE pages only
 * (the caller decides: DONE with a diagnostic), in display order.
 */
export function representativePages(pages: RepresentativeCandidate[]): Map<number, number> {
  const bySite = new Map<number, RepresentativeCandidate[]>();
  for (const p of pages) {
    const list = bySite.get(p.siteId) ?? [];
    list.push(p);
    bySite.set(p.siteId, list);
  }
  const out = new Map<number, number>();
  for (const [siteId, list] of bySite) {
    const pick = list.find((p) => p.kind === "HP") ?? list.find((p) => isRootPath(p.url)) ?? list[0]!;
    out.set(siteId, pick.id);
  }
  return out;
}
