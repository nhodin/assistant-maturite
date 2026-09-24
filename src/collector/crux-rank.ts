/**
 * CrUX popularity rank, read from the public CrUX dataset on BigQuery.
 *
 * The CrUX API has no popularity field: the rank only exists in the monthly
 * dataset, as a coarse bucket (1k, 5k, 10k, 50k, 100k, 500k, 1M, 5M, 10M, 50M —
 * the value is the bucket's upper bound). Two materialized tables carry it,
 * both partitioned and clustered, so a query filtered on month + origin reads
 * little:
 *   - `materialized.country_summary` — rank WITHIN a country (`country_code`, ISO lowercase)
 *   - `materialized.metrics_summary` — worldwide rank
 *
 * Opt-in, see `cruxBqConfig`: the service-account key is passed as the CONTENT
 * of `CRUX_BQ_CREDENTIALS` (raw JSON or base64) rather than a file path — the
 * Home Assistant add-on only has its options to carry secrets, and a key file
 * dropped in /share would be readable by every other add-on.
 */
import { BigQuery } from "@google-cloud/bigquery";

export interface CruxBqConfig {
  /** GCP project billed for the query. */
  projectId: string;
  /** Service-account key; absent = Application Default Credentials. */
  credentials?: { client_email: string; private_key: string };
}

/**
 * Resolve the BigQuery configuration from the environment. Null = the rank is
 * not queried.
 *   - `CRUX_BQ_CREDENTIALS`: service-account key JSON, raw or base64 (base64
 *     survives any form field or `.env` quoting). Its `project_id` is the
 *     billed project unless `CRUX_BQ_PROJECT` overrides it.
 *   - otherwise `CRUX_BQ_PROJECT` alone, with Application Default Credentials
 *     (`gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS).
 * A malformed key is a warning and a null, never a crash of the run.
 */
export function cruxBqConfig(env: NodeJS.ProcessEnv = process.env): CruxBqConfig | null {
  const raw = env.CRUX_BQ_CREDENTIALS?.trim();
  const project = env.CRUX_BQ_PROJECT?.trim() || undefined;
  if (!raw) return project ? { projectId: project } : null;
  try {
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const key = JSON.parse(json) as { client_email?: string; private_key?: string; project_id?: string };
    if (!key.client_email || !key.private_key) throw new Error("client_email / private_key missing");
    const projectId = project ?? key.project_id;
    if (!projectId) throw new Error("no project_id in the key and no CRUX_BQ_PROJECT");
    return { projectId, credentials: { client_email: key.client_email, private_key: key.private_key } };
  } catch (err) {
    console.warn(`CRUX_BQ_CREDENTIALS ignored: ${(err as Error).message}`);
    return null;
  }
}

/** Rank of one origin. null = absent from that ranking for the dataset month. */
export interface CruxRank {
  origin: string;
  rankCountry: number | null;
  rankGlobal: number | null;
}

export interface CruxRankResult {
  country: string;
  /** Dataset month (yyyymm) each ranking was read from; absent when no origin was found at all. */
  monthCountry?: number;
  monthGlobal?: number;
  ranks: Map<string, CruxRank>;
}

/** One row of the BigQuery result. */
export interface CruxRankRow {
  scope: "country" | "global";
  yyyymm: number;
  origin: string;
  rank: number;
}

/**
 * The dataset is published around the second Tuesday for the PREVIOUS month, so
 * the latest month is M-1 or M-2 depending on the day. Asking for the last three
 * months with constant values keeps partition pruning (a MAX(yyyymm) subquery
 * would not) and survives a late publication.
 */
export function candidateMonths(now: Date = new Date()): number[] {
  const out: number[] = [];
  for (let back = 1; back <= 3; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    out.push(d.getUTCFullYear() * 100 + d.getUTCMonth() + 1);
  }
  return out;
}

export const CRUX_RANK_QUERY = `
SELECT 'country' AS scope, yyyymm, origin, MIN(rank) AS rank
FROM \`chrome-ux-report.materialized.country_summary\`
WHERE yyyymm IN UNNEST(@months) AND country_code = @country AND origin IN UNNEST(@origins)
GROUP BY yyyymm, origin
UNION ALL
SELECT 'global' AS scope, yyyymm, origin, MIN(rank) AS rank
FROM \`chrome-ux-report.materialized.metrics_summary\`
WHERE yyyymm IN UNNEST(@months) AND origin IN UNNEST(@origins)
GROUP BY yyyymm, origin`;

/**
 * Pure: fold the rows into one rank per origin and scope. Each scope is read at
 * ITS latest month present in the rows (the country table can lag the global
 * one); an origin missing from that month is null — out of the ranking — even
 * if an older month had it, so every origin of a run is read at the same month.
 */
export function foldCruxRanks(origins: string[], rows: CruxRankRow[], country: string): CruxRankResult {
  const latest = (scope: CruxRankRow["scope"]): number | undefined => {
    let m: number | undefined;
    for (const r of rows) if (r.scope === scope && (m === undefined || r.yyyymm > m)) m = r.yyyymm;
    return m;
  };
  const monthCountry = latest("country");
  const monthGlobal = latest("global");
  const ranks = new Map<string, CruxRank>();
  for (const origin of origins) ranks.set(origin, { origin, rankCountry: null, rankGlobal: null });
  for (const r of rows) {
    const entry = ranks.get(r.origin);
    if (!entry) continue;
    if (r.scope === "country" && r.yyyymm === monthCountry) entry.rankCountry = r.rank;
    if (r.scope === "global" && r.yyyymm === monthGlobal) entry.rankGlobal = r.rank;
  }
  return { country, monthCountry, monthGlobal, ranks };
}

