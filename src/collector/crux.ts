/**
 * Optional CrUX field data fetcher.
 * Returns null when no API key is provided or on any error.
 */
import type { CruxData } from "../core";

const CRUX_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

interface CruxMetric {
  percentiles?: { p75?: number | string };
}

interface CruxResponse {
  record?: {
    metrics?: {
      largest_contentful_paint?: CruxMetric;
      experimental_time_to_first_byte?: CruxMetric;
      cumulative_layout_shift?: CruxMetric;
      interaction_to_next_paint?: CruxMetric;
      first_contentful_paint?: CruxMetric;
    };
  };
}

/** p75 field metrics for a single CrUX record (all optional — CrUX may omit any). */
export interface CruxMetrics {
  lcpMs?: number;
  ttfbMs?: number;
  inpMs?: number;
  cls?: number;
  fcpMs?: number;
}

/** CrUX device form factor. We track mobile (PHONE) and desktop separately. */
export type CruxFormFactor = "PHONE" | "DESKTOP";

/** Pure parse of a CrUX `queryRecord` JSON payload into p75 metrics. */
export function parseCruxMetrics(data: CruxResponse | null | undefined): CruxMetrics | null {
  const metrics = data?.record?.metrics;
  if (!metrics) return null;
  return {
    lcpMs: p75(metrics.largest_contentful_paint),
    ttfbMs: p75(metrics.experimental_time_to_first_byte),
    inpMs: p75(metrics.interaction_to_next_paint),
    cls: p75(metrics.cumulative_layout_shift),
    fcpMs: p75(metrics.first_contentful_paint),
  };
}

function p75(metric: CruxMetric | undefined): number | undefined {
  if (!metric?.percentiles?.p75) return undefined;
  const v = Number(metric.percentiles.p75);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Follow redirects for `url` and return the URL actually served, or `url` itself
 * on any failure. CrUX indexes the landed-on URL, so callers without a browser
 * capture (the monitor) need this to build the right lookup key.
 */
export async function resolveFinalUrl(url: string, timeoutMs = 10000): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain so the socket is released; the body itself is not needed.
    await res.arrayBuffer().catch(() => undefined);
    return res.url || url;
  } catch {
    return url;
  }
}

/** Which CrUX record answered a lookup: a URL-level record or the origin fallback. */
export type CruxRecordScope = "page" | "origin";

/** True when CrUX returned at least one usable p75 value. */
function hasAnyMetric(m: CruxMetrics): boolean {
  return (
    m.ttfbMs !== undefined ||
    m.lcpMs !== undefined ||
    m.cls !== undefined ||
    m.inpMs !== undefined ||
    m.fcpMs !== undefined
  );
}

function toCruxData(m: CruxMetrics, scope: CruxRecordScope, urlKey: string): CruxData {
  return {
    ttfbMs: m.ttfbMs,
    lcpMs: m.lcpMs,
    cls: m.cls,
    inpMs: m.inpMs,
    source: "crux",
    scope,
    urlKey,
  };
}

/**
 * Fetch CrUX field data for a captured page (PHONE form factor), trying the
 * URL-level record first and falling back to the origin.
 *
 * CrUX indexes the URL a user actually landed on, so `finalUrl` (post-redirect)
 * is the key that matches — an inventory URL like `https://us.louisvuitton.com/`
 * that redirects to `/eng-us/homepage` has no record of its own and 404s.
 * `url` is still tried after it, in case the inventory URL is the indexed one.
 *
 * The origin fallback is less precise (its p75 is pulled by the homepage), so
 * the answering scope and key are recorded on the result and surfaced in the
 * report. Returns null when no key has field data.
 */
export async function fetchCruxWithFallback(
  keys: { finalUrl?: string | null; url?: string | null },
  apiKey?: string,
): Promise<CruxData | null> {
  if (!apiKey) return null;

  const candidates: string[] = [];
  for (const u of [keys.finalUrl, keys.url]) {
    if (u && !candidates.includes(u)) candidates.push(u);
  }

  for (const candidate of candidates) {
    const m = await fetchCruxMetrics({ url: candidate }, apiKey);
    if (m && hasAnyMetric(m)) return toCruxData(m, "page", candidate);
  }

  const origins: string[] = [];
  for (const candidate of candidates) {
    try {
      const o = new URL(candidate).origin;
      if (!origins.includes(o)) origins.push(o);
    } catch {
      // Not a parsable URL — no origin to fall back to.
    }
  }
  for (const origin of origins) {
    const m = await fetchCruxMetrics({ origin }, apiKey);
    if (m && hasAnyMetric(m)) return toCruxData(m, "origin", origin);
  }

  return null;
}

/**
 * Fetch p75 CrUX field metrics for either a specific `url` or an `origin`, for
 * the given `formFactor` (defaults to PHONE/mobile). Returns null when no apiKey
 * is provided, on a non-OK response (a 404 = "no CrUX data for this URL/origin/
 * form factor" is common), or on error.
 */
export async function fetchCruxMetrics(
  key: { url?: string; origin?: string },
  apiKey?: string,
  formFactor: CruxFormFactor = "PHONE",
): Promise<CruxMetrics | null> {
  if (!apiKey) return null;
  if (!key.url && !key.origin) return null;

  try {
    const body: Record<string, unknown> = { formFactor };
    if (key.url) body.url = key.url;
    else body.origin = key.origin;

    const res = await fetch(`${CRUX_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as CruxResponse;
    return parseCruxMetrics(data);
  } catch {
    return null;
  }
}
