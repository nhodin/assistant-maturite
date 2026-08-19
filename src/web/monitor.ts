/**
 * Webperf monitoring ("suivi webperf") service.
 *
 * A MONITORING project is re-run and CrUX-sampled on a fixed frequency by an
 * in-process scheduler. Each cycle:
 *   1. collects CrUX field metrics for every distinct site ORIGIN and every
 *      project PAGE URL (persisted as CruxSnapshot rows), then
 *   2. creates a scheduled maturity Run and starts it via the shared run executor.
 *
 * Because the run executor allows only ONE run at a time, the scheduler processes
 * at most one project per tick and a cycle only "executes" (advancing the next-due
 * timestamp) when the run actually started.
 */
import type { MonitorFrequency } from "@prisma/client";
import { prisma } from "./db";
import { startRun, activeRun } from "./runner";
import { fetchCruxMetrics, type CruxFormFactor } from "../collector/crux";

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Form factors sampled every cycle — mobile and desktop are tracked separately. */
const FORM_FACTORS: CruxFormFactor[] = ["PHONE", "DESKTOP"];

/** Next due timestamp for a monitoring frequency, relative to `from`. */
export function computeNextAt(freq: MonitorFrequency, from: Date): Date {
  const ms = freq === "WEEKLY" ? 7 * DAY_MS : DAY_MS;
  return new Date(from.getTime() + ms);
}

// ── CrUX collection ─────────────────────────────────────────────────────────

/**
 * Collect and persist CrUX snapshots for a monitored project: for each device
 * form factor (mobile + desktop), one per distinct site origin and one per
 * project page URL. Rows are only inserted when CrUX returned data (a null fetch
 * = no field data for that URL/origin/form factor → skipped).
 * Returns the number of snapshot rows inserted.
 */
export async function collectCruxForProject(projectId: number): Promise<number> {
  const apiKey = process.env.CRUX_API_KEY;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { pages: { include: { page: { include: { site: true } } } } },
  });
  if (!project) return 0;

  const now = new Date();
  let inserted = 0;

  // Distinct origins (first page id encountered for each origin, for labeling).
  const origins = new Map<string, void>();
  for (const pp of project.pages) {
    let origin: string | null = null;
    try {
      origin = new URL(pp.page.url).origin;
    } catch {
      origin = null;
    }
    if (origin && !origins.has(origin)) origins.set(origin, undefined);
  }

  // Sequential fetches are fine (low volume, avoids hammering the CrUX API).
  // Sample every form factor for every origin and every page.
  for (const formFactor of FORM_FACTORS) {
    for (const origin of origins.keys()) {
      const m = await fetchCruxMetrics({ origin }, apiKey, formFactor);
      if (!m) continue;
      await prisma.cruxSnapshot.create({
        data: {
          projectId,
          scope: "ORIGIN",
          formFactor,
          pageId: null,
          urlKey: origin,
          lcpMs: m.lcpMs ?? null,
          ttfbMs: m.ttfbMs ?? null,
          inpMs: m.inpMs ?? null,
          cls: m.cls ?? null,
          fcpMs: m.fcpMs ?? null,
          collectedAt: now,
        },
      });
      inserted++;
    }

    for (const pp of project.pages) {
      const m = await fetchCruxMetrics({ url: pp.page.url }, apiKey, formFactor);
      if (!m) continue;
      await prisma.cruxSnapshot.create({
        data: {
          projectId,
          scope: "PAGE",
          formFactor,
          pageId: pp.pageId,
          urlKey: pp.page.url,
          lcpMs: m.lcpMs ?? null,
          ttfbMs: m.ttfbMs ?? null,
          inpMs: m.inpMs ?? null,
          cls: m.cls ?? null,
          fcpMs: m.fcpMs ?? null,
          collectedAt: now,
        },
      });
      inserted++;
    }
  }

  return inserted;
}

// ── Full cycle ──────────────────────────────────────────────────────────────

export interface CycleResult {
  started: boolean;
  reason?: string;
  runId?: number;
  cruxInserted?: number;
}

/**
 * Run one full monitoring cycle for a project: collect CrUX, then create and
 * start a scheduled maturity run. If another run is already active the run is
 * NOT created and `{ started: false }` is returned so the scheduler retries next
 * tick. `monitorLastAt`/`monitorNextAt` advance only when the run actually starts.
 */
export async function runMonitoringCycle(projectId: number): Promise<CycleResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { pages: { include: { page: true } } },
  });
  if (!project) return { started: false, reason: "Project not found" };
  if (project.pages.length === 0) {
    return { started: false, reason: "Project has no pages" };
  }

  // Guard BEFORE creating the run so we never leave an orphaned run behind.
  if (activeRun() !== null) {
    return { started: false, reason: `A run is already in progress (#${activeRun()})` };
  }

  const cruxInserted = await collectCruxForProject(projectId);

  const run = await prisma.run.create({
    data: {
      projectId,
      status: "PENDING",
      source: "scheduled",
      browser: "cloak",
      device: "mobile",
      acceptCookies: true,
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
    // Lost the race since the guard above — clean up the just-created run.
    await prisma.run.delete({ where: { id: run.id } }).catch(() => {});
    return { started: false, reason: res.reason, cruxInserted };
  }

  const now = new Date();
  await prisma.project.update({
    where: { id: projectId },
    data: {
      monitorLastAt: now,
      monitorNextAt: computeNextAt(project.monitorFrequency, now),
    },
  });

  return { started: true, runId: run.id, cruxInserted };
}

// ── Scheduler ───────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  // Don't even query if a run is busy — respects the single-run constraint.
  if (activeRun() !== null) return;

  const now = new Date();
  const due = await prisma.project.findFirst({
    where: {
      mode: "MONITORING",
      OR: [{ monitorNextAt: null }, { monitorNextAt: { lte: now } }],
    },
    orderBy: { monitorNextAt: "asc" },
  });
  if (!due) return;

  await runMonitoringCycle(due.id);
}

/** Start the 60s monitoring scheduler (unref'd so it never blocks process exit). */
export function startScheduler(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error("Monitoring scheduler tick failed:", err));
  }, 60_000);
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the scheduler (for tests / clean shutdown). */
export function stopScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
