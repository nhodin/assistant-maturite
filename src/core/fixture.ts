/**
 * Test helper: build a valid, minimal `EvidenceBundle` and deep-merge overrides.
 * Use in unit tests so every test starts from a schema-valid bundle and only sets
 * the fields it cares about.
 *
 *   makeEvidence({ rawHtml: '<img loading="lazy">' })
 *   makeEvidence({ perf: { lcpElement: { tagName: "IMG", loadingAttr: "lazy" } } })
 */
import type { EvidenceBundle } from "./schema";
import { EvidenceBundleSchema } from "./schema";

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

const BASE: EvidenceBundle = {
  url: "https://example.com/",
  finalUrl: "https://example.com/",
  device: "mobile",
  capturedAt: "2026-01-01T00:00:00.000Z",
  rawHtml: "<!doctype html><html><head></head><body></body></html>",
  renderedHtml: "<!doctype html><html><head></head><body></body></html>",
  mainResponseHeaders: {},
  head: { order: [], tags: [] },
  requests: [],
  perf: {
    lcpMs: null,
    lcpElement: null,
    cls: null,
    ttfbMs: null,
    longTasks: [],
    totalBytes: 0,
  },
  coverage: { cssUnusedPct: null, jsUnusedPct: null },
  fonts: [],
  field: null,
  network: { tlsVersion: null, alpn: null, ipv6: null, http3: null },
  features: {
    sliderDetected: false,
    videoDetected: false,
    cookieAccepted: false,
  },
};

export function makeEvidence(
  overrides: DeepPartial<EvidenceBundle> = {},
): EvidenceBundle {
  const merged = deepMerge(BASE, overrides);
  // Validate so tests fail loudly if a fixture drifts from the schema.
  return EvidenceBundleSchema.parse(merged);
}
