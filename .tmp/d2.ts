import { prisma } from "../src/web/db";
const r = await prisma.run.findUnique({ where: { id: 34 } });
console.log(r?.createdAt, r?.finishedAt, r?.device);
const rp = await prisma.runPage.findUnique({ where: { id: 251 } });
const t = (rp!.topicsJson as any[]); console.log(JSON.stringify(t[0].controls[0]).slice(0,400));
const e = rp!.evidenceJson as any; console.log(Object.keys(e));
console.log(JSON.stringify(e.lcp ?? e.metrics ?? e.perf ?? {}).slice(0,800));
await prisma.$disconnect();
