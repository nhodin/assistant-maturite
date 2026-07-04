import type { FastifyInstance } from "fastify";
import { prisma } from "../db";

export async function clientRoutes(app: FastifyInstance) {
  // ── Clients list ─────────────────────────────────────────────────────────────
  app.get("/clients", async (_req, reply) => {
    const clients = await prisma.client.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { sites: true, projects: true } } },
    });
    return reply.view("clients", { active: "clients", title: "Clients", clients });
  });

  app.post("/clients", async (req, reply) => {
    const b = req.body as any;
    const name = String(b?.name ?? "").trim();
    if (name) {
      await prisma.client
        .create({
          data: { name, notes: b.notes ? String(b.notes).trim() : null },
        })
        .catch(() => {}); // ignore duplicate name (unique)
    }
    return reply.redirect("/clients");
  });

  app.post("/clients/:id/edit", async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const name = String(b?.name ?? "").trim();
    await prisma.client
      .update({
        where: { id },
        data: {
          name: name || undefined,
          notes: b.notes ? String(b.notes).trim() : null,
        },
      })
      .catch(() => {});
    return reply.redirect("/clients");
  });

  // Detaches sites/projects (clientId → null via onDelete: SetNull); does not delete them.
  app.post("/clients/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    await prisma.client.delete({ where: { id } }).catch(() => {});
    return reply.redirect("/clients");
  });
}
