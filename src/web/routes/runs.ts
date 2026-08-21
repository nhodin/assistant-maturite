import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { activeRun, resumeRun, recaptureSite } from "../runner";
import { parseClientId, listClients } from "../clients";
import { renderCsv } from "../../engine/report";
import { rescorePageFromVerdicts } from "../../engine";
import type { ConfigMap } from "../../engine";
import { buildConfigMap } from "../config-store";
import { rebuildSiteScore } from "../site-score";
import { TOPICS } from "../../topics";
import type { SiteResult, TopicResult } from "../../core/types";
import { isChinaKind } from "../categories";

/**
 * Criteria whose verdict is computed FROM the other topics (topic 12's
 * "sitespeed basics"), and so cannot be corrected by hand: the engine rewrites
 * them on every re-score. The views grey them out.
 */
const DERIVED_CONTROL_IDS = TOPICS.flatMap((t) =>
  t.controls.filter((c) => c.derivedFromTopics === true).map((c) => c.id),
);

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
        (s): Pick<SiteResult, "site" | "topics" | "chinaTopics" | "chinaOverall"> => ({
          site: s.site.name,
          topics: (s.topicsJson as unknown as TopicResult[]) ?? [],
          // China pages are a separate block in the CSV, never merged with the rest.
          chinaTopics: (s.chinaTopicsJson as unknown as TopicResult[]) ?? null,
          chinaOverall: s.chinaOverall,
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
      runId: id,
      runPageId: rp.id,
      pageLabel: `${rp.page.site.name} — ${rp.page.label || rp.page.kind}`,
      pageUrl: rp.url,
      pageTopics: (rp.topicsJson as any[]) ?? [],
      derivedIds: DERIVED_CONTROL_IDS,
    });
  });

  // Manual correction of ONE criterion on ONE captured page: the operator
  // re-checked the test and disagrees with the measured verdict.
  //
  // Deliberately NOT persisted anywhere but in the page's own stored result —
  // recapturing the page (or re-running the project) recomputes it from the
  // bundle and the correction is gone. That is the intended lifetime: it fixes
  // a reading of THIS capture, it is not a rule.
  app.post("/runs/:id/pages/:runPageId/criteria/:controlId", async (req, reply) => {
    const id = Number((req.params as any).id);
    const runPageId = Number((req.params as any).runPageId);
    const controlId = String((req.params as any).controlId);
    const verdict = String((req.body as any)?.verdict ?? "");
    if (!["pass", "fail", "na", "auto"].includes(verdict)) {
      return reply.code(400).send("verdict must be pass | fail | na | auto");
    }

    const rp = await prisma.runPage.findFirst({
      where: { id: runPageId, runId: id },
      include: { page: { select: { siteId: true } }, run: { select: { configJson: true } } },
    });
    if (!rp || rp.topicsJson === null) return reply.code(404).send("Page non scorée");

    const topics = rp.topicsJson as unknown as TopicResult[];
    const control = topics
      .flatMap((t) => t.controls ?? [])
      .find((c) => c.controlId === controlId);
    if (!control) return reply.code(404).send("Critère absent de cette page");

    if (verdict === "auto") {
      // Undo: only possible while the measured verdict is still stashed.
      if (!control.auto) return reply.code(409).send("Aucun verdict mesuré à restaurer");
      control.applicable = control.auto.applicable;
      control.passed = control.auto.passed;
      control.evidence = control.auto.evidence;
      delete control.manual;
      delete control.auto;
    } else {
      // Stashed on the FIRST correction only, so a second one does not lose the
      // engine's original verdict.
      control.auto ??= {
        applicable: control.applicable,
        passed: control.passed,
        evidence: control.evidence,
      };
      const was = control.auto.applicable ? (control.auto.passed ? "✓" : "✗") : "N/A";
      control.applicable = verdict !== "na";
      control.passed = verdict === "pass";
      control.manual = true;
      control.evidence = `Corrigé manuellement (mesuré : ${was} — ${control.auto.evidence})`;
    }

    // The run's own config, exactly as a resume/recapture does: a corrected page
    // must stay graded by the same rules as its siblings.
    const config = (rp.run.configJson as unknown as ConfigMap | null) ?? (await buildConfigMap());
    const rescored = rescorePageFromVerdicts(
      {
        url: rp.url,
        mode: rp.mode === "china" ? "china" : "standard",
        topics,
        overall: rp.overall,
        geo: rp.geo,
        china: rp.china,
      },
      TOPICS,
      config,
    );
    await prisma.runPage.update({
      where: { id: rp.id },
      data: {
        topicsJson: rescored.topics as unknown as object,
        overall: rescored.overall,
        geo: rescored.geo,
        china: rescored.china,
      },
    });
    // The site aggregate is a pure function of its pages' verdicts — rebuild it.
    await rebuildSiteScore(id, rp.page.siteId, config);

    return reply.code(204).send();
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
      // RunPage id: what a manual correction of one criterion targets.
      runPageId: rp.id,
      label: rp.page.label || rp.page.kind,
      url: rp.url,
      status: rp.status,
      // Grading family of the page: the two are displayed in separate blocks.
      isChina: rp.mode === "china" || isChinaKind(rp.page.kind),
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
      chinaTopics: (score.chinaTopicsJson as any[]) ?? null,
      pages,
      derivedIds: DERIVED_CONTROL_IDS,
      // A recapture is only offerable when nothing else is executing.
      isLive: activeRun() !== null,
      flash: (req.query as any)?.flash ?? null,
    });
  });

  // Recapture every page of ONE site of this run and rebuild its aggregate.
  // Unlike « Reprendre », it recaptures the pages already DONE — the point is to
  // refresh this site's result, the rest of the run is left untouched.
  app.post("/runs/:id/sites/:siteId/recapture", async (req, reply) => {
    const id = Number((req.params as any).id);
    const siteId = Number((req.params as any).siteId);
    const back = `/runs/${id}/sites/${siteId}`;

    const pages = await prisma.runPage.count({ where: { runId: id, page: { siteId } } });
    if (pages === 0) {
      return reply.redirect(
        `${back}?flash=${encodeURIComponent("Aucune page de ce site dans ce run.")}`,
      );
    }
    const res = recaptureSite(id, siteId);
    if (!res.started) {
      return reply.redirect(
        `${back}?flash=${encodeURIComponent(res.reason ?? "Recapture impossible")}`,
      );
    }
    // The live progress table lives on the run page.
    return reply.redirect(`/runs/${id}`);
  });

  app.post("/runs/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    await prisma.run.delete({ where: { id } }).catch(() => {});
    return reply.redirect("/runs");
  });
}
