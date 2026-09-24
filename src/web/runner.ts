/**
 * Run executor — collects each page of a run, persists evidence, scores per-site,
 * and writes RunSiteScore rows. Runs in-process (fire-and-forget); the UI polls
 * run status. Only one run executes at a time (single-user internal tool): the
 * parallelism budget lives INSIDE a run, as the capture pool below, so that the
 * number of live browser sessions stays bounded by CAPTURE_CONCURRENCY whatever
 * the UI does.
 *
 * Within a run, pages are grouped by origin and the groups are captured in
 * parallel — never two sessions on the same origin at once. See
 * collector/concurrency.ts for why the parallelism has that shape.
 *
 * A run lives only in this process, so it dies with it. Two things make that
 * survivable: each site is scored the moment its last page is captured (rather
 * than all sites at the end), and `resumeRun` continues an interrupted run,
 * keeping the sites already scored and recapturing only the rest.
 */
import { prisma } from "./db";
import { collect, assessCaptureHealth } from "../collector";
import { asProvider } from "../collector/browser";
import { ensureCloakBinary } from "../collector/cloak-binary";
import { diagRulesVersion } from "../prospect/rules-version";
import { captureConcurrencyFromEnv, groupByOrigin, runPool } from "../collector/concurrency";
import { captureThrottlingFromEnv, describeThrottling } from "../collector/throttling";
import type { CaptureFailureKind } from "../collector/sanity";
import { TOPICS } from "../topics";
import { scorePage } from "../engine";
import { rebuildSiteScore } from "./site-score";
import { buildConfigMap } from "./config-store";
import type { ConfigMap } from "../engine";
import type {
  EvidenceBundle,
  Device,
  BrowserProvider,
  CaptureMode,
  CaptureProfile,
  PageScoringMode,
} from "../core";
import { isChinaKind } from "./categories";
import { diagnosePage } from "../prospect";
import { fetchOriginCwv, type CwvSummary } from "../prospect/cwv";
import { AUDIENCE_COUNTRY, fetchOriginAudience, withRankFailure, withRanks, type AudienceSummary } from "../prospect/audience";
import { cruxBqConfig, fetchCruxRanks, isRankFailure, rankFailureWarning, type CruxRankResult } from "../collector/crux-rank";
import type { PageDiagnostic } from "../prospect";
import { detectPlatform, fetchSetCookieNames } from "../collector/platform-probe";
import { representativePages } from "./site-representative";

/**
 * DONE diag pages of a run, restricted to ONE per site — the home, else the
 * first captured page (web/site-representative.ts). Audience and app web /
 * CDN-WAF are site-level facts: computing them on every page cost fetches for
 * the same answer, and the table shows them once anyway.
 */
async function representativeDonePages(runId: number) {
  const pages = await prisma.runPage.findMany({
    where: { runId, status: "DONE" },
    orderBy: { id: "asc" },
    select: { id: true, url: true, diagJson: true, page: { select: { siteId: true, kind: true } } },
  });
  const withDiag = pages.filter((p) => p.diagJson !== null);
  const reps = new Set(
    representativePages(withDiag.map((p) => ({ id: p.id, siteId: p.page.siteId, url: p.url, kind: p.page.kind }))).values(),
  );
  return withDiag.filter((p) => reps.has(p.id));
}

/**
 * How a page is graded, from its inventory kind. A CHINA page is scored on the
 * first criterion of each topic plus topic 12; every other kind is standard.
 */
function modeOfKind(kind: string): PageScoringMode {
  return isChinaKind(kind) ? "china" : "standard";
}

/**
 * Diag only: add the CrUX popularity rank to every captured page of the run, in
 * ONE BigQuery query for all their origins (the query cost is the table scan,
 * not the number of origins). Runs over EVERY DONE page, not only this pass's:
 * a resumed run then reads all its pages at the same dataset month.
 *
 * NEVER blocks the run: a failed query (quota exhausted, cost cap, access
 * refused…) marks the pages "rank unavailable" with the reason and returns a
 * warning for the run; the diagnostic itself is complete either way. Returns
 * null when there is nothing to warn about (success, or not configured).
 */
