/**
 * Purge all runs and their scores/evidence, keeping sites, clients and projects.
 * Deleting Run rows cascades to RunPage + RunSiteScore (onDelete: Cascade).
 * Run: npm run db:purge-runs
 */
import "dotenv/config";
import { prisma } from "./db";

async function main() {
  const before = {
    runs: await prisma.run.count(),
    runPages: await prisma.runPage.count(),
    runSiteScores: await prisma.runSiteScore.count(),
  };

  const { count } = await prisma.run.deleteMany({});

  console.log(`Deleted ${count} run(s).`);
  console.log(
    `Cascaded: ${before.runPages} run page(s) + ${before.runSiteScores} site score(s) removed.`,
  );
  console.log(
    `Kept: ${await prisma.client.count()} client(s), ${await prisma.site.count()} site(s), ${await prisma.project.count()} project(s).`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
