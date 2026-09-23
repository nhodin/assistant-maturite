/**
 * Seed a client's inventory + project from a CSV of domains (one HP page per domain,
 * plus an optional PLP and PDP when the CSV carries their URLs).
 * Idempotent: re-running reuses the client, the project, the sites and their pages.
 *
 * Run: npm run db:seed-domains -- --client Fasterize --project "Tests prods" \
 *        --csv data/sites-prod-fasterize.csv [--column domaine] [--delimiter ,]
 *        [--plp-column url_plp] [--pdp-column url_pdp] [--no-hp]
 *
 * `--plp-column`/`--pdp-column` name the CSV columns holding those URLs; an empty cell is
 * skipped (a site with no known PLP simply keeps its HP). `--no-hp` imports only the
 * PLP/PDP columns, for a second pass over sites whose HP is already in the project.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { prisma } from "./db";

type Kind = "HP" | "PLP" | "PDP";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`missing --${name}`);
    return fallback;
  }
  return v;
}

function optional(name: string): string | undefined {
  return process.argv.includes(`--${name}`) ? arg(name) : undefined;
}

async function main() {
  const clientName = arg("client");
  const projectName = arg("project");
  const csvPath = path.resolve(arg("csv"));
  const column = arg("column", "domaine");
  const delimiter = arg("delimiter", ",");
  const plpColumn = optional("plp-column");
  const pdpColumn = optional("pdp-column");
  const withHp = !process.argv.includes("--no-hp");

  const rows = parse(fs.readFileSync(csvPath, "utf-8"), {
    delimiter,
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  // One entry per domain, de-duplicated while keeping the CSV order.
  const byDomain = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const d = r[column];
    if (d && !byDomain.has(d)) byDomain.set(d, r);
  }
  if (!byDomain.size) throw new Error(`no value in column "${column}" of ${csvPath}`);

  const client = await prisma.client.upsert({
    where: { name: clientName },
    update: {},
    create: { name: clientName },
  });

  let project = await prisma.project.findFirst({
    where: { name: projectName, clientId: client.id },
  });
  if (project) {
    console.log(`project (exists): ${projectName} #${project.id}`);
  } else {
    project = await prisma.project.create({
      data: { name: projectName, clientId: client.id },
    });
    console.log(`project created: ${projectName} #${project.id}`);
  }

  let createdSites = 0;
  let createdPages = 0;
  let linked = 0;
  let skipped = 0;
  for (const [domain, row] of byDomain) {
    const homepage = `https://${domain}/`;
    let site = await prisma.site.findFirst({ where: { name: domain, clientId: client.id } });
    if (!site) {
      site = await prisma.site.create({
        data: { name: domain, category: "Other", clientId: client.id, homepage },
      });
      createdSites++;
    }

    const wanted: Array<{ kind: Kind; url: string }> = [];
    if (withHp) wanted.push({ kind: "HP", url: homepage });
    if (plpColumn && row[plpColumn]) wanted.push({ kind: "PLP", url: row[plpColumn] });
    if (pdpColumn && row[pdpColumn]) wanted.push({ kind: "PDP", url: row[pdpColumn] });
    if (plpColumn && !row[plpColumn]) skipped++;
    if (pdpColumn && !row[pdpColumn]) skipped++;

    for (const w of wanted) {
      // One page per (site, kind): a second pass updates the URL rather than piling up
      // near-duplicate pages, whose scores would then be averaged into the same site.
      let page = await prisma.page.findFirst({ where: { siteId: site.id, kind: w.kind } });
      if (!page) {
        page = await prisma.page.create({
          data: { siteId: site.id, kind: w.kind, label: w.kind, url: w.url },
        });
        createdPages++;
      } else if (page.url !== w.url) {
        page = await prisma.page.update({ where: { id: page.id }, data: { url: w.url } });
        console.log(`url updated: ${domain} ${w.kind} → ${w.url}`);
      }

      const link = await prisma.projectPage.findUnique({
        where: { projectId_pageId: { projectId: project.id, pageId: page.id } },
      });
      if (!link) {
        await prisma.projectPage.create({ data: { projectId: project.id, pageId: page.id } });
        linked++;
      }
    }
  }

  console.log(
    `\nDone. ${byDomain.size} domain(s): ${createdSites} site(s), ${createdPages} page(s) created, ` +
      `${linked} page(s) added to the project` +
      (skipped ? `, ${skipped} empty PLP/PDP cell(s) skipped.` : "."),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
