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
 * Fetch CrUX field data for a URL (PHONE form factor).
 * Returns null if no apiKey is provided or on any failure.
 */
export async function fetchCrux(
  url: string,
  apiKey?: string,
): Promise<CruxData | null> {
  if (!apiKey) return null;

  try {
    const res = await fetch(`${CRUX_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, formFactor: "PHONE" }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as CruxResponse;
    const metrics = data?.record?.metrics;

    if (!metrics) return null;

    return {
      lcpMs: p75(metrics.largest_contentful_paint),
      ttfbMs: p75(metrics.experimental_time_to_first_byte),
      cls: p75(metrics.cumulative_layout_shift),
      inpMs: p75(metrics.interaction_to_next_paint),
      source: "crux",
    };
  } catch {
    return null;
  }
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