/**
 * Why the rank query failed. The run always goes on without the rank — the
 * reason is only there to turn a silent gap into a warning an operator can act on.
 *   - `quota`: the project's quota is exhausted (free tier of the sandbox, daily
 *     bytes, rate limit) — comes back by itself, or with billing enabled
 *   - `cap`: our own `maximumBytesBilled` cap refused the query (CRUX_BQ_MAX_BYTES)
 *   - `auth`: invalid key, missing role, disabled API
 *   - `other`: network, timeout, anything unclassified
 */
export type CruxRankFailureKind = "quota" | "cap" | "auth" | "other";

export interface CruxRankFailure {
  failed: true;
  kind: CruxRankFailureKind;
  /** The API's own message, for the logs and the tooltip. */
  message: string;
}

/**
 * Pure: classify a BigQuery client error. Reads the structured `errors[].reason`
 * first (ApiError), then falls back on the message and HTTP code.
 */
export function classifyBqError(err: unknown): CruxRankFailure {
  const e = err as { message?: string; code?: number; errors?: { reason?: string; message?: string }[] };
  const message = String(e?.message ?? err).slice(0, 500);
  const reasons = (e?.errors ?? []).map((x) => x.reason ?? "");
  const has = (...r: string[]) => reasons.some((x) => r.includes(x));
  let kind: CruxRankFailureKind;
  if (has("bytesBilledLimitExceeded") || /bytes billed limit/i.test(message)) kind = "cap";
  else if (has("quotaExceeded", "rateLimitExceeded") || e?.code === 429 || /quota|rate limit/i.test(message)) kind = "quota";
  else if (
    has("accessDenied", "authError", "invalid_grant", "forbidden") ||
    e?.code === 401 ||
    e?.code === 403 ||
    /permission|unauthori[sz]ed|invalid_grant|access denied|has not been used|is disabled/i.test(message)
  )
    kind = "auth";
  else kind = "other";
  return { failed: true, kind, message };
}

/** French warning shown on the run, one per failure kind. */
export function rankFailureWarning(f: CruxRankFailure): string {
  const what = {
    quota:
      "quota BigQuery dépassé (quota gratuit du Sandbox ou limite du projet) — il se rétablit seul, ou en activant la facturation sur le projet",
    cap: "la requête dépasse le plafond CRUX_BQ_MAX_BYTES — le relever si le volume lu a changé côté Google",
    auth: "accès BigQuery refusé — vérifier la clé CRUX_BQ_CREDENTIALS et le rôle BigQuery Job User du compte de service",
    other: "requête BigQuery en échec",
  }[f.kind];
  return `Colonne Audience : rang CrUX indisponible pour ce run — ${what}. Le diagnostic est complet par ailleurs. (${f.message})`;
}

export function isRankFailure(r: CruxRankResult | CruxRankFailure | null | undefined): r is CruxRankFailure {
  return !!r && "failed" in r;
}

/**
 * Upper bound on the bytes one query may bill. The clustered tables read far
 * less than this; the cap is there so a schema change on Google's side fails the
 * query instead of scanning the whole table on every run.
 */
const DEFAULT_MAX_BYTES = 5 * 1024 ** 3;

/**
 * Rank every origin in ONE query. Undefined when not configured (see
 * `cruxBqConfig`, or no origin); a `CruxRankFailure` when the query failed —
 * never a throw, so a quota or auth problem can never stop a run.
 */
export async function fetchCruxRanks(
  origins: string[],
  opts: { config?: CruxBqConfig | null; country?: string; maxBytes?: number; now?: Date } = {},
): Promise<CruxRankResult | CruxRankFailure | undefined> {
  const config = opts.config === undefined ? cruxBqConfig() : opts.config;
  const unique = [...new Set(origins)];
  if (!config || unique.length === 0) return undefined;
  const country = (opts.country ?? "fr").toLowerCase();
  const maxBytes = opts.maxBytes ?? (Number(process.env.CRUX_BQ_MAX_BYTES) || DEFAULT_MAX_BYTES);
  try {
    const bq = new BigQuery({ projectId: config.projectId, credentials: config.credentials });
    const [rows] = await bq.query({
      query: CRUX_RANK_QUERY,
      params: { months: candidateMonths(opts.now), country, origins: unique },
      types: { months: ["INT64"], country: "STRING", origins: ["STRING"] },
      maximumBytesBilled: String(maxBytes),
      // A stuck job must not hold the end of the run: past this, it is a failure like any other.
      jobTimeoutMs: 60_000,
    });
    const parsed: CruxRankRow[] = (rows as Record<string, unknown>[]).map((r) => ({
      scope: r.scope === "global" ? "global" : "country",
      yyyymm: Number(r.yyyymm),
      origin: String(r.origin),
      rank: Number(r.rank),
    }));
    return foldCruxRanks(unique, parsed, country);
  } catch (err) {
    const failure = classifyBqError(err);
    console.warn(`CrUX rank (BigQuery) failed [${failure.kind}]: ${failure.message}`);
    return failure;
  }
}
