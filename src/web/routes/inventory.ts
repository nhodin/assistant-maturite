import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { CATEGORIES, PAGE_KINDS } from "../categories";
import { parseClientId, listClients } from "../clients";

function asCategory(v: unknown): any {
  return CATEGORIES.includes(v as any) ? v : "Other";
}
function asKind(v: unknown): any {
  return PAGE_KINDS.includes(v as any) ? v : "OTHER";
}

export async function inventoryRoutes(app: FastifyInstance) {
  // ── Sites list ──────────────────────────────────────────────────────────────
  app.get("/inventory", async (req, reply) => {
    const clientId = parseClientId((req.query as any)?.client);
    const [sites, clients] = await Promise.all([
      prisma.site.findMany({
        where: clientId !== null ? { clientId } : undefined,
        orderBy: [{ category: "asc" }, { name: "asc" }],
        include: { _count: { select: { pages: true } }, client: true },
      }),
      listClients(),
    ]);
    return reply.view("inventory", {
      active: "inventory",
      title: "Inventory",
      sites,
      clients,
      selectedClientId: clientId,
    });
  });

  app.post("/inventory/sites", async (req, reply) => {
    const b = req.body as any;
    if (b?.name?.trim()) {
      await prisma.site.create({
        data: {
          name: String(b.name).trim(),
          category: asCategory(b.category),
          clientId: parseClientId(b.clientId),
          homepage: b.homepage ? String(b.homepage).trim() : null,
          notes: b.notes ? String(b.notes).trim() : null,
        },
      });
    }
    return reply.redirect("/inventory");
  });

  app.post("/inventory/sites/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    await prisma.site.delete({ where: { id } }).catch(() => {});
    return reply.redirect("/inventory");
  });

  // ── Site detail (pages) ───────────────────────────────────────────────────────
  app.get("/inventory/sites/:id", async (req, reply) => {
    const id = Number((req.params as any).id);
    const [site, clients] = await Promise.all([
      prisma.site.findUnique({
        where: { id },
        include: { pages: { orderBy: { id: "asc" } }, client: true },
      }),
      listClients(),
    ]);
    if (!site) return reply.code(404).send("Site not found");
    return reply.view("site-detail", { active: "inventory", title: site.name, site, clients });
  });

  app.post("/inventory/sites/:id/edit", async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    await prisma.site.update({
      where: { id },
      data: {
        name: String(b.name ?? "").trim() || undefined,
        category: asCategory(b.category),
        clientId: parseClientId(b.clientId),
        homepage: b.homepage ? String(b.homepage).trim() : null,
        notes: b.notes ? String(b.notes).trim() : null,
      },
    });
    return reply.redirect(`/inventory/sites/${id}`);
  });

  app.post("/inventory/sites/:id/pages", async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    if (b?.url?.trim()) {
      await prisma.page.create({
        data: {
          siteId: id,
          kind: asKind(b.kind),
          label: b.label ? String(b.label).trim() : null,
          url: String(b.url).trim(),
        },
      });
    }
    return reply.redirect(`/inventory/sites/${id}`);
  });

  app.post("/inventory/pages/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    const page = await prisma.page.findUnique({ where: { id } });
    await prisma.page.delete({ where: { id } }).catch(() => {});
    return reply.redirect(page ? `/inventory/sites/${page.siteId}` : "/inventory");
  });
}
