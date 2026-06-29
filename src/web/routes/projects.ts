import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { startRun } from "../runner";

function toIdArray(v: unknown): number[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => Number(x)).filter((n) => Number.isInteger(n));
}

export async function projectRoutes(app: FastifyInstance) {
  app.get("/projects", async (_req, reply) => {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { pages: true, runs: true } },
        runs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    return reply.view("project-list", { active: "projects", title: "Projects", projects });
  });

  app.get("/projects/new", async (_req, reply) => {
    const sites = await prisma.site.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: { pages: { orderBy: { id: "asc" } } },
    });
    return reply.view("project-form", { active: "projects", title: "New project", sites });
  });

  app.post("/projects", async (req, reply) => {
    const b = req.body as any;
    const pageIds = toIdArray(b.pageIds);
    if (!b?.name?.trim() || pageIds.length === 0) {
      return reply.redirect("/projects/new");
    }
    const project = await prisma.project.create({
      data: {
        name: String(b.name).trim(),
        description: b.description ? String(b.description).trim() : null,
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
        pages: { include: { page: { include: { site: true } } } },
        runs: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!project) return reply.code(404).send("Project not found");
    return reply.view("project-detail", {
      active: "projects",
      title: project.name,
      project,
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
