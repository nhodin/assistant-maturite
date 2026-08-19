/**
 * Seed the LVMH maisons from data/maisons.csv (Division;Maison;Locale principale)
 * as sites with a single HP page, and add every HP page to a project.
 *
 * Idempotent: an existing site (matched by name or by an alias below) is reused,
 * an existing HP page with the same URL is reused, and the project link is upserted.
 *
 * Run: npx tsx src/web/seed-maisons.ts [projectId=8] [--dry]
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { prisma } from "./db";

type Cat = "Beauty" | "Fragrances" | "WatchesJewelry" | "WineSpirits" | "SR" | "Other";

/** LVMH division (CSV) → Category enum. FG has no dedicated enum value. */
const CATEGORY_BY_DIVISION: Record<string, Cat> = {
  Beauty: "Beauty",
  FG: "Other",
  WJ: "WatchesJewelry",
  WS: "WineSpirits",
  SR: "SR",
  Other: "Other",
};

/**
 * Maisons already in the inventory under a different name. The existing site is
 * reused (and renamed to the CSV label) instead of creating a duplicate.
 */
const EXISTING_SITE_BY_MAISON: Record<string, string> = {
  "MAKE UP FOR EVER": "MAKEUPFOREVER",
  "GIVENCHY (BEAUTY)": "Givechy Beauty",
  "KENZO PARFUM": "Kenzo",
  "GIVENCHY (COUTURE)": "Givenchy",
  "LOUIS VUITTON": "Louis Vuitton",
  FENDI: "Fendi",
  LOEWE: "Loewe",
  TIFFANY: "Tiffany",
  BULY1803: "BULY1803",
};

function normalizeUrl(u: string): string {
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const projectId = Number(args.find((a) => /^\d+$/.test(a)) ?? 8);

  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { client: true } });
  if (!project) throw new Error(`Project ${projectId} not found`);
  const clientId = project.clientId;
  console.log(`Project ${project.id} — ${project.name} (client: ${project.client?.name ?? "none"})${dry ? " [DRY RUN]" : ""}\n`);

  const rows = parse(fs.readFileSync(path.resolve("data", "maisons.csv"), "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  let sitesCreated = 0, sitesReused = 0, pagesCreated = 0, pagesReused = 0, linked = 0, alreadyLinked = 0;

  for (const r of rows) {
    const maison = (r["Maison"] ?? "").trim();
    const division = (r["Division"] ?? "").trim();
    const url = normalizeUrl(r["Locale principale"] ?? "");
    if (!maison || !url) continue;

    const category = CATEGORY_BY_DIVISION[division] ?? "Other";
    const lookupName = EXISTING_SITE_BY_MAISON[maison] ?? maison;
    // MySQL string comparison is case-insensitive, so match exactly in JS: "KENZO"
    // (kenzo.com) must not collide with "Kenzo" (kenzoparfums.com), nor "TAG HEUER"
    // (LVMH) with the "Tag Heuer" site owned by another client.
    let site =
      (await prisma.site.findMany({ where: { name: lookupName } })).find((s) => s.name === lookupName) ?? null;

    if (site) {
      sitesReused++;
      console.log(`site   reuse   #${site.id} ${site.name}${site.name !== maison ? ` → renamed "${maison}"` : ""}`);
      if (!dry && site.name !== maison) {
        site = await prisma.site.update({ where: { id: site.id }, data: { name: maison } });
      }
    } else {
      sitesCreated++;
      console.log(`site   create  ${maison} (${category})`);
      if (!dry) {
        site = await prisma.site.create({ data: { name: maison, category, clientId, homepage: url } });
      }
    }
    if (dry && !site) continue;

    let page = await prisma.page.findFirst({ where: { siteId: site!.id, url } });
    if (page) {
      pagesReused++;
      console.log(`  page reuse   #${page.id} ${page.kind} ${page.url}`);
    } else {
      pagesCreated++;
      console.log(`  page create  HP ${url}`);
      if (!dry) page = await prisma.page.create({ data: { siteId: site!.id, kind: "HP", url } });
    }
    if (dry && !page) continue;

    const link = await prisma.projectPage.findUnique({
      where: { projectId_pageId: { projectId, pageId: page!.id } },
    });
    if (link) {
      alreadyLinked++;
      console.log(`  link already in project`);
    } else {
      linked++;
      console.log(`  link add to project ${projectId}`);
      if (!dry) await prisma.projectPage.create({ data: { projectId, pageId: page!.id } });
    }
  }

  console.log(
    `\nSites: ${sitesCreated} created, ${sitesReused} reused.\n` +
      `Pages: ${pagesCreated} created, ${pagesReused} reused.\n` +
      `Project links: ${linked} added, ${alreadyLinked} already present.`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
