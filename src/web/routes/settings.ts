import type { FastifyInstance } from "fastify";
import { controlCatalog, setControlConfig, resetAllControls } from "../config-store";
import { ALL_CONTROLS } from "../../topics";

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/settings", async (_req, reply) => {
    const topics = await controlCatalog();
    return reply.view("settings", { active: "settings", title: "Settings", topics });
  });

  // Single form saving every control at once. Inputs per control id:
  //   enabled_<id> (checkbox), points_<id> (number or empty=default), na_<id> (checkbox)
  app.post("/settings", async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    for (const c of ALL_CONTROLS) {
      const enabled = b[`enabled_${c.id}`] === "on";
      const naForced = b[`na_${c.id}`] === "on";
      const raw = b[`points_${c.id}`];
      let pointsOverride: number | null = null;
      if (raw !== undefined && String(raw).trim() !== "") {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0 && n !== c.defaultPoints) pointsOverride = Math.round(n);
      }
      await setControlConfig(c.id, { enabled, naForced, pointsOverride });
    }
    return reply.redirect("/settings");
  });

  app.post("/settings/reset", async (_req, reply) => {
    await resetAllControls();
    return reply.redirect("/settings");
  });
}