async function attachCruxRanks(runId: number): Promise<string | null> {
  try {
    const pages = await prisma.runPage.findMany({
      where: { runId, status: "DONE" },
      select: { id: true, diagJson: true },
    });
    const withAudience = pages
      .map((p) => ({ id: p.id, diag: p.diagJson as unknown as PageDiagnostic | null }))
      .filter((p): p is { id: number; diag: PageDiagnostic & { audience: AudienceSummary } } => !!p.diag?.audience);
    if (withAudience.length === 0) return null;
    const ranks = await fetchCruxRanks(
      withAudience.map((p) => p.diag.audience.origin),
      { country: AUDIENCE_COUNTRY },
    );
    if (!ranks) return null;
    const failure = isRankFailure(ranks) ? ranks : null;
    for (const p of withAudience) {
      const audience = failure ? withRankFailure(p.diag.audience, failure) : withRanks(p.diag.audience, ranks as CruxRankResult);
      const diag: PageDiagnostic = { ...p.diag, audience };
      await prisma.runPage.update({ where: { id: p.id }, data: { diagJson: diag as unknown as object } });
    }
    return failure ? rankFailureWarning(failure) : null;
  } catch (err) {
    // A DB hiccup here must not turn a finished diagnostic into a crashed run.
    console.error(`Run #${runId}: CrUX rank attachment failed:`, err);
    return "Colonne Audience : le rang CrUX n'a pas pu être enregistré pour ce run. Le diagnostic est complet par ailleurs.";
  }
}

/**
 * Compute (or refresh) the Audience column of an EXISTING diag run, without
 * recapturing anything: the audience depends on the origin only, and the landed-on
 * origin is already stored (CWV origin, else the slimmed evidence's finalUrl,
 * else the inventory URL). Mobile share per origin, then the one rank query —
 * same code path as the end of a run, same "never blocks" rule.
 */
export async function enrichRunAudience(
  runId: number,
): Promise<{ ok: true; pages: number; warning: string | null } | { ok: false; reason: string }> {
  if (activeRunId === runId) return { ok: false, reason: "Ce run est en cours : l'audience sera calculée à sa fin." };
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { kind: true } });
  if (!run) return { ok: false, reason: "Run introuvable." };
  if (run.kind !== "diag") return { ok: false, reason: "L'audience ne concerne que les runs de diagnostic." };
  const rankConfigured = !!cruxBqConfig();
  if (!process.env.CRUX_API_KEY && !rankConfigured) {
    return { ok: false, reason: "Ni CRUX_API_KEY ni BigQuery (CRUX_BQ_CREDENTIALS) ne sont configurés." };
  }

  const pages = await representativeDonePages(runId);
  const byOrigin = new Map<string, Promise<AudienceSummary | undefined>>();
  let enriched = 0;
  for (const p of pages) {
    const diag = p.diagJson as unknown as PageDiagnostic | null;
    if (!diag) continue;
    let landed = diag.audience?.origin ?? diag.cwv?.origin;
    if (!landed) {
      const ev = await prisma.runPage.findUnique({ where: { id: p.id }, select: { evidenceJson: true } });
      landed = (ev?.evidenceJson as { finalUrl?: string } | null)?.finalUrl || p.url;
    }
    const key = originOf(landed);
    let pending = byOrigin.get(key);
    if (!pending) {
      pending = fetchOriginAudience(landed, process.env.CRUX_API_KEY, rankConfigured);
      byOrigin.set(key, pending);
    }
    const audience = await pending;
    if (!audience) continue;
    await prisma.runPage.update({
      where: { id: p.id },
      data: { diagJson: { ...diag, audience } as unknown as object },
    });
    enriched++;
  }
  const warning = await attachCruxRanks(runId);
  await prisma.run.update({ where: { id: runId }, data: { warning } });
  return { ok: true, pages: enriched, warning };
}

/**
 * Compute (or refresh) the web-application + CDN/WAF fields of an EXISTING diag
 * run without recapturing: the stored diag evidence keeps the document headers,
 * every request URL and a rendered-HTML excerpt, which carry most signatures.
 * Cookies are not stored, so one lightweight GET per origin supplies the
 * first-party `Set-Cookie` names (bot-manager and platform session cookies).
 * Only `diagJson.stack` is touched — the verdict is informational-free.
 */
