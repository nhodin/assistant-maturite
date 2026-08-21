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
    where: { runId, status: "DONE", page: { siteId } },
    select: { url: true, mode: true, topicsJson: true, overall: true, geo: true, china: true },
    orderBy: { id: "asc" },
  });
  const pageResults: PageResult[] = scored
    .filter((rp) => rp.topicsJson !== null)
    .map((rp) => ({
      url: rp.url,
      // Stored per page: China pages and standard pages are aggregated apart.
      mode: (rp.mode === "china" ? "china" : "standard") as PageScoringMode,
      topics: rp.topicsJson as unknown as TopicResult[],
      overall: rp.overall,
      geo: rp.geo,
      china: rp.china,
    }));
  if (pageResults.length === 0) return false; // every page failed: no score for this site.

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
