import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { activeRun, enrichRunAudience, enrichRunTechno, resumeRun, recaptureSite } from "../runner";
import { parseClientId, listClients } from "../clients";
import { renderCsv } from "../../engine/report";
import {
  rescorePageFromVerdicts,
  countPendingConfirmations,
  emptyPageTopics,
  emptySiteTopics,
} from "../../engine";
import type { ConfigMap } from "../../engine";
import { buildConfigMap } from "../config-store";
import { rebuildSiteScore } from "../site-score";
import { TOPICS } from "../../topics";
import type { PageScoringMode, SiteResult, TopicResult } from "../../core/types";
import { isChinaKind, PAGE_KINDS } from "../categories";
import {
  applyManualDiagCheck,
  rescorePageDiagnostic,
  countPendingDiagConfirmations,
  siteDiagnostic,
  type DiagManualVerdict,
} from "../../prospect/verdict";
import { rulesFreshness, diagRulesVersion } from "../../prospect/rules-version";
import { renderDiagCsv, type DiagCsvPage } from "../../prospect/report";
import type { DiagCheckId, PageDiagnostic } from "../../prospect/types";

/**
 * Criteria whose verdict is computed FROM the other topics (topic 12's
 * "sitespeed basics"), and so cannot be corrected by hand: the engine rewrites
 * them on every re-score. The views grey them out.
 */
const DERIVED_CONTROL_IDS = TOPICS.flatMap((t) =>
  t.controls.filter((c) => c.derivedFromTopics === true).map((c) => c.id),
);


/**
 * The per-page criteria of a captured page, or — for a page the run never
 * managed to capture — the empty skeleton an operator can grade by hand.
 *
 * A run interrupted (or WAF-blocked) on one page used to leave that page with no
 * criteria at all: no column in the site view, nothing to click, and a site
 * whose standard block stayed N/A for good. Handing back a skeleton keeps the
 * manual-correction route the ONLY way a verdict is ever set by hand, on
 * captured and uncaptured pages alike.
 */
function pageTopicsOf(
  rp: { topicsJson: unknown; mode: string },
  config: ConfigMap,
): TopicResult[] {
  if (rp.topicsJson !== null) return rp.topicsJson as unknown as TopicResult[];
  return emptyPageTopics(TOPICS, config, modeOf(rp));
}

function modeOf(rp: { mode: string }): PageScoringMode {
  return rp.mode === "china" ? "china" : "standard";
}

/**
 * A run's pages in reading order: grouped by site (alphabetical), then HP → PLP →
 * PDP → CHINA → OTHER within a site. Capture order (runPage id) interleaves the
 * sites, which scattered one site's URLs across the run views' page lists.
 */
export function sortRunPagesBySite<
  T extends { id: number; page: { kind: string; siteId: number; site: { name: string } } },
>(runPages: T[]): T[] {
  const kindRank = (k: string) => {
    const i = (PAGE_KINDS as readonly string[]).indexOf(k);
    return i === -1 ? PAGE_KINDS.length : i;
  };
  return [...runPages].sort(
    (a, b) =>
      a.page.site.name.localeCompare(b.page.site.name) ||
      a.page.siteId - b.page.siteId ||
      kindRank(a.page.kind) - kindRank(b.page.kind) ||
      a.id - b.id,
  );
}

/** The rules this run was graded by — never the current settings (see resumeRun). */
async function runConfig(runId: number): Promise<ConfigMap> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { configJson: true },
  });
  return (run?.configJson as unknown as ConfigMap | null) ?? (await buildConfigMap());
}

/** One page's diagnostic within a run's per-site grouping, as the diag views render it. */
export interface DiagRunPageView {
  runPageId: number;
  url: string;
  label: string;
  status: string;
  /** The run never captured this page (WAF block, interrupted run) — no checks to show. */
  captured: boolean;
  diag: PageDiagnostic | null;
}

