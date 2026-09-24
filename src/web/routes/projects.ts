import type { FastifyInstance } from "fastify";
import type { MonitorFrequency, ProjectMode, CruxFormFactor } from "@prisma/client";
import { prisma } from "../db";
import { startRun } from "../runner";
import { asProvider } from "../../collector/browser";
import { runMonitoringCycle } from "../monitor";
import { parseClientId, listClients } from "../clients";
import { buildProjectTrend, type TrendRunInput, type TrendPageDef } from "../trend";
import { summarizeDiagRun, type DiagRunSummary } from "../diag-summary";
import { buildCruxTrends, type CruxSnapshotInput } from "../crux-trend";
import { parseUrlPaste } from "../url-paste";

function parseMode(v: unknown): ProjectMode {
  return v === "MONITORING" ? "MONITORING" : "STANDARD";
}

/**
 * Whether a project is a "diagnostic Speed/SEO" project (created by pasting a
 * URL list — see ../url-paste.ts and docs/DIAGNOSTIC.md) rather than a
 * maturity one. There is no dedicated Project field for this: a diagnostic
 * project's pages are ALWAYS created with kind OTHER (deliberately — the spec
 * says not to guess HP/PLP/PDP), so a project made ENTIRELY of OTHER pages is
 * read as a diagnostic one. Used only to decide a started Run's `kind`.
 */
/**
 * A project is a prospect diagnostic when it SAYS so. Deliberately not inferred
 * from its pages: a maturity project whose pages are all kind OTHER would
 * otherwise run as a diagnostic and silently lose its scoring.
 */
export function isDiagProject(project: { mode: string }): boolean {
  return project.mode === "DIAGNOSTIC";
}

function parseFrequency(v: unknown): MonitorFrequency {
  return v === "WEEKLY" ? "WEEKLY" : "DAILY";
}

function parseFormFactor(v: unknown): CruxFormFactor {
  return v === "DESKTOP" ? "DESKTOP" : "PHONE";
}

/**
 * Find-or-create the sites (category Other) and pages (kind OTHER — never
 * guessed as HP/PLP/PDP) of a parsed URL paste, under `clientId`. Idempotent:
 * existing site/page rows are reused. Returns the page ids in paste order.
 */
