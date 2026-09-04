/**
 * Rebuild the aggregated score of ONE site within a run, from the per-page
 * results stored in the DB.
 *
 * The aggregate is never recomputed from the (large, sometimes long-gone)
 * EvidenceBundles: `scoreSiteFromPages` only ever reads `applicable`/`passed`
 * per page, and those are exactly what a stored ControlResult carries. That is
 * what lets a resumed run mix pages captured before and after the interruption
 * — and what lets a manually corrected page propagate to its site without any
 * recapture.
 */
import { prisma } from "./db";
import { TOPICS } from "../topics";
import { scoreSiteFromPages } from "../engine";
import type { ConfigMap } from "../engine";
import { buildConfigMap } from "./config-store";
import type { PageResult, PageScoringMode, TopicResult } from "../core";

/**
 * A result nothing was ever measured on: absent, or the all-N/A skeleton an
 * uncaptured page is graded from. A real capture always leaves applicable
 * criteria behind, which is what tells the two apart.
 */
function isBlankResult(topicsJson: unknown): boolean {
  const topics = (topicsJson as TopicResult[] | null) ?? [];
  return !topics.some((t) => (t.controls ?? []).some((c) => c.applicable === true));
}

/** Does this stored result carry at least one hand-set verdict? */
function hasManualVerdict(topicsJson: unknown): boolean {
  const topics = (topicsJson as TopicResult[] | null) ?? [];
  return topics.some((t) => (t.controls ?? []).some((c) => c.manual === true));
}

/**
 * @param config  The run's ConfigMap when the caller already has it (the runner
 *                holds a snapshot for the whole run); loaded from the DB otherwise.
 * @returns false when the site has no scored page at all — nothing is written then.
 */
export async function rebuildSiteScore(
  runId: number,
  siteId: number,
  config?: ConfigMap,
): Promise<boolean> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { name: true, category: true },
  });
  if (!site) return false;

  const scored = await prisma.runPage.findMany({
    where: { runId, page: { siteId } },
    select: {
      url: true,
      mode: true,
      status: true,
      topicsJson: true,
      overall: true,
      geo: true,
      china: true,
    },
    orderBy: { id: "asc" },
  });
  const pageResults: PageResult[] = scored
    .filter((rp) => rp.topicsJson !== null)
    // A page that is not DONE only counts once an operator has graded it by
    // hand: an interrupted capture may have left stale results behind, but a
    // manual verdict on a page the run never captured is the whole point of the
    // correction route and must reach the site aggregate.
    .filter((rp) => rp.status === "DONE" || hasManualVerdict(rp.topicsJson))
    .map((rp) => ({
      url: rp.url,
      // Stored per page: China pages and standard pages are aggregated apart.
      mode: (rp.mode === "china" ? "china" : "standard") as PageScoringMode,
      topics: rp.topicsJson as unknown as TopicResult[],
      overall: rp.overall,
      geo: rp.geo,
      china: rp.china,
    }));
  if (pageResults.length === 0) {
    // Nothing contributes any more. If every page is blank — never captured, or
    // holding nothing but the hand-grading skeleton — then any row that exists
    // can only come from verdicts since undone: drop it, so the site returns to
    // « sans score » instead of showing a number nothing backs. A site that WAS
    // captured keeps its row (its pages carry applicable criteria), so a failed
    // recapture never erases the results this run did produce.
    if (scored.every((rp) => isBlankResult(rp.topicsJson))) {
      await prisma.runSiteScore.deleteMany({ where: { runId, siteId } });
    }
    return false; // every page failed: no score for this site.
  }

  const cfg = config ?? (await buildConfigMap());
  const result = scoreSiteFromPages(site.name, pageResults, TOPICS, cfg);

  const values = {
    category: site.category,
    overall: result.overall,
    geo: result.geo,
    china: result.china,
    chinaOverall: result.chinaOverall,
    topicsJson: result.topics as unknown as object,
  };
  await prisma.runSiteScore.upsert({
    where: { runId_siteId: { runId, siteId } },
    create: {
      runId,
      siteId,
      ...values,
      chinaTopicsJson: (result.chinaTopics ?? undefined) as unknown as object,
    },
    update: {
      ...values,
      chinaTopicsJson: (result.chinaTopics ?? null) as unknown as object,
    },
  });
  return true;
}