export interface DiagSiteView {
  siteId: number;
  siteName: string;
  pages: DiagRunPageView[];
  /** The site's pages don't all reach the same verdict — see docs/DIAGNOSTIC.md "Granularité". */
  divergent: boolean;
  /** Checks still « à confirmer » across this site's captured pages. */
  pending: number;
}

/**
 * Group a "diag" run's pages by site and derive each site's `divergent` flag
 * straight from the stored `PageDiagnostic`s (prospect/verdict.ts:siteDiagnostic)
 * — a diag run writes no RunSiteScore (see runner.ts settleSite), so there is no
 * aggregate table to read this from.
 */
function diagSitesOf(
  runPages: {
    id: number;
    url: string;
    status: string;
    diagJson: unknown;
    page: {
      siteId: number;
      label: string | null;
      kind: string;
      site: { id: number; name: string };
    };
  }[],
): DiagSiteView[] {
  const bySite = new Map<number, DiagSiteView>();
  for (const rp of runPages) {
    const siteId = rp.page.siteId;
    let g = bySite.get(siteId);
    if (!g) {
      g = { siteId, siteName: rp.page.site.name, pages: [], divergent: false, pending: 0 };
      bySite.set(siteId, g);
    }
    const diag = (rp.diagJson as unknown as PageDiagnostic | null) ?? null;
    g.pages.push({
      runPageId: rp.id,
      url: rp.url,
      label: rp.page.label || rp.page.kind,
      status: rp.status,
      captured: diag !== null,
      diag,
    });
  }
  for (const g of bySite.values()) {
    const captured = g.pages
      .map((p) => p.diag)
      .filter((d): d is PageDiagnostic => d !== null);
    g.divergent = siteDiagnostic(g.siteName, captured).divergent;
    g.pending = countPendingDiagConfirmations(captured);
  }
  return [...bySite.values()].sort((a, b) => a.siteName.localeCompare(b.siteName));
}

