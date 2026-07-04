/**
 * Maturity Analyzer — web app (Fastify + EJS + HTMX).
 * Server-rendered internal dashboard: inventory, projects, runs, settings, diagnostics.
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import view from "@fastify/view";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import ejs from "ejs";
import { viewHelpers } from "./helpers";
import { dashboardRoutes } from "./routes/dashboard";
import { clientRoutes } from "./routes/clients";
import { inventoryRoutes } from "./routes/inventory";
import { projectRoutes } from "./routes/projects";
import { runRoutes } from "./routes/runs";
import { settingsRoutes } from "./routes/settings";
import { diagnosticsRoutes } from "./routes/diagnostics";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: false });

  await app.register(formbody);
  await app.register(view, {
    engine: { ejs },
    root: path.join(__dirname, "views"),
    viewExt: "ejs",
    defaultContext: viewHelpers,
  });
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/public/",
  });

  await app.register(dashboardRoutes);
  await app.register(clientRoutes);
  await app.register(inventoryRoutes);
  await app.register(projectRoutes);
  await app.register(runRoutes);
  await app.register(settingsRoutes);
  await app.register(diagnosticsRoutes);

  const port = Number(process.env.PORT ?? 5173);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`\n  Maturity Analyzer UI → http://localhost:${port}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
