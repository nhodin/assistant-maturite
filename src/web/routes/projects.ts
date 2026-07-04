import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { startRun } from "../runner";
import { parseClientId, listClients } from "../clients";
import { buildProjectTrend, type TrendRunInput, type TrendPageDef } from "../trend";

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
    const project = await prisma.project.create({
      data: {
        name: String(b.name).trim(),
        description: b.description ? String(b.description).trim() : null,
        clientId,
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

    return reply.view("project-detail", {
      active: "projects",
      title: project.name,
      project,
      trend,
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

  app.post("/projects/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    await prisma.project.delete({ where: { id } }).catch(() => {});
    return reply.redirect("/projects");
  });
}
