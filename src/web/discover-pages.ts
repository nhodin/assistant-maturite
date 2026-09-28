/**
 * Discover a PLP and a PDP candidate for every site of a project, from its homepage —
 * the CLI face of ../discovery (same engine as the diagnostic project's « Pages à
 * valider » block; spec in docs/DIAGNOSTIC.md, « Découverte des PDP / PLP »).
 *
 * Output is a REVIEW CSV (`domaine;url_plp;url_pdp;plp_conf;pdp_conf;note`) meant to
 * be checked by a human and then fed to `db:seed-domains --plp-column/--pdp-column`.
 * Nothing is written to the database here. A site where nothing was found leaves the
 * cell empty with the reason in `note` — an empty cell is the honest answer, a guessed
 * URL would silently be audited as a PDP.
 *
 * Run: npm run discover:pages -- --project "Tests prods" [--client Fasterize]
 *        [--out data/discovered-plp-pdp.csv] [--delay 400] [--no-browser]
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "./db";
import { discoverSite, discoveryStartUrl, type DiscoveryOutcome } from "../discovery";
import { httpFetcher } from "../discovery/http";
import { createBrowserFetcher, type ClosableFetcher } from "../discovery/browser";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`missing --${name}`);
    return fallback;
  }
  return v;
}

function csvCell(v: string): string {
  return v.includes(";") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
}

const urlOf = (o: DiscoveryOutcome | undefined) => (o?.found ? o.url : "");
const confOf = (o: DiscoveryOutcome | undefined) => (o?.found ? o.confidence : "");

async function main() {
  const projectName = arg("project");
  const clientName = process.argv.includes("--client") ? arg("client") : undefined;
  const outPath = path.resolve(arg("out", "data/discovered-plp-pdp.csv"));
  const delay = Number(arg("delay", "400"));
  const useBrowser = !process.argv.includes("--no-browser");

  const project = await prisma.project.findFirst({
    where: { name: projectName, ...(clientName ? { client: { name: clientName } } : {}) },
    include: { pages: { include: { page: { include: { site: true } } } } },
  });
  if (!project) throw new Error(`project not found: ${projectName}`);

  // One entry per site: its HP when there is one, else a home-like URL, else its root.
  const sites = new Map<number, { name: string; urls: string[]; hp?: string }>();
  for (const pp of project.pages) {
    const s = pp.page.site;
    const entry = sites.get(s.id) ?? { name: s.name, urls: s.homepage ? [s.homepage] : [] };
    entry.urls.push(pp.page.url);
    if (pp.page.kind === "HP") entry.hp ??= pp.page.url;
    sites.set(s.id, entry);
  }

  const rows: string[] = ["domaine;url_plp;url_pdp;plp_conf;pdp_conf;note"];
  let found = 0;
  let i = 0;
  for (const [, s] of sites) {
    i++;
    const start = s.hp ?? discoveryStartUrl(s.urls);
    if (!start) continue;
    const browsers: ClosableFetcher[] = [];
    try {
      const r = await discoverSite(start, {
        want: { pdp: true, plp: true },
        http: httpFetcher,
        browser: useBrowser
          ? () => {
              const b = createBrowserFetcher();
              browsers.push(b);
              return b;
            }
          : undefined,
        delayMs: delay,
      });
      const notes = [r.plp, r.pdp]
        .map((o, k) => (o ? `${k ? "PDP" : "PLP"}: ${o.note}` : ""))
        .filter(Boolean)
        .join(" | ");
      if (urlOf(r.plp) || urlOf(r.pdp)) found++;
      rows.push([s.name, urlOf(r.plp), urlOf(r.pdp), confOf(r.plp), confOf(r.pdp), notes].map(csvCell).join(";"));
      console.log(
        `[${i}/${sites.size}] ${s.name} → PLP ${urlOf(r.plp) || "-"} (${confOf(r.plp) || "∅"}) | ` +
          `PDP ${urlOf(r.pdp) || "-"} (${confOf(r.pdp) || "∅"})`,
      );
    } finally {
      for (const b of browsers) await b.close();
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rows.join("\n") + "\n", "utf-8");
  console.log(
    `\nDone. ${found}/${sites.size} site(s) avec au moins un candidat → ${outPath}\n` +
      `Relis le CSV (colonnes *_conf : confirmed = page ouverte et vérifiée, probable = à regarder), puis importe-le :\n` +
      `  npm run db:seed-domains -- --client <client> --project "${projectName}" \\\n` +
      `    --csv ${outPath} --delimiter ";" --plp-column url_plp --pdp-column url_pdp`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
