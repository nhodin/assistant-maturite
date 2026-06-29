/**
 * Seed the inventory from data/WEBSITES.csv (HP/PLP/PDP per site) with categories.
 * Idempotent: skips sites that already exist by name. Run: npm run db:seed-inventory
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { prisma } from "./db";

type Cat = "Beauty" | "Fragrances" | "WatchesJewelry" | "WineSpirits" | "SR" | "Other";

// Best-effort category mapping for the seed sites.
const CATEGORY_BY_NAME: Record<string, Cat> = {
  BULY1803: "Beauty",
  MAKEUPFOREVER: "Beauty",
  "Givechy Beauty": "Beauty",
  Kenzo: "Fragrances",
};

async function main() {
  const csvPath = path.resolve("data", "WEBSITES.csv");
  const content = fs.readFileSync(csvPath, "utf-8");
  const rows = parse(content, {
    delimiter: ";",
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  let created = 0;
  for (const r of rows) {
    const name = r["website"];
    if (!name) continue;
    const existing = await prisma.site.findFirst({ where: { name } });
    if (existing) {
      console.log(`skip (exists): ${name}`);
      continue;
    }
    const pages = [
      { kind: "HP" as const, url: r["url_hp"] },
      { kind: "PLP" as const, url: r["url_plp"] },
      { kind: "PDP" as const, url: r["url_pdp"] },
    ].filter((p) => p.url);

    await prisma.site.create({
      data: {
        name,
        category: CATEGORY_BY_NAME[name] ?? "Other",
        homepage: r["url_hp"] ?? null,
        pages: { create: pages.map((p) => ({ kind: p.kind, url: p.url })) },
      },
    });
    created++;
    console.log(`created: ${name} (${pages.length} pages)`);
  }
  console.log(`\nDone. ${created} site(s) created.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