export async function enrichRunTechno(
  runId: number,
): Promise<{ ok: true; pages: number; skipped: number } | { ok: false; reason: string }> {
  if (activeRunId === runId) return { ok: false, reason: "Ce run est en cours : l'analyse technique est faite pendant la capture." };
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { kind: true } });
  if (!run) return { ok: false, reason: "Run introuvable." };
  if (run.kind !== "diag") return { ok: false, reason: "L'analyse technique ne concerne que les runs de diagnostic." };

  const reps = await representativeDonePages(runId);
  const pages = await prisma.runPage.findMany({
    where: { id: { in: reps.map((p) => p.id) } },
    select: { id: true, url: true, diagJson: true, evidenceJson: true },
  });
  const cookiesByOrigin = new Map<string, Promise<string[]>>();
  let enriched = 0;
  let skipped = 0;
  for (const p of pages) {
    const diag = p.diagJson as unknown as PageDiagnostic | null;
    const ev = p.evidenceJson as unknown as Partial<EvidenceBundle> | null;
    if (!diag || !ev) {
      skipped++;
      continue;
    }
    const pageUrl = ev.finalUrl || p.url;
    const key = originOf(pageUrl);
    let pending = cookiesByOrigin.get(key);
    if (!pending) {
      pending = fetchSetCookieNames(pageUrl);
      cookiesByOrigin.set(key, pending);
    }
    const probe = detectPlatform({
      pageUrl,
      renderedHtml: ev.renderedHtml || ev.rawHtml || "",
      requestUrls: (ev.requests ?? []).map((r) => r.url),
      headers: ev.mainResponseHeaders ?? {},
      cookieNames: await pending,
    });
    const stack = { ...(diag.stack ?? { frameworks: [], signals: [] }), ...probe };
    await prisma.runPage.update({
      where: { id: p.id },
      data: { diagJson: { ...diag, stack } as unknown as object },
    });
    enriched++;
  }
  return { ok: true, pages: enriched, skipped };
}

/** Scheme + host + port — the unit a WAF rate-limits on, and so the unit we bucket by. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Pause before the escalated retry. A block is a verdict on the CLIENT — its IP,
 * its session, its missing anti-bot sensor cookie — so coming straight back only
 * confirms the pattern. Waiting first is part of what makes the retry work.
 */
const BLOCK_COOLDOWN_MS = 20_000;

/**
 * How many pages of the SAME origin may be blocked THROUGH the escalated retry
 * before the executor stops retrying for that origin at all. Only a block the
 * escalation could not rescue counts: while the warm headed session still gets
 * through, the origin is not refusing us. Past the budget the remaining pages
 * fail on their first attempt and are recaptured in a later run.
 */
const ORIGIN_BLOCK_BUDGET = 2;

