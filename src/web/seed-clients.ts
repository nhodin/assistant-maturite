/**
 * Seed the initial clients (LVMH, Conforama, Groupama) and backfill existing
 * sites/projects that have no client yet onto LVMH (the original LVMH-only dataset).
 * Idempotent. Run: npm run db:seed-clients
 */
import "dotenv/config";
import { prisma } from "./db";

const CLIENTS = ["LVMH", "Conforama", "Groupama"];
const DEFAULT_CLIENT = "LVMH"; // existing rows predate the multi-client model.

async function main() {
  for (const name of CLIENTS) {
    const existing = await prisma.client.findUnique({ where: { name } });
    if (existing) {
      console.log(`skip (exists): ${name}`);
    } else {
      await prisma.client.create({ data: { name } });
      console.log(`created client: ${name}`);
    }
  }

  const lvmh = await prisma.client.findUnique({ where: { name: DEFAULT_CLIENT } });
  if (lvmh) {
    const sites = await prisma.site.updateMany({
      where: { clientId: null },
      data: { clientId: lvmh.id },
    });
    const projects = await prisma.project.updateMany({
      where: { clientId: null },
      data: { clientId: lvmh.id },
    });
    console.log(
      `backfill → ${DEFAULT_CLIENT}: ${sites.count} site(s), ${projects.count} project(s)`,
    );
  }

  console.log("\nDone.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
