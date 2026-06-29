/**
 * Run executor — collects each page of a run, persists evidence, scores per-site,
 * and writes RunSiteScore rows. Runs in-process (fire-and-forget); the UI polls
 * run status. Only one run executes at a time (single-user internal tool).
 */
import { prisma } from "./db";
import { collect } from "../collector";
import { TOPICS } from "../topics";
import { scoreSite } from "../engine";
import { buildConfigMap } from "./config-store";
import type { EvidenceBundle, Device } from "../core";

/**
 * A compact copy for DB storage: drops the large HTML blobs and per-request headers
 * so the JSON stays well under MySQL's max_allowed_packet. Scoring uses the full
 * in-memory bundle, so nothing is lost for the report — this is for record/debug.
 */
function slimEvidence(b: EvidenceBundle): object {
  return {
    ...b,
    rawHtml: b.rawHtml.slice(0, 2000),
    renderedHtml: "",
    requests: b.requests.map((r) => ({
      url: r.url,
      resourceType: r.resourceType,
      status: r.status,
      fromCache: r.fromCache,
      encodedBytes: r.encodedBytes,
      decodedBytes: r.decodedBytes,
      mimeType: r.mimeType,
      requestHeaders: {},
      responseHeaders: {},
    })),
  };
}

let activeRunId: number | null = null;

export function activeRun(): number | null {
  return activeRunId;
}

/** Kick off a run asynchronously. Returns immediately. */
export function startRun(runId: number): { started: boolean; reason?: string } {
  if (activeRunId !== null) {
    return { started: false, reason: `A run is already in progress (#${activeRunId})` };
  }
  activeRunId = runId;
  executeRun(runId)
    .catch((err) => console.error(`Run #${runId} crashed:`, err))
    .finally(() => {
      activeRunId = null;
    });
  return { started: true };
}

async function executeRun(runId: number): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { runPages: { include: { page: { include: { site: true } } } } },
  });
  if (!run) return;

  const config = await buildConfigMap();
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      configJson: config as object,
      totalPages: run.runPages.length,
      donePages: 0,
    },
  });

  const device: Device = run.device === "desktop" ? "desktop" : "mobile";
  const browser = run.browser === "cloak" ? "cloak" : "playwright";

  type SiteRef = (typeof run.runPages)[number]["page"]["site"];

  // Capture each page; keep the FULL bundle in memory for scoring, persist a slim copy.
  const bySite = new Map<number, { site: SiteRef; bundles: EvidenceBundle[] }>();
  let anyDone = false;

  for (const rp of run.runPages) {
    const site = rp.page.site;
    await prisma.runPage.update({ where: { id: rp.id }, data: { status: "RUNNING" } });
    try {
      const bundle = await collect(rp.url, {
        browser,
        device,
        acceptCookies: run.acceptCookies,
      });
      anyDone = true;
      const entry = bySite.get(site.id) ?? { site, bundles: [] };
      entry.bundles.push(bundle);
      bySite.set(site.id, entry);
      await prisma.runPage.update({
        where: { id: rp.id },
        data: { status: "DONE", evidenceJson: slimEvidence(bundle) },
      });
    } catch (err) {
      await prisma.runPage.update({
        where: { id: rp.id },
        data: { status: "FAILED", error: String(err).slice(0, 2000) },
      });
    }
    await prisma.run.update({
      where: { id: runId },
      data: { donePages: { increment: 1 } },
    });
  }

  for (const { site, bundles } of bySite.values()) {
    if (bundles.length === 0) continue;
    const result = scoreSite(site.name, bundles, TOPICS, config);
    await prisma.runSiteScore.upsert({
      where: { runId_siteId: { runId, siteId: site.id } },
      create: {
        runId,
        siteId: site.id,
        category: site.category,
        overall: result.overall,
        geo: result.geo,
        china: result.china,
        topicsJson: result.topics as unknown as object,
      },
      update: {
        category: site.category,
        overall: result.overall,
        geo: result.geo,
        china: result.china,
        topicsJson: result.topics as unknown as object,
      },
    });
  }

  await prisma.run.update({
    where: { id: runId },
    data: {
      status: anyDone ? "DONE" : "FAILED",
      finishedAt: new Date(),
      error: anyDone ? null : "All pages failed to capture",
    },
  });
}
