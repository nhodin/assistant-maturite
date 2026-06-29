import type { FastifyInstance } from "fastify";
import { prisma } from "../db";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/", async (_req, reply) => {
    const latestRun = await prisma.run.findFirst({
      where: { status: "DONE" },
      orderBy: { createdAt: "desc" },
      include: { project: true, runSiteScores: { include: { site: true } } },
    });

    const recentRuns = await prisma.run.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { project: true },
    });

    const counts = {
      sites: await prisma.site.count(),
      pages: await prisma.page.count(),
      projects: await prisma.project.count(),
      runs: await prisma.run.count(),
    };

    let ranking: any[] = [];
    const byCategory: Record<string, any[]> = {};
    if (latestRun) {
      ranking = [...latestRun.runSiteScores].sort(
        (a, b) => (b.overall ?? -1) - (a.overall ?? -1),
      );
      for (const s of ranking) {
        (byCategory[s.category] ??= []).push(s);
      }
    }

    return reply.view("dashboard", {
      active: "dashboard",
      title: "Dashboard",
      latestRun,
      ranking,
      byCategory,
      recentRuns,
      counts,
    });
  });
}
