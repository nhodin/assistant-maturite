/**
 * "Audience" column of a diagnostic: how big the prospect's site is, from CrUX.
 *
 * INFORMATIONAL, never part of the verdict (see docs/DIAGNOSTIC.md "Informations
 * relevées, hors verdict"). The verdict says whether EdgeSpeed can work, the CWV
 * say how much there is to gain, the audience says how much traffic that gain
 * applies to — read together they rank prospects.
 *
 * Two sources, each optional on its own:
 *   - the popularity rank (France + worldwide), BigQuery dataset — see collector/crux-rank.ts
 *   - the mobile share of page loads, CrUX API `form_factors`
 */
import { fetchCruxFormFactors } from "../collector/crux";
import type { CruxRankFailure, CruxRankFailureKind, CruxRankResult } from "../collector/crux-rank";

/** The country the popularity rank is read for. Fixed: prospects are French sites. */
export const AUDIENCE_COUNTRY = "fr";

export interface AudienceSummary {
  /** The CrUX origin key (landed-on URL, after redirects). */
  origin: string;
  /**
   * Rank bucket (upper bound: 1000 = top 1k) within AUDIENCE_COUNTRY, then
   * worldwide. Absent = not queried; null = out of the ranking that month.
   */
  rankCountry?: number | null;
  rankGlobal?: number | null;
  /** Dataset month the ranks were read from (yyyymm). */
  monthCountry?: number;
  monthGlobal?: number;
  /**
   * The rank query failed for the run (quota, cap, access…): the cell says why
   * instead of looking "not configured". Cleared by the next successful query.
   */
  rankUnavailable?: CruxRankFailureKind;
  /** Share of page loads on a phone, 0–1. Absent when CrUX had no split. */
  mobileShare?: number;
}

export type AudienceTier = "high" | "mid" | "low";

/** Tier thresholds on the COUNTRY rank bucket. */
export const AUDIENCE_TIERS = { high: 10_000, mid: 100_000 } as const;

/** high ≤ top 10k France, mid ≤ top 100k, low beyond or out of the ranking. */
export function audienceTier(rankCountry: number | null | undefined): AudienceTier {
  if (rankCountry == null) return "low";
  if (rankCountry <= AUDIENCE_TIERS.high) return "high";
  if (rankCountry <= AUDIENCE_TIERS.mid) return "mid";
  return "low";
}

/** 5000 → "Top 5k", 1000000 → "Top 1M". */
export function rankLabel(rank: number): string {
  if (rank >= 1_000_000 && rank % 1_000_000 === 0) return `Top ${rank / 1_000_000}M`;
  if (rank >= 1_000 && rank % 1_000 === 0) return `Top ${rank / 1_000}k`;
  return `Top ${rank}`;
}

/** 202608 → "2026-08". */
export function monthLabel(yyyymm: number): string {
  const s = String(yyyymm);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}

/**
 * Per-page part, fetched at capture time: the origin and its mobile share.
 * Undefined when neither source is configured (the cell then says "not queried").
 */
export async function fetchOriginAudience(
  url: string,
  apiKey: string | undefined,
  rankConfigured: boolean,
): Promise<AudienceSummary | undefined> {
  if (!apiKey && !rankConfigured) return undefined;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return undefined;
  }
  const summary: AudienceSummary = { origin };
  const ff = await fetchCruxFormFactors(origin, apiKey);
  if (ff?.phone !== undefined) summary.mobileShare = ff.phone;
  return summary;
}

/**
 * Pure: mark a page's audience as "rank unavailable" after a failed query. A
 * rank read by an EARLIER successful pass (resumed run) is kept: it is still
 * the truth for its month, and dropping it would lose data for a quota blip.
 */
export function withRankFailure(a: AudienceSummary, f: CruxRankFailure): AudienceSummary {
  if (a.rankCountry !== undefined) return a;
  return { ...a, rankUnavailable: f.kind };
}

/** Pure: merge the run-wide rank lookup into a page's audience. */
export function withRanks(a: AudienceSummary, ranks: CruxRankResult): AudienceSummary {
  const r = ranks.ranks.get(a.origin);
  const { rankUnavailable: _cleared, ...rest } = a;
  return {
    ...rest,
    rankCountry: r ? r.rankCountry : null,
    rankGlobal: r ? r.rankGlobal : null,
    monthCountry: ranks.monthCountry,
    monthGlobal: ranks.monthGlobal,
  };
}
