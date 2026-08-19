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
import { startScheduler } from "./monitor";
import { recoverStaleRuns } from "./runner";

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

  // A run only exists inside a server process, so anything still RUNNING in the
  // DB at boot died with the previous one. Mark it as such before serving, so the
  // UI never shows a spinner for a run nobody is executing.
  const recovered = await recoverStaleRuns();
  if (recovered > 0) {
    console.log(`  ${recovered} run(s) interrompu(s) récupéré(s) — reprise possible depuis /runs`);
  }

  const port = Number(process.env.PORT ?? 5173);
  await app.listen({ port, host: "0.0.0.0" });
  // Start the webperf-monitoring scheduler (re-runs + CrUX sampling for MONITORING projects).
  startScheduler();
  console.log(`\n  Maturity Analyzer UI → http://localhost:${port}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
