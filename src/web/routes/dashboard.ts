import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { parseClientId, listClients } from "../clients";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/", async (req, reply) => {
    const clientId = parseClientId((req.query as any)?.client);
    const runClientWhere = clientId !== null ? { project: { clientId } } : {};

    const latestRun = await prisma.run.findFirst({
      where: { status: "DONE", ...runClientWhere },
      orderBy: { createdAt: "desc" },
      include: { project: { include: { client: true } }, runSiteScores: { include: { site: true } } },
    });

    const recentRuns = await prisma.run.findMany({
      where: runClientWhere,
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { project: { include: { client: true } } },
    });

    const clients = await listClients();
    const counts = {
      sites: await prisma.site.count({ where: clientId !== null ? { clientId } : undefined }),
      pages: await prisma.page.count({ where: clientId !== null ? { site: { clientId } } : undefined }),
      projects: await prisma.project.count({ where: clientId !== null ? { clientId } : undefined }),
      runs: await prisma.run.count({ where: clientId !== null ? { project: { clientId } } : undefined }),
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
      clients,
      selectedClientId: clientId,
    });
  });
}
