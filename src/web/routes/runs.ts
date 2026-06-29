import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { activeRun } from "../runner";

export async function runRoutes(app: FastifyInstance) {
  app.get("/runs", async (_req, reply) => {
    const runs = await prisma.run.findMany({
      orderBy: { createdAt: "desc" },
      include: { project: true, _count: { select: { runSiteScores: true } } },
    });
    return reply.view("run-list", { active: "runs", title: "Runs", runs, activeRunId: activeRun() });
  });

  app.get("/runs/:id", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({
      where: { id },
      include: {
        project: true,
        runSiteScores: { include: { site: true } },
        runPages: { include: { page: { include: { site: true } } } },
      },
    });
    if (!run) return reply.code(404).send("Run not found");

    const ranking = [...run.runSiteScores].sort(
      (a, b) => (b.overall ?? -1) - (a.overall ?? -1),
    );
    const byCategory: Record<string, any[]> = {};
    for (const s of ranking) (byCategory[s.category] ??= []).push(s);

    return reply.view("run-detail", {
      active: "runs",
      title: `Run #${run.id}`,
      run,
      ranking,
      byCategory,
    });
  });

  // HTMX poll partial: progress while running; once terminal, refresh whole page.
  app.get("/runs/:id/status", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({ where: { id } });
    if (!run) return reply.code(404).send("");
    if (run.status === "DONE" || run.status === "FAILED") {
      reply.header("HX-Refresh", "true");
      return reply.send("");
    }
    return reply.view("partials/run-progress", { run });
  });

  app.get("/runs/:id/sites/:siteId", async (req, reply) => {
    const id = Number((req.params as any).id);
    const siteId = Number((req.params as any).siteId);
    const score = await prisma.runSiteScore.findUnique({
      where: { runId_siteId: { runId: id, siteId } },
      include: { site: true, run: true },
    });
    if (!score) return reply.code(404).send("No score for this site/run");
    return reply.view("run-site-detail", {
      active: "runs",
      title: `${score.site.name} — Run #${id}`,
      score,
      topics: score.topicsJson as any[],
    });
  });

  app.post("/runs/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    await prisma.run.delete({ where: { id } }).catch(() => {});
    return reply.redirect("/runs");
  });
}
