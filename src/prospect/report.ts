/**
 * Prospect diagnostic — CSV export. Spec: ../../../docs/DIAGNOSTIC.md.
 *
 * ONE ROW PER PAGE, never one per site: the verdict is rendered at page
 * granularity and a site whose pages disagree is a finding in itself, so
 * collapsing them here would throw away the thing the diagnostic is for. The
 * `Divergent` column carries that fact alongside each row.
 *
 * Pure: takes rows in, returns a string. No I/O, no DB.
 */
import type { PageDiagnostic } from "./types";
import { siteDiagnostic } from "./verdict";
import { monthLabel } from "./audience";

/** One captured page of a diag run, as the export reads it. */
export interface DiagCsvPage {
  site: string;
  url: string;
  /** Capture status (DONE / FAILED / PENDING). */
  status: string;
  /** Null when the page was never captured. */
  diag: PageDiagnostic | null;
}

const HEADER = [
  "Site",
  "URL",
  "Statut capture",
  "EdgeSpeed",
  "EdgeSEO",
  "Divergent",
  "Dynamic rendering",
  "User - recouvrement",
  "User - mots",
  "User - titre/H1",
  "User - images",
  "Googlebot - recouvrement",
  "Googlebot - mots",
  "Googlebot - titre/H1",
  "Googlebot - images",
  "Navigation",
  "Stack",
  "App web",
  "CDN/WAF",
  "Rang CrUX FR",
  "Rang CrUX monde",
  "Part mobile",
  "Mois CrUX",
  "Points de vigilance",
  "Arbitrage",
  "Evidence user",
  "Evidence Googlebot",
];

/**
 * RFC 4180 quoting. The maturity export never needed it (its cells are scores),
 * but an evidence sentence carries semicolons, quotes and the odd newline — and
 * an unquoted one silently shifts every column after it.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[";\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

const yesNo = (v: boolean): string => (v ? "oui" : "non");

/** How a check was settled: measured, decided by hand, or still pending. */
function arbitrage(diag: PageDiagnostic): string {
  const checks = diag.checks ?? [];
  if (checks.some((c) => c.manual)) return "corrigé manuellement";
  if (checks.some((c) => c.unknown)) return "à confirmer";
  return "mesuré";
}

function metricCells(diag: PageDiagnostic, id: "ssr.user" | "ssr.bot"): string[] {
  const check = (diag.checks ?? []).find((c) => c.id === id);
  // A blocked side has NO measurement: say so rather than printing zeros, which
  // would read as "measured, and empty".
  if (!check || check.unknown) return ["bloqué", "", "", ""];
  const m = check.metrics;
  if (!m) return ["", "", "", ""];
  return [
    `${Math.round(m.overlapRatio * 100)}%`,
    String(m.rawWords),
    yesNo(!!m.anchor && m.anchorInBody !== false),
    String(m.imageCount),
  ];
}

/**
 * Rank as the raw bucket bound (5000 = top 5k) so a spreadsheet sorts it;
 * "hors classement" when the origin is out of that month's ranking, empty when
 * the rank was never queried.
 */
function audienceCells(diag: PageDiagnostic): string[] {
  const a = diag.audience;
  if (!a) return ["", "", "", ""];
  const rank = (r: number | null | undefined): string =>
    r === undefined ? "" : r === null ? "hors classement" : String(r);
  const month = a.monthCountry ?? a.monthGlobal;
  return [
    rank(a.rankCountry),
    rank(a.rankGlobal),
    a.mobileShare != null ? `${Math.round(a.mobileShare * 100)}%` : "",
    month ? monthLabel(month) : "",
  ];
}

function evidenceOf(diag: PageDiagnostic, id: "ssr.user" | "ssr.bot"): string {
  const check = (diag.checks ?? []).find((c) => c.id === id);
  if (!check) return "";
  // The presumption belongs with the evidence it qualifies — it is an
  // indication, so it is spelled out rather than promoted to its own verdict.
  return check.presumption ? `${check.evidence} — ${check.presumption}` : check.evidence;
}

/** Semicolon-delimited, like the maturity export, so both open the same way. */
export function renderDiagCsv(pages: DiagCsvPage[]): string {
  // Divergence is a site-level fact, computed once per site from its captured pages.
  const divergent = new Map<string, boolean>();
  const bySite = new Map<string, PageDiagnostic[]>();
  for (const p of pages) {
    if (!p.diag) continue;
    const list = bySite.get(p.site) ?? [];
    list.push(p.diag);
    bySite.set(p.site, list);
  }
  for (const [site, diags] of bySite) {
    divergent.set(site, siteDiagnostic(site, diags).divergent);
  }

  const rows: string[] = [HEADER.join(";")];

  const sorted = [...pages].sort(
    (a, b) => a.site.localeCompare(b.site) || a.url.localeCompare(b.url),
  );

  for (const p of sorted) {
    if (!p.diag) {
      // An uncaptured page still gets a row: its absence from the export would
      // read as "this page is fine", which is the opposite of what happened.
      rows.push(
        [p.site, p.url, p.status, ...Array(HEADER.length - 6).fill(""), "non capturée", "", ""]
          .map(cell)
          .join(";"),
      );
      continue;
    }
    const d = p.diag;
    rows.push(
      [
        p.site,
        p.url,
        p.status,
        d.speed,
        d.seo,
        yesNo(divergent.get(p.site) === true),
        d.dynamicRendering ? "oui" : "non",
        ...metricCells(d, "ssr.user"),
        ...metricCells(d, "ssr.bot"),
        d.navigation?.kind === "unknown" ? "?" : (d.navigation?.kind?.toUpperCase() ?? ""),
        (d.stack?.frameworks ?? []).join(" + "),
        (d.stack?.platforms ?? []).join(" + "),
        (d.stack?.edge ?? []).join(" + "),
        ...audienceCells(d),
        (d.flags ?? []).map((f) => f.label).join(" | "),
        arbitrage(d),
        evidenceOf(d, "ssr.user"),
        evidenceOf(d, "ssr.bot"),
      ]
        .map(cell)
        .join(";"),
    );
  }

  return rows.join("\n");
}
