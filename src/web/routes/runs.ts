import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { activeRun, resumeRun } from "../runner";
import { parseClientId, listClients } from "../clients";
import { renderCsv } from "../../engine/report";
import type { SiteResult, TopicResult } from "../../core/types";

export async function runRoutes(app: FastifyInstance) {
  app.get("/runs", async (req, reply) => {
    const clientId = parseClientId((req.query as any)?.client);
    const [runs, clients] = await Promise.all([
      prisma.run.findMany({
        where: clientId !== null ? { project: { clientId } } : undefined,
        orderBy: { createdAt: "desc" },
        include: {
          project: { include: { client: true } },
          _count: { select: { runSiteScores: true } },
        },
      }),
      listClients(),
    ]);
    // Pages left to capture per run — a non-zero count is what makes a run resumable.
    const pending = await prisma.runPage.groupBy({
      by: ["runId"],
      where: { runId: { in: runs.map((r) => r.id) }, status: { not: "DONE" } },
      _count: { _all: true },
    });
    const pendingByRun = new Map(pending.map((p) => [p.runId, p._count._all]));

    return reply.view("run-list", {
      active: "runs",
      title: "Runs",
      runs,
      clients,
      selectedClientId: clientId,
      activeRunId: activeRun(),
      pendingByRun,
    });
  });

  app.get("/runs/:id", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({
      where: { id },
      include: {
        project: true,
        runSiteScores: { include: { site: true } },
        runPages: {
          include: { page: { include: { site: true } } },
          orderBy: { id: "asc" },
        },
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
      // A run is live only if THIS process is executing it; a RUNNING row that is
      // not the active run is a leftover from a previous server (see recoverStaleRuns).
      isLive: activeRun() === run.id,
      pendingPages: run.runPages.filter((rp) => rp.status !== "DONE").length,
      flash: (req.query as any)?.flash ?? null,
    });
  });

  // Continue a run that never finished: keeps the sites already scored, recaptures
  // the rest. See runner.resumeRun.
  app.post("/runs/:id/resume", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({ where: { id }, select: { id: true } });
    if (!run) return reply.code(404).send("Run not found");

    const left = await prisma.runPage.count({ where: { runId: id, status: { not: "DONE" } } });
    if (left === 0) {
      return reply.redirect(`/runs/${id}?flash=${encodeURIComponent("Ce run est déjà complet.")}`);
    }
    const res = resumeRun(id);
    if (!res.started) {
      return reply.redirect(`/runs/${id}?flash=${encodeURIComponent(res.reason ?? "Reprise impossible")}`);
    }
    return reply.redirect(`/runs/${id}`);
  });

  // Per-site maturity results as CSV (same format as the engine report / out/*.csv).
  app.get("/runs/:id/export.csv", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({
      where: { id },
      include: { runSiteScores: { include: { site: true } } },
    });
    if (!run) return reply.code(404).send("Run not found");

    const results = [...run.runSiteScores]
      .sort((a, b) => a.site.name.localeCompare(b.site.name))
      .map(
        (s): Pick<SiteResult, "site" | "topics"> => ({
          site: s.site.name,
          topics: (s.topicsJson as unknown as TopicResult[]) ?? [],
        }),
      );

    const csv = renderCsv(results as SiteResult[]);
    const date = (run.finishedAt ?? run.createdAt).toISOString().slice(0, 10);
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="run-${run.id}-${date}-maturity.csv"`,
      )
      .send(csv);
  });

  // HTMX poll partial: live per-page results while running; once terminal, refresh page.
  app.get("/runs/:id/status", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({
      where: { id },
      include: {
        runPages: {
          include: { page: { include: { site: true } } },
          orderBy: { id: "asc" },
        },
      },
    });
    if (!run) return reply.code(404).send("");
    // Terminal, or RUNNING with nobody executing it (a run left over by a previous
    // server process): either way there is nothing more to poll — reload the page.
    if (run.status === "DONE" || run.status === "FAILED" || activeRun() !== run.id) {
      reply.header("HX-Refresh", "true");
      return reply.send("");
    }
    return reply.view("partials/run-progress", { run });
  });

  // On-demand criteria detail for one captured page (available as soon as the
  // page is scored, i.e. before the run finishes).
  app.get("/runs/:id/pages/:runPageId/criteria", async (req, reply) => {
    const id = Number((req.params as any).id);
    const runPageId = Number((req.params as any).runPageId);
    const rp = await prisma.runPage.findFirst({
      where: { id: runPageId, runId: id },
      include: { page: { include: { site: true } } },
    });
    if (!rp) return reply.code(404).send("");
    return reply.view("partials/run-page-criteria", {
      pageLabel: `${rp.page.site.name} — ${rp.page.label || rp.page.kind}`,
      pageUrl: rp.url,
      pageTopics: (rp.topicsJson as any[]) ?? [],
    });
  });

  app.get("/runs/:id/sites/:siteId", async (req, reply) => {
    const id = Number((req.params as any).id);
    const siteId = Number((req.params as any).siteId);
    const score = await prisma.runSiteScore.findUnique({
      where: { runId_siteId: { runId: id, siteId } },
      include: { site: true, run: true },
    });
    if (!score) return reply.code(404).send("No score for this site/run");

    // Per-page scores for the column breakdown (in capture order).
    const runPages = await prisma.runPage.findMany({
      where: { runId: id, page: { siteId } },
      include: { page: true },
      orderBy: { id: "asc" },
    });
    const pages = runPages.map((rp) => ({
      label: rp.page.label || rp.page.kind,
      url: rp.url,
      status: rp.status,
      overall: rp.overall,
      geo: rp.geo,
      china: rp.china,
      topics: (rp.topicsJson as any[]) ?? [],
    }));

    return reply.view("run-site-detail", {
      active: "runs",
      title: `${score.site.name} — Run #${id}`,
      score,
      topics: score.topicsJson as any[],
      pages,
    });
  });

  app.post("/runs/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    await prisma.run.delete({ where: { id } }).catch(() => {});
    return reply.redirect("/runs");
  });
}