export async function runRoutes(app: FastifyInstance) {
  app.get("/runs", async (req, reply) => {
    const clientId = parseClientId((req.query as any)?.client);
    const [runs, clients] = await Promise.all([
      prisma.run.findMany({
        where: clientId !== null ? { project: { clientId } } : undefined,
        orderBy: { createdAt: "desc" },
        include: {
          project: { include: { client: true } },
          _count: { select: { runSiteScores: true } },
        },
      }),
      listClients(),
    ]);
    // Pages left to capture per run — a non-zero count is what makes a run resumable.
    const pending = await prisma.runPage.groupBy({
      by: ["runId"],
      where: { runId: { in: runs.map((r) => r.id) }, status: { not: "DONE" } },
      _count: { _all: true },
    });
    const pendingByRun = new Map(pending.map((p) => [p.runId, p._count._all]));

    return reply.view("run-list", {
      active: "runs",
      title: "Runs",
      runs,
      clients,
      selectedClientId: clientId,
      activeRunId: activeRun(),
      pendingByRun,
    });
  });

  app.get("/runs/:id", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({
      where: { id },
      include: {
        project: true,
        runSiteScores: { include: { site: true } },
        runPages: {
          include: { page: { include: { site: true } } },
          orderBy: { id: "asc" },
        },
      },
    });
    if (!run) return reply.code(404).send("Run not found");
    run.runPages = sortRunPagesBySite(run.runPages);

    const ranking = [...run.runSiteScores].sort(
      (a, b) => (b.overall ?? -1) - (a.overall ?? -1),
    );
    const byCategory: Record<string, any[]> = {};
    for (const s of ranking) (byCategory[s.category] ??= []).push(s);

    // siteId → criteria still « à confirmer » (both families of page), so the
    // ranking can mark a score as provisional without opening the site detail.
    const pendingBySite: Record<number, number> = {};
    for (const s of ranking) {
      pendingBySite[s.siteId] =
        countPendingConfirmations(s.topicsJson as unknown as TopicResult[]) +
        countPendingConfirmations((s.chinaTopicsJson as unknown as TopicResult[]) ?? null);
    }

    // Sites present in the run but with no aggregate: every one of their pages
    // failed to capture, so they never appear in the ranking. They are listed
    // apart, because their per-site page is where an operator grades them by hand.
    const scoredSiteIds = new Set(ranking.map((s) => s.siteId));
    const unscoredSites = [
      ...new Map(
        run.runPages
          .filter((rp) => !scoredSiteIds.has(rp.page.siteId))
          .map((rp) => [rp.page.siteId, rp.page.site]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name));

    // A "diag" run scores nothing (no RunSiteScore rows — see runner.ts
    // settleSite, which returns early for isDiag) — build the per-site summary
    // straight from each page's stored PageDiagnostic instead.
    const isDiagRun = run.kind === "diag";
    const diagSites = isDiagRun ? diagSitesOf(run.runPages) : [];
    const diagPending = diagSites.reduce((n, s) => n + s.pending, 0);

    return reply.view("run-detail", {
      active: "runs",
      title: `Run #${run.id}`,
      run,
      isDiagRun,
      diagSites,
      diagPending,
      // Were these results produced by the rules running now? A diag verdict
      // scored by code that has since changed looks identical to a fresh one.
      diagRules: isDiagRun
        ? { freshness: rulesFreshness(run.rulesVersion), stored: run.rulesVersion, current: diagRulesVersion() }
        : null,
      ranking,
      byCategory,
      pendingBySite,
      unscoredSites,
      // A run is live only if THIS process is executing it; a RUNNING row that is
      // not the active run is a leftover from a previous server (see recoverStaleRuns).
      isLive: activeRun() === run.id,
      pendingPages: run.runPages.filter((rp) => rp.status !== "DONE").length,
      flash: (req.query as any)?.flash ?? null,
    });
  });

  // Continue a run that never finished: keeps the sites already scored, recaptures
  // the rest. See runner.resumeRun.
  app.post("/runs/:id/resume", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({ where: { id }, select: { id: true } });
    if (!run) return reply.code(404).send("Run not found");

    const left = await prisma.runPage.count({ where: { runId: id, status: { not: "DONE" } } });
    if (left === 0) {
      return reply.redirect(`/runs/${id}?flash=${encodeURIComponent("Ce run est déjà complet.")}`);
    }
    const res = resumeRun(id);
    if (!res.started) {
      return reply.redirect(`/runs/${id}?flash=${encodeURIComponent(res.reason ?? "Reprise impossible")}`);
    }
    return reply.redirect(`/runs/${id}`);
  });

  // Diag: compute the Audience column (CrUX popularity) of a finished run without
  // recapturing — the audience depends on the origin only. See runner.enrichRunAudience.
  app.post("/runs/:id/audience", async (req, reply) => {
    const id = Number((req.params as any).id);
    const res = await enrichRunAudience(id);
    const msg = !res.ok
      ? res.reason
      : res.warning
        ? `Audience calculée sur ${res.pages} page(s), sans le rang (voir l'avertissement).`
        : `Audience calculée sur ${res.pages} page(s).`;
    return reply.redirect(`/runs/${id}?flash=${encodeURIComponent(msg)}`);
  });

  // Diag: compute the web-application + CDN/WAF lines of the Techno column on a
  // finished run from its stored evidence. See runner.enrichRunTechno.
  app.post("/runs/:id/techno", async (req, reply) => {
    const id = Number((req.params as any).id);
    const res = await enrichRunTechno(id);
    const msg = !res.ok
      ? res.reason
      : `Analyse technique (app web, CDN/WAF) faite sur ${res.pages} page(s)` +
        (res.skipped ? `, ${res.skipped} sans evidence stockée ignorée(s).` : ".");
    return reply.redirect(`/runs/${id}?flash=${encodeURIComponent(msg)}`);
  });

  // Per-site maturity results as CSV (same format as the engine report / out/*.csv).
  app.get("/runs/:id/export.csv", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({
      where: { id },
      include: { runSiteScores: { include: { site: true } } },
    });
    if (!run) return reply.code(404).send("Run not found");

    // A diag run writes no RunSiteScore at all — it scores nothing — so its
    // export is built from the per-page diagnostics instead, one row per page.
    if (run.kind === "diag") {
      const runPages = await prisma.runPage.findMany({
        where: { runId: id },
        include: { page: { include: { site: true } } },
        orderBy: { id: "asc" },
      });
      const rows: DiagCsvPage[] = runPages.map((rp) => ({
        site: rp.page.site.name,
        url: rp.url,
        status: rp.status,
        diag: (rp.diagJson as unknown as PageDiagnostic | null) ?? null,
      }));
      const day = (run.finishedAt ?? run.createdAt).toISOString().slice(0, 10);
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="run-${run.id}-${day}-diagnostic.csv"`,
        )
        .send(renderDiagCsv(rows));
    }

    const results = [...run.runSiteScores]
      .sort((a, b) => a.site.name.localeCompare(b.site.name))
      .map(
        (s): Pick<SiteResult, "site" | "topics" | "chinaTopics" | "chinaOverall"> => ({
          site: s.site.name,
          topics: (s.topicsJson as unknown as TopicResult[]) ?? [],
          // China pages are a separate block in the CSV, never merged with the rest.
          chinaTopics: (s.chinaTopicsJson as unknown as TopicResult[]) ?? null,
          chinaOverall: s.chinaOverall,
        }),
      );

    const csv = renderCsv(results as SiteResult[]);
    const date = (run.finishedAt ?? run.createdAt).toISOString().slice(0, 10);
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="run-${run.id}-${date}-maturity.csv"`,
      )
      .send(csv);
  });

  // HTMX poll partial: live per-page results while running; once terminal, refresh page.
  app.get("/runs/:id/status", async (req, reply) => {
    const id = Number((req.params as any).id);
    const run = await prisma.run.findUnique({
      where: { id },
      include: {
        runPages: {
          include: { page: { include: { site: true } } },
          orderBy: { id: "asc" },
        },
      },
    });
    if (!run) return reply.code(404).send("");
    run.runPages = sortRunPagesBySite(run.runPages);
    // Terminal, or RUNNING with nobody executing it (a run left over by a previous
    // server process): either way there is nothing more to poll — reload the page.
    if (run.status === "DONE" || run.status === "FAILED" || activeRun() !== run.id) {
      reply.header("HX-Refresh", "true");
      return reply.send("");
    }
    return reply.view("partials/run-progress", { run });
  });

  // On-demand criteria detail for one captured page (available as soon as the
  // page is scored, i.e. before the run finishes).
  // One page's diagnostic detail, served for the accordion under its row in the
  // diag table. Same partial the dedicated site view uses, so both stay in step.
  app.get("/runs/:id/pages/:runPageId/diag", async (req, reply) => {
    const id = Number((req.params as any).id);
    const runPageId = Number((req.params as any).runPageId);
    const rp = await prisma.runPage.findFirst({
      where: { id: runPageId, runId: id },
      include: { page: { include: { site: true } } },
    });
    if (!rp) return reply.code(404).send("");
    const diag = (rp.diagJson as unknown as PageDiagnostic | null) ?? null;
    const view: DiagRunPageView = {
      runPageId: rp.id,
      url: rp.url,
      label: rp.page.label || rp.page.kind,
      status: rp.status,
      captured: diag !== null,
      diag,
    };
    return reply.view("partials/diag-page-detail", { runId: id, p: view });
  });

  app.get("/runs/:id/pages/:runPageId/criteria", async (req, reply) => {
    const id = Number((req.params as any).id);
    const runPageId = Number((req.params as any).runPageId);
    const rp = await prisma.runPage.findFirst({
      where: { id: runPageId, runId: id },
      include: { page: { include: { site: true } } },
    });
    if (!rp) return reply.code(404).send("");
    // An uncaptured page gets the empty skeleton, so it can be graded by hand.
    const config = await runConfig(id);
    const pageTopics = pageTopicsOf(rp, config);
    return reply.view("partials/run-page-criteria", {
      runId: id,
      runPageId: rp.id,
      pageLabel: `${rp.page.site.name} — ${rp.page.label || rp.page.kind}`,
      pageUrl: rp.url,
      pageTopics,
      captured: rp.topicsJson !== null,
      derivedIds: DERIVED_CONTROL_IDS,
      // « provisoire » badge: criteria the engine could not measure and nobody
      // has arbitrated yet.
      pendingCount: countPendingConfirmations(pageTopics),
    });
  });

  // Manual correction of ONE check (ssr.user | ssr.bot) on ONE diagnosed page:
  // same shape as the maturity correction route below (manual/auto fields,
  // "↺ mesuré" reset via verdict=auto) but operating on prospect/verdict.ts's
  // DiagCheck[] instead of a Control's TopicResult[]. There is no N/A here — a
  // check is always either measured or "à confirmer", never inapplicable.
  //
  // Deliberately NOT persisted anywhere but in the page's own diagJson —
  // recapturing the page recomputes it from the bundle and the correction is
  // gone, exactly like the maturity side.
  app.post("/runs/:id/pages/:runPageId/checks/:checkId", async (req, reply) => {
    const id = Number((req.params as any).id);
    const runPageId = Number((req.params as any).runPageId);
    const checkId = String((req.params as any).checkId);
    const verdict = String((req.body as any)?.verdict ?? "");
    if (checkId !== "ssr.user" && checkId !== "ssr.bot") {
      return reply.code(400).send("checkId doit être ssr.user ou ssr.bot");
    }
    if (!["pass", "fail", "auto"].includes(verdict)) {
      return reply.code(400).send("verdict must be pass | fail | auto");
    }

    const rp = await prisma.runPage.findFirst({
      where: { id: runPageId, runId: id },
      select: { id: true, diagJson: true },
    });
    if (!rp) return reply.code(404).send("Page inconnue");
    if (rp.diagJson === null) return reply.code(404).send("Page non diagnostiquée");

    const diag = rp.diagJson as unknown as PageDiagnostic;
    const checks = applyManualDiagCheck(
      diag.checks,
      checkId as DiagCheckId,
      verdict as DiagManualVerdict,
    );
    const rescored = rescorePageDiagnostic({ ...diag, checks });

    await prisma.runPage.update({
      where: { id: rp.id },
      data: { diagJson: rescored as unknown as object },
    });
    // No RunSiteScore to rebuild for a diag run (see runner.ts settleSite) — the
    // site view re-derives `divergent`/pending from the pages' diagJson each time.
    return reply.code(204).send();
  });

  // Manual correction of ONE criterion on ONE captured page: the operator
  // re-checked the test and disagrees with the measured verdict.
  //
  // Deliberately NOT persisted anywhere but in the page's own stored result —
  // recapturing the page (or re-running the project) recomputes it from the
  // bundle and the correction is gone. That is the intended lifetime: it fixes
  // a reading of THIS capture, it is not a rule.
  app.post("/runs/:id/pages/:runPageId/criteria/:controlId", async (req, reply) => {
    const id = Number((req.params as any).id);
    const runPageId = Number((req.params as any).runPageId);
    const controlId = String((req.params as any).controlId);
    const verdict = String((req.body as any)?.verdict ?? "");
    if (!["pass", "fail", "na", "auto"].includes(verdict)) {
      return reply.code(400).send("verdict must be pass | fail | na | auto");
    }

    const rp = await prisma.runPage.findFirst({
      where: { id: runPageId, runId: id },
      include: { page: { select: { siteId: true } }, run: { select: { configJson: true } } },
    });
    if (!rp) return reply.code(404).send("Page inconnue");

    // The run's own config, exactly as a resume/recapture does: a corrected page
    // must stay graded by the same rules as its siblings — and it is also what
    // shapes the skeleton of a page that was never captured.
    const config = (rp.run.configJson as unknown as ConfigMap | null) ?? (await buildConfigMap());
    // A page the run never captured has no stored criteria: it is graded from the
    // empty skeleton, which this first correction persists.
    const topics = pageTopicsOf(rp, config);
    const control = topics
      .flatMap((t) => t.controls ?? [])
      .find((c) => c.controlId === controlId);
    if (!control) return reply.code(404).send("Critère absent de cette page");

    if (verdict === "auto") {
      // Undo: only possible while the measured verdict is still stashed.
      if (!control.auto) return reply.code(409).send("Aucun verdict mesuré à restaurer");
      control.applicable = control.auto.applicable;
      control.passed = control.auto.passed;
      control.evidence = control.auto.evidence;
      // A criterion the engine could not measure goes back to « à confirmer ».
      if (control.auto.unknown === true) control.unknown = true;
      else delete control.unknown;
      delete control.manual;
      delete control.auto;
    } else {
      // Stashed on the FIRST correction only, so a second one does not lose the
      // engine's original verdict.
      control.auto ??= {
        applicable: control.applicable,
        passed: control.passed,
        evidence: control.evidence,
        // Remembered so « ↺ mesuré » restores the "à confirmer" state too.
        ...(control.unknown === true ? { unknown: true } : {}),
      };
      const was = control.auto.applicable ? (control.auto.passed ? "✓" : "✗") : "N/A";
      control.applicable = verdict !== "na";
      control.passed = verdict === "pass";
      control.manual = true;
      control.evidence = `Corrigé manuellement (mesuré : ${was} — ${control.auto.evidence})`;
    }

    const rescored = rescorePageFromVerdicts(
      {
        url: rp.url,
        mode: modeOf(rp),
        topics,
        overall: rp.overall,
        geo: rp.geo,
        china: rp.china,
      },
      TOPICS,
      config,
    );
    await prisma.runPage.update({
      where: { id: rp.id },
      data: {
        topicsJson: rescored.topics as unknown as object,
        overall: rescored.overall,
        geo: rescored.geo,
        china: rescored.china,
      },
    });
    // The site aggregate is a pure function of its pages' verdicts — rebuild it.
    await rebuildSiteScore(id, rp.page.siteId, config);

    return reply.code(204).send();
  });

  app.get("/runs/:id/sites/:siteId", async (req, reply) => {
    const id = Number((req.params as any).id);
    const siteId = Number((req.params as any).siteId);

    // A "diag" run has no RunSiteScore/topicsJson at all — its per-site page is
    // built straight from the pages' PageDiagnostic, via a dedicated view.
    const kindRow = await prisma.run.findUnique({ where: { id }, select: { kind: true } });
    if (!kindRow) return reply.code(404).send("Run not found");
    if (kindRow.kind === "diag") {
      const [site, runPages] = await Promise.all([
        prisma.site.findUnique({ where: { id: siteId } }),
        prisma.runPage.findMany({
          where: { runId: id, page: { siteId } },
          include: { page: { include: { site: true } } },
          orderBy: { id: "asc" },
        }),
      ]);
      if (!site || runPages.length === 0) {
        return reply.code(404).send("Ce site n'a aucune page dans ce run");
      }
      const [group] = diagSitesOf(runPages);
      return reply.view("run-site-detail-diag", {
        active: "runs",
        title: `${site.name} — Run #${id}`,
        runId: id,
        site,
        pages: group?.pages ?? [],
        divergent: group?.divergent ?? false,
        pending: group?.pending ?? 0,
        isLive: activeRun() !== null,
        flash: (req.query as any)?.flash ?? null,
      });
    }

    const [stored, runPages] = await Promise.all([
      prisma.runSiteScore.findUnique({
        where: { runId_siteId: { runId: id, siteId } },
        include: { site: true },
      }),
      // Per-page scores for the column breakdown (in capture order).
      prisma.runPage.findMany({
        where: { runId: id, page: { siteId } },
        include: { page: true },
        orderBy: { id: "asc" },
      }),
    ]);
    // A site whose every page failed to capture has NO RunSiteScore at all — it
    // is absent from the ranking, and this page used to 404 on it, which left it
    // ungradable. Its pages are what make it part of the run, so they are what
    // this route requires; the aggregate is stood in for until the first manual
    // verdict creates the real row (see rebuildSiteScore).
    const site = stored?.site ?? (await prisma.site.findUnique({ where: { id: siteId } }));
    if (!site || (!stored && runPages.length === 0)) {
      return reply.code(404).send("Ce site n'a ni score ni page dans ce run");
    }
    const score = stored ?? {
      runId: id,
      siteId,
      site,
      category: site.category,
      overall: null,
      geo: null,
      china: null,
      chinaOverall: null,
      topicsJson: emptySiteTopics(TOPICS) as unknown as object,
      // The China block only renders when the site has China pages to grade.
      chinaTopicsJson: runPages.some((rp) => rp.mode === "china" || isChinaKind(rp.page.kind))
        ? (emptySiteTopics(TOPICS) as unknown as object)
        : null,
    };
    // Uncaptured pages are shown with the empty skeleton rather than dropped:
    // a run blocked on a page must still be gradable by hand.
    const config = await runConfig(id);
    const pages = runPages.map((rp) => {
      const topics = pageTopicsOf(rp, config);
      return {
        // RunPage id: what a manual correction of one criterion targets.
        runPageId: rp.id,
        label: rp.page.label || rp.page.kind,
        url: rp.url,
        status: rp.status,
        // Grading family of the page: the two are displayed in separate blocks.
        isChina: rp.mode === "china" || isChinaKind(rp.page.kind),
        // A page nobody could capture: its criteria are all « à confirmer », and
        // the view labels the column so its verdicts are not read as measurements.
        captured: rp.topicsJson !== null,
        overall: rp.overall,
        geo: rp.geo,
        china: rp.china,
        topics: topics as any[],
        // Criteria still « à confirmer » on this page → its score is provisional.
        pending: countPendingConfirmations(topics),
      };
    });

    return reply.view("run-site-detail", {
      active: "runs",
      title: `${score.site.name} — Run #${id}`,
      score,
      topics: score.topicsJson as any[],
      chinaTopics: (score.chinaTopicsJson as any[]) ?? null,
      pages,
      // Site-level « provisoire » badges, one per family of page.
      pending: countPendingConfirmations(score.topicsJson as unknown as TopicResult[]),
      chinaPending: countPendingConfirmations(
        (score.chinaTopicsJson as unknown as TopicResult[]) ?? null,
      ),
      derivedIds: DERIVED_CONTROL_IDS,
      // A recapture is only offerable when nothing else is executing.
      isLive: activeRun() !== null,
      flash: (req.query as any)?.flash ?? null,
    });
  });

  // Recapture every page of ONE site of this run and rebuild its aggregate.
  // Unlike « Reprendre », it recaptures the pages already DONE — the point is to
  // refresh this site's result, the rest of the run is left untouched.
  app.post("/runs/:id/sites/:siteId/recapture", async (req, reply) => {
    const id = Number((req.params as any).id);
    const siteId = Number((req.params as any).siteId);
    const back = `/runs/${id}/sites/${siteId}`;

    const pages = await prisma.runPage.count({ where: { runId: id, page: { siteId } } });
    if (pages === 0) {
      return reply.redirect(
        `${back}?flash=${encodeURIComponent("Aucune page de ce site dans ce run.")}`,
      );
    }
    const res = recaptureSite(id, siteId);
    if (!res.started) {
      return reply.redirect(
        `${back}?flash=${encodeURIComponent(res.reason ?? "Recapture impossible")}`,
      );
    }
    // The live progress table lives on the run page.
    return reply.redirect(`/runs/${id}`);
  });

  app.post("/runs/:id/delete", async (req, reply) => {
    const id = Number((req.params as any).id);
    await prisma.run.delete({ where: { id } }).catch(() => {});
    return reply.redirect("/runs");
  });
}
