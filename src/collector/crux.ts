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
    };
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
