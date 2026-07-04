import type { FastifyInstance } from "fastify";
import type { MonitorFrequency, ProjectMode } from "@prisma/client";
import { prisma } from "../db";
import { startRun } from "../runner";
import { runMonitoringCycle } from "../monitor";
import { parseClientId, listClients } from "../clients";
import { buildProjectTrend, type TrendRunInput, type TrendPageDef } from "../trend";
import { buildCruxTrends, type CruxSnapshotInput } from "../crux-trend";

function parseMode(v: unknown): ProjectMode {
  return v === "MONITORING" ? "MONITORING" : "STANDARD";
}

function parseFrequency(v: unknown): MonitorFrequency {
  return v === "WEEKLY" ? "WEEKLY" : "DAILY";
}

function toIdArray(v: unknown): number[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => Number(x)).filter((n) => Number.isInteger(n));
}

export async function projectRoutes(app: FastifyInstance) {
  app.get("/projects", async (req, reply) => {
    const clientId = parseClientId((req.query as any)?.client);
    const [projects, clients] = await Promise.all([
      prisma.project.findMany({
        where: clientId !== null ? { clientId } : undefined,
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { pages: true, runs: true } },
          runs: { orderBy: { createdAt: "desc" }, take: 1 },
          client: true,
        },
      }),
      listClients(),
    ]);
    return reply.view("project-list", {
      active: "projects",
      title: "Projects",
      projects,
      clients,
      selectedClientId: clientId,
    });
  });

  app.get("/projects/new", async (req, reply) => {
    const clientId = parseClientId((req.query as any)?.client);
    const [sites, clients] = await Promise.all([
      // Only show the selected client's sites; none until a client is picked.
      clientId !== null
        ? prisma.site.findMany({
            where: { clientId },
            orderBy: [{ category: "asc" }, { name: "asc" }],
            include: { pages: { orderBy: { id: "asc" } } },
          })
        : Promise.resolve([]),
      listClients(),
    ]);
    return reply.view("project-form", {
      active: "projects",
      title: "New project",
      sites,
      clients,
      selectedClientId: clientId,
    });
  });

  app.post("/projects", async (req, reply) => {
    const b = req.body as any;
    const pageIds = toIdArray(b.pageIds);
    const clientId = parseClientId(b.clientId);
    if (!b?.name?.trim() || pageIds.length === 0 || clientId === null) {
      return reply.redirect(clientId !== null ? `/projects/new?client=${clientId}` : "/projects/new");
    }
    const mode = parseMode(b.mode);
    const monitorFrequency = parseFrequency(b.monitorFrequency);
    const project = await prisma.project.create({
      data: {
        name: String(b.name).trim(),
        description: b.description ? String(b.description).trim() : null,
        clientId,
        mode,
        monitorFrequency,
        // Monitoring projects run their first cycle ASAP.
        monitorNextAt: mode === "MONITORING" ? new Date() : null,
        pages: { create: pageIds.map((pageId) => ({ pageId })) },
      },
    });
    return reply.redirect(`/projects/${project.id}`);
  });

  app.get("/projects/:id", async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        client: true,
        pages: { include: { page: { include: { site: true } } } },
        runs: {
          orderBy: { createdAt: "desc" },
          include: {
            runSiteScores: { select: { overall: true } },
            runPages: { select: { pageId: true, overall: true } },
          },
        },
      },
    });
    if (!project) return reply.code(404).send("Project not found");

    // Score-evolution chart: one line for the global (principal) score plus one
    // per project page, across the project's completed runs (oldest → newest).
    const multiSite =
      new Set(project.pages.map((pp) => pp.page.siteId)).size > 1;
    const pageDefs: TrendPageDef[] = project.pages.map((pp) => ({
      pageId: pp.pageId,
      label: multiSite
        ? `${pp.page.kind} · ${pp.page.site.name}`
        : pp.page.kind,
    }));
    const trendRuns: TrendRunInput[] = project.runs
      .filter((r) => r.status === "DONE")
      .map((r) => {
        const siteOveralls = r.runSiteScores
          .map((s) => s.overall)
          .filter((v): v is number => v !== null && v !== undefined);
        const global =
          siteOveralls.length > 0
            ? Math.round(
                siteOveralls.reduce((a, b) => a + b, 0) / siteOveralls.length,
              )
            : null;
        const pageScores: Record<number, number | null> = {};
        for (const rp of r.runPages) pageScores[rp.pageId] = rp.overall ?? null;
        return { id: r.id, date: r.finishedAt ?? r.createdAt, global, pageScores };
      })
      .reverse(); // chronological for the x-axis
    const trend = buildProjectTrend(trendRuns, pageDefs);

    // Webperf monitoring: CrUX snapshots for the latest-values table + trend charts.
    let cruxTrends: ReturnType<typeof buildCruxTrends> = [];
    let cruxLatest: {
      scope: string;
      label: string;
      urlKey: string;
      lcpMs: number | null;
      ttfbMs: number | null;
      inpMs: number | null;
      cls: number | null;
      fcpMs: number | null;
      collectedAt: Date;
    }[] = [];

    if (project.mode === "MONITORING") {
      const snapshots = await prisma.cruxSnapshot.findMany({
        where: { projectId: id },
        orderBy: { collectedAt: "asc" },
        include: { page: { include: { site: true } } },
      });

      // Label helper for a snapshot's scope.
      const labelFor = (s: (typeof snapshots)[number]): string => {
        if (s.scope === "ORIGIN") return `Origine · ${s.urlKey}`;
        if (s.page) return `${s.page.kind} · ${s.page.site.name}`;
        return s.urlKey;
      };
      const keyFor = (s: (typeof snapshots)[number]): string =>
        s.scope === "ORIGIN" ? `origin:${s.urlKey}` : `page:${s.pageId}`;

      // Trend charts: one series per scope (origins first, then pages).
      const trendInput: CruxSnapshotInput[] = snapshots.map((s) => ({
        scopeKey: keyFor(s),
        scopeLabel: labelFor(s),
        date: s.collectedAt,
        lcpMs: s.lcpMs,
        ttfbMs: s.ttfbMs,
        inpMs: s.inpMs,
        cls: s.cls,
      }));
      cruxTrends = buildCruxTrends(trendInput);

      // Latest-value table: last snapshot per scope (origins first, then pages).
      const latestByKey = new Map<string, (typeof snapshots)[number]>();
      for (const s of snapshots) latestByKey.set(keyFor(s), s); // asc order → last wins
      cruxLatest = [...latestByKey.values()]
        .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "ORIGIN" ? -1 : 1))
        .map((s) => ({
          scope: s.scope,
          label: labelFor(s),
          urlKey: s.urlKey,
          lcpMs: s.lcpMs,
          ttfbMs: s.ttfbMs,
          inpMs: s.inpMs,
          cls: s.cls,
          fcpMs: s.fcpMs,
          collectedAt: s.collectedAt,
        }));
    }

    return reply.view("project-detail", {
      active: "projects",
      title: project.name,
      project,
      trend,
      cruxTrends,
      cruxLatest,
      flash: (req.query as any)?.flash ?? null,
    });
  });

  app.post("/projects/:id/run", async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const project = await prisma.project.findUnique({
      where: { id },
      include: { pages: { include: { page: true } } },
    });
    if (!project || project.pages.length === 0) {
      return reply.redirect(`/projects/${id}`);
    }
    const run = await prisma.run.create({
      data: {
        projectId: id,
        status: "PENDING",
        source: "manual",
        browser: b.browser === "playwright" ? "playwright" : "cloak",
        device: b.device === "desktop" ? "desktop" : "mobile",
        acceptCookies: b.acceptCookies === "on" || b.acceptCookies === "true",
        totalPages: project.pages.length,
        runPages: {
          create: project.pages.map((pp) => ({
            pageId: pp.pageId,
            url: pp.page.url,
            status: "PENDING",
          })),
        },
      },
    });
    const res = startRun(run.id);
    if (!res.started) {
      await prisma.run.update({
        where: { id: run.id },
        data: { status: "FAILED", error: res.reason ?? "Could not start" },
      });
    }
    return reply.redirect(`/runs/${run.id}`);
  });

  // Update monitoring settings (mode + frequency) from the project detail page.
  app.post("/projects/:id/monitoring", async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const mode = parseMode(b.mode);
    const monitorFrequency = parseFrequency(b.monitorFrequency);
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return reply.redirect("/projects");
    // Turning monitoring ON (from off) schedules the first cycle immediately.
    const monitorNextAt =
      mode === "MONITORING"
        ? project.mode === "MONITORING"
          ? project.monitorNextAt
          : new Date()
        : null;
    await prisma.project.update({
      where: { id },
      data: { mode, monitorFrequency, monitorNextAt },
    });
    return reply.redirect(`/projects/${id}`);
  });

  // Trigger one monitoring cycle now (CrUX collection + scheduled run).
  app.post("/projects/:id/monitor-now", async (req, reply) => {
    const id = Number((req.params as any).id);
    const res = await runMonitoringCycle(id);
    const flash = res.started
      ? `crux_started`
      : `busy`;
    return reply.redirect(`/projects/${id}?flash=${flash}`);
  });

  app.post("/projects/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    await prisma.project.delete({ where: { id } }).catch(() => {});
    return reply.redirect("/projects");
  });
}
