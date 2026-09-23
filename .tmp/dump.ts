import { prisma } from "../src/web/db";
const rps = await prisma.runPage.findMany({ where: { runId: 34, page: { siteId: 8 } }, include: { page: { include: { site: true } } } });
for (const rp of rps) console.log(rp.id, rp.page.kind, rp.page.label, rp.url, rp.status, rp.mode, rp.overall, rp.geo);
const hp = rps.find(r => r.page.kind === "HP") ?? rps[0];
const s = await prisma.runSiteScore.findUnique({ where: { runId_siteId: { runId: 34, siteId: 8 } } });
console.log("SITE", hp.page.site.name, hp.page.site.category, "overall", s?.overall, "geo", s?.geo);
for (const t of (hp.topicsJson as any[])) {
  console.log(`\n## ${t.name ?? t.title ?? t.id} -> ${t.score}`);
  for (const c of (t.criteria ?? t.controls ?? [])) console.log(`  [${c.passed ?? c.status ?? c.verdict}] ${c.points ?? ""}/${c.maxPoints ?? c.max ?? ""} ${c.label ?? c.id} :: ${String(c.comment ?? c.evidence ?? "").slice(0,300)}`);
}
console.log(Object.keys((hp.topicsJson as any[])[0]), Object.keys(((hp.topicsJson as any[])[0].criteria ?? [])[0] ?? {}));
await prisma.$disconnect();