/** Count one more block for an origin and return the new total. */
function bumpBlocked(counts: Map<string, number>, origin: string): number {
  const next = (counts.get(origin) ?? 0) + 1;
  counts.set(origin, next);
  return next;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type CaptureAttempt =
  | { ok: true; bundle: EvidenceBundle }
  | {
      ok: false;
      reason: string;
      /** One short line for the UI; `reason` keeps the full diagnosis for the server log. */
      summary: string;
      bundle: EvidenceBundle | null;
      kind: CaptureFailureKind;
    };

/** First line of a thrown error, trimmed — a stack trace has no place in the UI. */
function shortError(err: unknown): string {
  const line = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** One capture + health-check attempt, at one stealth level. Never throws. */
async function tryCapture(
  url: string,
  browser: BrowserProvider,
  device: Device,
  acceptCookies: boolean,
  mode: CaptureMode,
  profile: CaptureProfile,
): Promise<CaptureAttempt> {
  let bundle: EvidenceBundle;
  try {
    bundle = await collect(url, {
      browser,
      device,
      acceptCookies,
      mode,
      profile,
      // A "diag" capture scores nothing (docs/DIAGNOSTIC.md "Capture"), so CrUX
      // would be paid for and never read. Only the "maturity" profile needs it.
      cruxApiKey: profile === "maturity" ? process.env.CRUX_API_KEY : undefined,
    });
  } catch (err) {
    // A throw is a technical failure (launch/navigation/timeout), never a WAF verdict.
    return {
      ok: false,
      reason: String(err).slice(0, 500),
      summary: shortError(err),
      bundle: null,
      kind: "unusable",
    };
  }
  const health = assessCaptureHealth(bundle);
  if (!health.ok) {
    return {
      ok: false,
      reason: health.reason ?? "Capture rejected",
      summary: health.summary ?? "capture rejetée",
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
/**
 * Per-document character cap for a stored diag capture. Three documents at this
 * size stay comfortably inside a 1 MB MySQL packet alongside the rest of the
 * bundle, while being long enough to read a page's real structure.
 */
const DIAG_DOC_MAX = 120_000;

export function slimEvidence(b: EvidenceBundle, keepDocuments = false): object {
  // A diag run keeps a GENEROUS EXCERPT of its three documents rather than the
  // 2 KB stub, so a capture can be eyeballed after the fact — was the overlap low
  // because the page is client-side, or because our notion of "visible text" is
  // wrong? Changing a THRESHOLD needs none of this: the verdict carries its raw
  // measurements (DiagCheck.metrics), and a threshold is just a comparison
  // against a stored number. Only changing the MEASUREMENT METHOD needs the text.
  //
  // The excerpt is capped because MySQL's max_allowed_packet (1 MB on the dev
  // server) bounds a single row: three uncapped documents would fail the write on
  // any heavy page. `htmlBytes` still carries the true size, stamped at capture.
  if (keepDocuments) {
    return {
      ...b,
      rawHtml: b.rawHtml.slice(0, DIAG_DOC_MAX),
      renderedHtml: b.renderedHtml.slice(0, DIAG_DOC_MAX),
      bot: b.bot ? { ...b.bot, html: b.bot.html.slice(0, DIAG_DOC_MAX) } : null,
      browserDoc: b.browserDoc ? { ...b.browserDoc, html: b.browserDoc.html.slice(0, DIAG_DOC_MAX) } : null,
      // Request bodies/headers say nothing about SSR; the URLs are kept for the
      // stack fingerprint, everything else goes.
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
  return {
    ...b,
    // Truncating the document here is what makes `htmlBytes` (stamped at capture)
    // necessary: any control that needs the real HTML size must read that field,
    // never measure the stub below.
    rawHtml: b.rawHtml.slice(0, 2000),
    renderedHtml: "",
    browserDoc: null,
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

/**
 * Put every non-terminal run back into a truthful state. Called once at server
 * start: a run lives only in this process, so a run still marked RUNNING in the
 * DB when the process boots is by definition one whose executor died with it
 * (server stopped, crash, reboot). Left alone it shows a spinner that will never
 * advance; marked FAILED with the reason, it can be resumed — the pages already
 * captured are kept.
 */
export async function recoverStaleRuns(): Promise<number> {
  const stale = await prisma.run.findMany({
    where: { status: { in: ["RUNNING", "PENDING"] } },
    select: { id: true, donePages: true, totalPages: true },
  });
  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);
  // A page mid-capture when the process died has neither evidence nor score.
  await prisma.runPage.updateMany({
    where: { runId: { in: ids }, status: { in: ["RUNNING", "PENDING"] } },
    data: { status: "FAILED", error: "Interrompue par un arrêt du serveur." },
  });
  for (const r of stale) {
    await prisma.run.update({
      where: { id: r.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error:
          `Interrompu par un arrêt du serveur (${r.donePages}/${r.totalPages} pages capturées). ` +
          `« Reprendre » recapturera uniquement les pages manquantes.`,
      },
    });
  }
  return stale.length;
}

/** Pages of a run still to capture — what the resume button offers to finish. */
export async function pendingPageCount(runId: number): Promise<number> {
  return prisma.runPage.count({ where: { runId, status: { not: "DONE" } } });
}

/** The shape planResume needs from a RunPage — kept minimal so it stays testable. */
export interface ResumablePage {
  status: string;
  page: { siteId: number };
}

/**
 * Which pages a resume must capture: exactly those not already DONE. A page
 * captured by the interrupted attempt is never recaptured — its per-page score
 * was persisted (RunPage.topicsJson), and the site aggregate is rebuilt from the
 * per-page results rather than from the bundles, so the missing pages are all
 * that has to be paid for again. See engine.scoreSiteFromPages.
 */
export function planResume<T extends ResumablePage>(pages: T[]): T[] {
  return pages.filter((p) => p.status !== "DONE");
}

/** Sites that a resume has to re-aggregate: those owning at least one recaptured page. */
function sitesOf(pages: ResumablePage[]): Set<number> {
  return new Set(pages.map((p) => p.page.siteId));
}

/**
 * Shared launcher for a fresh start, a resume, and a single-site recapture.
 * Returns immediately.
 */
function launch(
  runId: number,
  opts: { resume?: boolean; siteId?: number },
): { started: boolean; reason?: string } {
  if (activeRunId !== null) {
    return { started: false, reason: `A run is already in progress (#${activeRunId})` };
  }
  activeRunId = runId;
  executeRun(runId, opts)
    .catch(async (err) => {
      console.error(`Run #${runId} crashed:`, err);
      // The executor died outside a page's own error handling. Without this the
      // run would stay RUNNING until the next server start, spinner and all.
      await prisma.run
        .update({
          where: { id: runId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `Exécution interrompue : ${String(err).slice(0, 1000)}`,
          },
        })
        .catch(() => {});
    })
    .finally(() => {
      activeRunId = null;
    });
  return { started: true };
}

/** Kick off a run asynchronously. Returns immediately. */
export function startRun(runId: number): { started: boolean; reason?: string } {
  return launch(runId, {});
}

/**
 * Continue a run that never finished. Sites already scored are left untouched;
 * every other site is recaptured whole — see executeRun for why a half-captured
 * site cannot be salvaged from the DB.
 */
export function resumeRun(runId: number): { started: boolean; reason?: string } {
  return launch(runId, { resume: true });
}

/**
 * Recapture ONE site of an existing run: every page of that site is captured
 * again — the pages already DONE included, since the point is to refresh a
 * result and not to finish an interrupted run — and the site aggregate is
 * rebuilt from them (settleSite). The other sites of the run are left strictly
 * untouched, and the run keeps its stored config (`resume: true` reuses
 * `configJson`) so a single ranking is never a mix of two scoring rules.
 */
export function recaptureSite(
  runId: number,
  siteId: number,
): { started: boolean; reason?: string } {
  return launch(runId, { resume: true, siteId });
}

async function executeRun(
  runId: number,
  opts: { resume?: boolean; siteId?: number } = {},
): Promise<void> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      runPages: { include: { page: { include: { site: true } } } },
      runSiteScores: { select: { siteId: true } },
    },
  });
  if (!run) return;

  // A "diag" run produces the prospect Speed/SEO diagnostic (docs/DIAGNOSTIC.md):
  // it scores nothing, so it skips the config/scoring/site-aggregate machinery
  // below entirely. Everything else — origin grouping, the capture pool, the
  // block-retry escalation — is shared with "maturity" runs unchanged.
  const isDiag = run.kind === "diag";
  const captureProfile: CaptureProfile = isDiag ? "diag" : "maturity";

  // On a resume the config MUST be the one the already-scored sites were graded
  // with, or a single ranking would mix two scoring rules. A diag run has no
  // scoring config at all.
  const config = isDiag
    ? ({} as ConfigMap)
    : opts.resume && run.configJson
      ? (run.configJson as unknown as ConfigMap)
      : await buildConfigMap();

  type SiteRef = (typeof run.runPages)[number]["page"]["site"];

  // A single-site recapture takes EVERY page of that site, DONE ones included:
  // it exists to refresh a result, where a resume exists to finish one.
  const toCapture =
    opts.siteId != null
      ? run.runPages.filter((rp) => rp.page.siteId === opts.siteId)
      : opts.resume
        ? planResume(run.runPages)
        : [...run.runPages];
  const keptPages = run.runPages.length - toCapture.length;

  if (toCapture.length === 0) {
    // Scoped to a site holding no page: the run's own state says nothing new.
    if (opts.siteId != null) return;
    await prisma.run.update({
      where: { id: runId },
      data: { status: "DONE", finishedAt: new Date(), error: null },
    });
    return;
  }

  await prisma.run.update({
    where: { id: runId },
    data: {
      status: "RUNNING",
      // A resume continues the same run, so it keeps its original start time.
      startedAt: opts.resume ? (run.startedAt ?? new Date()) : new Date(),
      finishedAt: null,
      error: null,
      configJson: config as object,
      // Stamp a diag run with the rules that produced it, so a result scored by
      // code that has since changed can be SEEN rather than trusted. Never
      // overwritten: a resume keeps its original stamp, because its already-DONE
      // pages really were scored by those rules.
      ...(isDiag && !run.rulesVersion ? { rulesVersion: diagRulesVersion() } : {}),
      totalPages: run.runPages.length,
      donePages: keptPages,
    },
  });
  // Pages about to be (re)captured go back to PENDING so the live table is honest.
  await prisma.runPage.updateMany({
    where: { id: { in: toCapture.map((rp) => rp.id) } },
    data: { status: "PENDING", error: null },
  });

  const device: Device = run.device === "desktop" ? "desktop" : "mobile";
  const browser = asProvider(run.browser);

  // On a cold cache the stealth Chromium still has to be downloaded. Waiting for
  // the single warm-up here is what keeps the parallel captures below from each
  // starting their own download and deleting one another's install.
  if (browser === "cloak") await ensureCloakBinary();

  /** Pages left to capture per site — a site reaching 0 is aggregated immediately. */
  const remainingBySite = new Map<number, number>();
  for (const rp of toCapture) {
    remainingBySite.set(rp.page.siteId, (remainingBySite.get(rp.page.siteId) ?? 0) + 1);
  }
  /** Blocked pages per origin — feeds the per-origin retry budget below. */
  const blocksByOrigin = new Map<string, number>();
  /**
   * Diag only: CrUX mobile origin p75, queried ONCE per origin for the run (every
   * page of a site shares the record). The promise is cached so parallel pages of
   * the same origin wait on one request instead of each firing their own.
   */
  const cwvByOrigin = new Map<string, Promise<CwvSummary | null | undefined>>();
  const originCwv = (url: string): Promise<CwvSummary | null | undefined> => {
    let key: string;
    try {
      key = new URL(url).origin;
    } catch {
      return Promise.resolve(undefined);
    }
    let p = cwvByOrigin.get(key);
    if (!p) {
      p = fetchOriginCwv(url, process.env.CRUX_API_KEY);
      cwvByOrigin.set(key, p);
    }
    return p;
  };
  /** Diag only: the page of each site that carries CWV and audience (the home). */
  const repBySite = representativePages(
    run.runPages.map((rp) => ({ id: rp.id, siteId: rp.page.siteId, url: rp.url, kind: rp.page.kind })),
  );
  /** Diag only: same once-per-origin memo for the audience (mobile share). */
  const audienceByOrigin = new Map<string, Promise<AudienceSummary | undefined>>();
  const originAudience = (url: string): Promise<AudienceSummary | undefined> => {
    const key = originOf(url);
    let p = audienceByOrigin.get(key);
    if (!p) {
      p = fetchOriginAudience(url, process.env.CRUX_API_KEY, !!cruxBqConfig());
      audienceByOrigin.set(key, p);
    }
    return p;
  };

  /**
   * One page of `site` is settled (captured or failed). When it was the last one,
   * the site aggregate is computed and persisted RIGHT THERE rather than at the
   * end of the run — an interrupted run then keeps every site it had completed.
   *
   * The aggregate is rebuilt from the PER-PAGE scores stored in the DB, not from
   * the bundles: that is what lets a resume mix pages captured before the
   * interruption with pages captured after it, and it means no bundle has to be
   * held in memory until the site is done. The rule is identical either way —
   * see engine.scoreSiteFromPages.
   */
  const settleSite = async (site: SiteRef): Promise<void> => {
    const left = (remainingBySite.get(site.id) ?? 1) - 1;
    remainingBySite.set(site.id, left);
    if (left > 0) return;
    // A diag run scores nothing, so there is no RunSiteScore to (re)build — the
    // per-page RunPage.diagJson rows already written are the whole result.
    if (isDiag) return;

    // Same rebuild the UI runs after a manual correction — see web/site-score.ts.
    // `config` is passed so the site keeps the run's config snapshot.
    await rebuildSiteScore(runId, site.id, config);
  };

  /**
   * Capture, score and persist ONE page. A page that cannot be captured is
   * recorded as FAILED and the run carries on; only a persistence failure can
   * escape, and the pool below catches that.
   */
  const capturePage = async (rp: (typeof run.runPages)[number]): Promise<void> => {
    const site = rp.page.site;
    await prisma.runPage.update({ where: { id: rp.id }, data: { status: "RUNNING" } });

    // The provider NEVER changes: CloakBrowser is already the most human-like
    // client we have, so retrying with a weaker Chromium could only do worse.
    // What a failed page gets instead is ONE retry with the SAME browser turned
    // up to everything its vendor prescribes against a challenge — headed,
    // humanize/careful, warm per-origin profile (see CaptureMode). Past the
    // per-origin block budget even that is skipped: the WAF has made up its mind
    // about this IP, and a second hit per page would only harden it further.
    let attempt = await tryCapture(
      rp.url,
      browser,
      device,
      run.acceptCookies,
      "standard",
      captureProfile,
    );
    let mode: CaptureMode = "standard";
    let firstSummary: string | null = null;
    let noRetry = false;

    if (!attempt.ok) {
      firstSummary = attempt.summary;
      console.warn(`[run ${runId}] ${rp.url} [standard] ${attempt.reason}`);
      const origin = originOf(rp.url);
      const spent = blocksByOrigin.get(origin) ?? 0;

      if (attempt.kind === "blocked" && spent >= ORIGIN_BLOCK_BUDGET) {
        // The WAF has made up its mind about this client: another headed session
        // would only harden it. Recapture the brand later, from another exit IP.
        noRetry = true;
      } else {
        // Coming straight back after a block just hands the WAF another data point.
        if (attempt.kind === "blocked") await sleep(BLOCK_COOLDOWN_MS);
        mode = "escalated";
        attempt = await tryCapture(
          rp.url,
          browser,
          device,
          run.acceptCookies,
          "escalated",
          captureProfile,
        );
        // Only a block the ESCALATION could not rescue spends budget: as long as the
        // warm headed session still gets through, the origin is not refusing us.
        if (!attempt.ok && attempt.kind === "blocked") bumpBlocked(blocksByOrigin, origin);
      }
    }

    const bundle = attempt.ok ? attempt.bundle : null;

    if (!bundle) {
      const failed = attempt as Extract<CaptureAttempt, { ok: false }>;
      if (mode === "escalated") {
        console.warn(`[run ${runId}] ${rp.url} [escalated] ${failed.reason}`);
      }
      // One short line: the full diagnosis is in the server log.
      const label = failed.kind === "blocked" ? "Bloqué" : "Échec";
      const detail =
        mode === "escalated" && failed.summary !== firstSummary
          ? `${firstSummary}, puis ${failed.summary} au retry`
          : failed.summary;
      const pageError =
        `${label} : ${detail}` + (noRetry ? " (pas de retry, origine déjà bloquée)" : "");
      await prisma.runPage.update({
        where: { id: rp.id },
        data: {
          status: "FAILED",
          error: pageError.slice(0, 2000),
          evidenceJson: failed.bundle ? slimEvidence(failed.bundle, isDiag) : undefined,
        },
      });
      await prisma.run.update({ where: { id: runId }, data: { donePages: { increment: 1 } } });
      await settleSite(site);
      return;
    }


    if (isDiag) {
      // No scoring: run the verdict engine and persist PageDiagnostic straight
      // onto RunPage.diagJson. No topicsJson/overall/geo/china, no RunSiteScore.
      const diagnostic = diagnosePage(bundle, rp.page.label || rp.page.kind);
      // Keyed on the LANDED url: a bare domain redirecting to www. has no record.
      // CWV and audience are site-level: queried on the site's home only (see
      // representativeDonePages). Ranks are added at the end of the run, in one
      // BigQuery query for all origins.
      if (repBySite.get(rp.page.siteId) === rp.id) {
        const cwv = await originCwv(bundle.finalUrl || rp.url);
        if (cwv !== undefined) diagnostic.cwv = cwv;
        const audience = await originAudience(bundle.finalUrl || rp.url);
        if (audience) diagnostic.audience = audience;
      }
      await prisma.runPage.update({
        where: { id: rp.id },
        data: {
          status: "DONE",
          error: null,
          evidenceJson: slimEvidence(bundle, isDiag),
          diagJson: diagnostic as unknown as object,
        },
      });
      await prisma.run.update({
        where: { id: runId },
        data: { donePages: { increment: 1 } },
      });
      await settleSite(site);
      return;
    }

    // Score this page right away so the UI can show its criteria live, and so the
    // site aggregate can be rebuilt from these stored results later (settleSite).
    const scoringMode = modeOfKind(rp.page.kind);
    const pageResult = scorePage(bundle, TOPICS, config, scoringMode);
    await prisma.runPage.update({
      where: { id: rp.id },
      data: {
        status: "DONE",
        mode: scoringMode,
        // Only an escalated capture has a story to tell: it says WHY the standard
        // attempt failed, and warns that a warm profile weakens Topic 4 evidence.
        error: null,
        evidenceJson: slimEvidence(bundle, isDiag),
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
    await settleSite(site);
  };

  // Parallelism is BY ORIGIN: each bucket holds every page of one origin and is
  // captured sequentially, buckets run side by side. Widening the pool therefore
  // adds brands in flight, never simultaneous hits on a single WAF — which is
  // exactly the pattern that hardened Akamai against this client (see browser.ts).
  const buckets = groupByOrigin(toCapture, (rp) => originOf(rp.url));
  const { slots, warning } = captureConcurrencyFromEnv();
  if (warning) console.warn(`Run #${runId}: ${warning}`);
  // Throttling is off by default; log it either way, so a run's timings can always
  // be read against the conditions they were measured in.
  const throttling = captureThrottlingFromEnv();
  if (throttling.warning) console.warn(`Run #${runId}: ${throttling.warning}`);
  console.log(`Run #${runId}: throttling — ${describeThrottling(throttling)}`);
  console.log(
    `Run #${runId}${
      opts.siteId != null
        ? ` (recapture site #${opts.siteId})`
        : opts.resume
          ? " (resume)"
          : ""
    }: ${toCapture.length} page(s) over ` +
      `${buckets.length} origin(s), ${Math.min(slots, buckets.length)} captured in parallel` +
      (opts.resume
        ? ` — ${keptPages} page(s) already captured, kept; ` +
          `${sitesOf(toCapture).size} site(s) to re-aggregate`
        : ""),
  );

  await runPool(
    buckets.map((bucket) => async () => {
      for (const rp of bucket) {
        // The pool must survive a page whose own error handling failed (a DB write,
        // typically) — otherwise one page would abort the sibling origins too.
        await capturePage(rp).catch((err) =>
          console.error(`Run #${runId}: page #${rp.id} (${rp.url}) crashed:`, err),
        );
      }
    }),
    slots,
  );

  const rankWarning = isDiag ? await attachCruxRanks(runId) : null;

  // Truth comes from the DB, not from this process: on a resume the sites scored
  // by the earlier attempt count too. A diag run writes no RunSiteScore at all
  // (it scores nothing), so its success is judged from DONE pages instead.
  const [scored, missed] = await Promise.all([
    isDiag
      ? prisma.runPage.count({ where: { runId, status: "DONE" } })
      : prisma.runSiteScore.count({ where: { runId } }),
    prisma.runPage.count({ where: { runId, status: { not: "DONE" } } }),
  ]);
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: scored > 0 ? "DONE" : "FAILED",
      finishedAt: new Date(),
      error:
        scored === 0
          ? "All pages failed to capture"
          : missed > 0
            ? `${missed} page(s) non capturée(s) — « Reprendre » ne recapturera que celles-là.`
            : null,
      // Rewritten on every pass: a resume whose rank query succeeds clears it.
      warning: rankWarning,
    },
  });
}
