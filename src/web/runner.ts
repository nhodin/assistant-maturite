/**
 * Run executor — collects each page of a run, persists evidence, scores per-site,
 * and writes RunSiteScore rows. Runs in-process (fire-and-forget); the UI polls
 * run status. Only one run executes at a time (single-user internal tool).
 */
import { prisma } from "./db";
import { collect, assessCaptureHealth } from "../collector";
import { asProvider, fallbackChain, providersAfterFailure } from "../collector/browser";
import type { CaptureFailureKind } from "../collector/sanity";
import { TOPICS } from "../topics";
import { scoreSite, scorePage } from "../engine";
import { buildConfigMap } from "./config-store";
import type { EvidenceBundle, Device, BrowserProvider } from "../core";

/** Pause before escalating to another provider on a WAF block, to stop hammering. */
const BLOCK_COOLDOWN_MS = 20_000;

/**
 * How many pages of the SAME origin may be blocked before the executor stops
 * escalating for that origin altogether. Past this point every extra attempt is
 * a near-certain 403 that only degrades the IP's standing with the WAF further.
 */
const ORIGIN_BLOCK_BUDGET = 2;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type CaptureAttempt =
  | { ok: true; bundle: EvidenceBundle }
  | {
      ok: false;
      reason: string;
      bundle: EvidenceBundle | null;
      kind: CaptureFailureKind;
    };

/** One capture + health-check attempt with a single browser provider. Never throws. */
async function tryCapture(
  url: string,
  browser: BrowserProvider,
  device: Device,
  acceptCookies: boolean,
): Promise<CaptureAttempt> {
  let bundle: EvidenceBundle;
  try {
    bundle = await collect(url, {
      browser,
      device,
      acceptCookies,
      cruxApiKey: process.env.CRUX_API_KEY,
    });
  } catch (err) {
    // A throw is a technical failure (launch/navigation/timeout), never a WAF verdict.
    return { ok: false, reason: String(err).slice(0, 500), bundle: null, kind: "unusable" };
  }
  const health = assessCaptureHealth(bundle);
  if (!health.ok) {
    return {
      ok: false,
      reason: health.reason ?? "Capture rejected",
      bundle,
      kind: health.kind ?? "unusable",
    };
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
  const browser = asProvider(run.browser);

  type SiteRef = (typeof run.runPages)[number]["page"]["site"];

  // Capture each page; keep the FULL bundle in memory for scoring, persist a slim copy.
  // Track the RunPage id alongside each bundle so we can write back its per-page score.
  const bySite = new Map<
    number,
    { site: SiteRef; items: { runPageId: number; bundle: EvidenceBundle }[] }
  >();
  let anyDone = false;

  const chain = fallbackChain(browser);
  /** Pages already blocked per origin — feeds the per-origin circuit breaker. */
  const blocksByOrigin = new Map<string, number>();

  for (const rp of run.runPages) {
    const site = rp.page.site;
    await prisma.runPage.update({ where: { id: rp.id }, data: { status: "RUNNING" } });

    // Try providers until one yields a HEALTHY capture. A provider "fails" both
    // when collect() throws and when assessCaptureHealth rejects the bundle — see
    // tryCapture. What happens NEXT depends on why it failed: a technical failure
    // costs nothing to retry, a WAF block costs the IP's standing with that origin.
    let bundle: EvidenceBundle | null = null;
    let pageError: string | null = null;
    let usedBrowser: BrowserProvider | null = null;
    let debugBundle: EvidenceBundle | null = null;
    const failures: string[] = [];
    const attempted: BrowserProvider[] = [];
    const origin = originOf(rp.url);
    let queue: BrowserProvider[] = [chain[0]];

    while (queue.length > 0) {
      const provider = queue.shift()!;
      attempted.push(provider);
      const attempt = await tryCapture(rp.url, provider, device, run.acceptCookies);
      if (attempt.ok) {
        bundle = attempt.bundle;
        usedBrowser = provider;
        break;
      }
      failures.push(`[${provider}] ${attempt.reason}`);
      debugBundle = attempt.bundle ?? debugBundle;

      if (attempt.kind === "blocked") {
        const blocked = (blocksByOrigin.get(origin) ?? 0) + 1;
        blocksByOrigin.set(origin, blocked);
        if (blocked > ORIGIN_BLOCK_BUDGET) {
          failures.push(
            `[circuit-breaker] ${origin} has now blocked ${blocked} capture(s) in this run — ` +
              `giving up on it instead of escalating, since further attempts from the same IP ` +
              `only harden the WAF. Capture it with a warm browser session (see the "cdp" ` +
              `provider) or import it manually.`,
          );
          break;
        }
      }

      queue = providersAfterFailure(chain, attempted, attempt.kind);
      // Escalating right after a block would just hand the WAF another data point.
      if (queue.length > 0 && attempt.kind === "blocked") {
        await sleep(BLOCK_COOLDOWN_MS);
      }
    }

    if (!bundle) {
      pageError = `Capture failed after ${attempted.length} attempt(s). ${failures.join(" | ")}`;
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

    if (usedBrowser !== browser) {
      pageError =
        `Captured with fallback browser "${usedBrowser}" — ${failures.join(" | ")}`;
    }

    anyDone = true;
    const entry = bySite.get(site.id) ?? { site, items: [] };
    entry.items.push({ runPageId: rp.id, bundle });
    bySite.set(site.id, entry);

    // Score this page right away so the UI can show its criteria live, without
    // waiting for the whole run. The site aggregate is still computed at the end.
    const pageResult = scorePage(bundle, TOPICS, config);
    await prisma.runPage.update({
      where: { id: rp.id },
      data: {
        status: "DONE",
        error: pageError?.slice(0, 2000) ?? null,
        evidenceJson: slimEvidence(bundle),
        overall: pageResult.overall,
        geo: pageResult.geo,
        china: pageResult.china,
        topicsJson: pageResult.topics as unknown as object,
      },
    });
    await prisma.run.update({
      where: { id: runId },
      data: { donePages: { increment: 1 } },
    });
  }

  for (const { site, items } of bySite.values()) {
    if (items.length === 0) continue;
    // Per-page scores were already persisted during capture (same pure scorePage).
    const bundles = items.map((i) => i.bundle);
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