async function upsertDiagPages(
  result: ReturnType<typeof parseUrlPaste>,
  clientId: number | null,
): Promise<number[]> {
  const pageIds: number[] = [];
  for (const s of result.sites) {
    let site = await prisma.site.findFirst({ where: { name: s.site, clientId } });
    if (!site) {
      site = await prisma.site.create({
        data: { name: s.site, category: "Other", clientId },
      });
    }
    for (const url of s.pages) {
      let page = await prisma.page.findFirst({ where: { siteId: site.id, url } });
      if (!page) {
        page = await prisma.page.create({ data: { siteId: site.id, url, kind: "OTHER" } });
      }
      pageIds.push(page.id);
    }
  }
  return pageIds;
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
    const q = req.query as any;
    const clientId = parseClientId(q?.client);
    const formMode = q?.mode === "diag" ? "diag" : "maturity";
    const clients = await listClients();
    // The diagnostic mode never needs the per-client site/page picker — it
    // creates its own sites and pages from the pasted URL list.
    const sites =
      formMode === "maturity" && clientId !== null
        ? await prisma.site.findMany({
            where: { clientId },
            orderBy: [{ category: "asc" }, { name: "asc" }],
            include: { pages: { orderBy: { id: "asc" } } },
          })
        : [];
    return reply.view("project-form", {
      active: "projects",
      title: "New project",
      formMode,
      sites,
      clients,
      selectedClientId: clientId,
    });
  });

  // Preview-only: parse the pasted URL list and report the grouping/rejects
  // WITHOUT persisting anything, so the operator can check it before creating
  // sites/pages/project. Pure computation (see ../url-paste.ts).
  app.post("/projects/diag/preview", async (req, reply) => {
    const b = req.body as any;
    const result = parseUrlPaste(String(b?.urls ?? ""), {
      includeHomepages: b?.includeHomepages === "on" || b?.includeHomepages === "true",
    });
    return reply.view("partials/url-paste-preview", { result });
  });

  // Create a "diagnostic Speed/SEO" project from a pasted URL list: sites and
  // pages are created automatically (category Other / kind OTHER — never
  // guessed as HP/PLP/PDP), grouped by registrable domain. Idempotent: pasting
  // the same list again reuses the existing site/page rows instead of
  // duplicating them. The client is OPTIONAL in this mode (unlike the
  // maturity flow above, which still requires one).
  app.post("/projects/diag", async (req, reply) => {
    const b = req.body as any;
    const name = String(b?.name ?? "").trim();
    const clientId = parseClientId(b?.clientId);
    const includeHomepages = b?.includeHomepages === "on" || b?.includeHomepages === "true";
    const result = parseUrlPaste(String(b?.urls ?? ""), { includeHomepages });

    if (!name || result.sites.length === 0) {
      const qs = new URLSearchParams({ mode: "diag" });
      if (clientId !== null) qs.set("client", String(clientId));
      return reply.redirect(`/projects/new?${qs.toString()}`);
    }

    const pageIds = await upsertDiagPages(result, clientId);

    const project = await prisma.project.create({
      data: {
        name,
        description: b?.description ? String(b.description).trim() : null,
        clientId,
        // A diagnostic project says what it is; the run kind is read from here.
        mode: "DIAGNOSTIC",
        pages: { create: pageIds.map((pageId) => ({ pageId })) },
      },
    });
    return reply.redirect(`/projects/${project.id}`);
  });

  // Add URLs to an existing diagnostic project — same paste, same parsing and
  // same site/page reuse as the creation above. Sites are looked up under the
  // PROJECT's client, and pages already in the project are skipped.
  app.post("/projects/:id/diag/pages", async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const project = await prisma.project.findUnique({
      where: { id },
      include: { pages: { select: { pageId: true } } },
    });
    if (!project) return reply.redirect("/projects");
    if (!isDiagProject(project)) return reply.redirect(`/projects/${id}`);

    const includeHomepages = b?.includeHomepages === "on" || b?.includeHomepages === "true";
    const result = parseUrlPaste(String(b?.urls ?? ""), { includeHomepages });
    if (result.sites.length === 0) return reply.redirect(`/projects/${id}`);

    const pageIds = await upsertDiagPages(result, project.clientId);
    const existing = new Set(project.pages.map((pp) => pp.pageId));
    const toAdd = [...new Set(pageIds)].filter((pageId) => !existing.has(pageId));
    if (toAdd.length) {
      await prisma.projectPage.createMany({
        data: toAdd.map((pageId) => ({ projectId: id, pageId })),
        skipDuplicates: true,
      });
    }
    return reply.redirect(`/projects/${id}?flash=pages_added_${toAdd.length}`);
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
            runPages: {
              select: { pageId: true, overall: true, status: true, diagJson: true },
            },
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

    // A diagnostic scores nothing, so instead of the score chart the page shows
    // GO/NOGO tallies for Speed and SEO — per run, keyed by run id.
    const diagSummaries: Record<number, DiagRunSummary> = {};
    if (isDiagProject(project)) {
      for (const r of project.runs) diagSummaries[r.id] = summarizeDiagRun(r.runPages);
    }
    const latestDiagRun = isDiagProject(project)
      ? (project.runs.find((r) => r.status === "DONE") ?? null)
      : null;

    // Webperf monitoring: CrUX snapshots for the latest-values table + trend charts.
    // A device toggle (?ff=PHONE|DESKTOP) filters both to one form factor at a time.
    const selectedFF = parseFormFactor((req.query as any)?.ff);
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
    // Which form factors actually have data (drives the toggle availability).
    const cruxFormFactors: CruxFormFactor[] = [];

    if (project.mode === "MONITORING") {
      const allSnapshots = await prisma.cruxSnapshot.findMany({
        where: { projectId: id },
        orderBy: { collectedAt: "asc" },
        include: { page: { include: { site: true } } },
      });

      if (allSnapshots.some((s) => s.formFactor === "PHONE")) cruxFormFactors.push("PHONE");
      if (allSnapshots.some((s) => s.formFactor === "DESKTOP")) cruxFormFactors.push("DESKTOP");

      // Restrict the table + charts to the selected device form factor.
      const snapshots = allSnapshots.filter((s) => s.formFactor === selectedFF);

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
      diagSummaries,
      latestDiagRun: latestDiagRun
        ? { id: latestDiagRun.id, date: latestDiagRun.finishedAt ?? latestDiagRun.createdAt }
        : null,
      cruxTrends,
      cruxLatest,
      cruxFormFactors,
      selectedFF,
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
    const kind = isDiagProject(project) ? "diag" : "maturity";
    const run = await prisma.run.create({
      data: {
        projectId: id,
        status: "PENDING",
        source: "manual",
        kind,
        browser: asProvider(String(b.browser ?? "cloak")),
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
      // Leaving monitoring clears the pause flag so a later re-activation starts clean.
      data: {
        mode,
        monitorFrequency,
        monitorNextAt,
        monitorPaused: mode === "MONITORING" ? project.monitorPaused : false,
      },
    });
    return reply.redirect(`/projects/${id}`);
  });

  // Pause / resume the automatic collection of a monitoring project.
  app.post("/projects/:id/monitor-pause", async (req, reply) => {
    const id = Number((req.params as any).id);
    const paused = String((req.body as any)?.paused ?? "1") === "1";
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return reply.redirect("/projects");
    await prisma.project.update({
      where: { id },
      data: {
        monitorPaused: paused,
        // Resuming a project whose next cycle was never scheduled starts one now.
        monitorNextAt: !paused && project.monitorNextAt === null ? new Date() : project.monitorNextAt,
      },
    });
    return reply.redirect(`/projects/${id}?flash=${paused ? "paused" : "resumed"}`);
  });

  // Trigger one monitoring cycle now (CrUX collection + scheduled run).
  // `force`: an explicit click collects even when the project is paused.
  app.post("/projects/:id/monitor-now", async (req, reply) => {
    const id = Number((req.params as any).id);
    const res = await runMonitoringCycle(id, { force: true });
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
