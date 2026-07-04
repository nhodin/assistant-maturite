/**
 * Run executor — collects each page of a run, persists evidence, scores per-site,
 * and writes RunSiteScore rows. Runs in-process (fire-and-forget); the UI polls
 * run status. Only one run executes at a time (single-user internal tool).
 */
import { prisma } from "./db";
import { collect, assessCaptureHealth } from "../collector";
import { TOPICS } from "../topics";
import { scoreSite } from "../engine";
import { buildConfigMap } from "./config-store";
import type { EvidenceBundle, Device } from "../core";

type BrowserProvider = "playwright" | "cloak";

function otherBrowser(b: BrowserProvider): BrowserProvider {
  return b === "cloak" ? "playwright" : "cloak";
}

type CaptureAttempt =
  | { ok: true; bundle: EvidenceBundle }
  | { ok: false; reason: string; bundle: EvidenceBundle | null };

/** One capture + health-check attempt with a single browser provider. Never throws. */
async function tryCapture(
  url: string,
  browser: BrowserProvider,
  device: Device,
  acceptCookies: boolean,
): Promise<CaptureAttempt> {
  let bundle: EvidenceBundle;
  try {
    bundle = await collect(url, { browser, device, acceptCookies });
  } catch (err) {
    return { ok: false, reason: String(err).slice(0, 500), bundle: null };
  }
  const health = assessCaptureHealth(bundle);
  if (!health.ok) {
    return { ok: false, reason: health.reason ?? "Capture rejected", bundle };
  }
  return { ok: true, bundle };
}

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
      phase: r.phase,
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
  // Track the RunPage id alongside each bundle so we can write back its per-page score.
  const bySite = new Map<
    number,
    { site: SiteRef; items: { runPageId: number; bundle: EvidenceBundle }[] }
  >();
  let anyDone = false;

  const fallbackBrowser = otherBrowser(browser);

  for (const rp of run.runPages) {
    const site = rp.page.site;
    await prisma.runPage.update({ where: { id: rp.id }, data: { status: "RUNNING" } });

    const primaryAttempt = await tryCapture(rp.url, browser, device, run.acceptCookies);

    let bundle: EvidenceBundle | null = null;
    let pageError: string | null = null;

    if (primaryAttempt.ok) {
      bundle = primaryAttempt.bundle;
    } else {
      // Primary browser was blocked or produced an unhealthy capture — retry once
      // with the other provider (playwright <-> cloak) before giving up on this page.
      const fallbackAttempt = await tryCapture(rp.url, fallbackBrowser, device, run.acceptCookies);
      if (fallbackAttempt.ok) {
        bundle = fallbackAttempt.bundle;
        pageError = `Captured with fallback browser "${fallbackBrowser}" — "${browser}" was blocked: ${primaryAttempt.reason}`;
      } else {
        pageError =
          `Failed with both browser providers. [${browser}] ${primaryAttempt.reason} | ` +
          `[${fallbackBrowser}] ${fallbackAttempt.reason}`;
        const debugBundle = fallbackAttempt.bundle ?? primaryAttempt.bundle;
        await prisma.runPage.update({
          where: { id: rp.id },
          data: {
            status: "FAILED",
            error: pageError.slice(0, 2000),
            evidenceJson: debugBundle ? slimEvidence(debugBundle) : undefined,
          },
        });
        await prisma.run.update({ where: { id: runId }, data: { donePages: { increment: 1 } } });
        continue;
      }
    }

    anyDone = true;
    const entry = bySite.get(site.id) ?? { site, items: [] };
    entry.items.push({ runPageId: rp.id, bundle });
    bySite.set(site.id, entry);
    await prisma.runPage.update({
      where: { id: rp.id },
      data: {
        status: "DONE",
        error: pageError?.slice(0, 2000) ?? null,
        evidenceJson: slimEvidence(bundle),
      },
    });
    await prisma.run.update({
      where: { id: runId },
      data: { donePages: { increment: 1 } },
    });
  }

  for (const { site, items } of bySite.values()) {
    if (items.length === 0) continue;
    const bundles = items.map((i) => i.bundle);
    const result = scoreSite(site.name, bundles, TOPICS, config);

    // Persist each page's own score. result.pages preserves input (bundles) order.
    for (let i = 0; i < items.length; i++) {
      const pr = result.pages[i];
      if (!pr) continue;
      await prisma.runPage.update({
        where: { id: items[i].runPageId },
        data: {
          overall: pr.overall,
          geo: pr.geo,
          china: pr.china,
          topicsJson: pr.topics as unknown as object,
        },
      });
    }

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
