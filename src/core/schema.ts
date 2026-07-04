/**
 * Core data contract — the `EvidenceBundle` produced by the collector and consumed
 * by every topic module. This is the single source of truth: all data types are
 * defined as Zod schemas and the TypeScript types are INFERRED from them, so the
 * runtime validation and the static types can never drift apart.
 *
 * The collector MUST output an object that satisfies `EvidenceBundleSchema`.
 * Topic modules MUST only read from this shape (never re-fetch anything).
 */
import { z } from "zod";

/** Lowercased header map: { "content-type": "image/webp", ... } */
export const HeaderMapSchema = z.record(z.string());

export const DeviceSchema = z.enum(["mobile", "desktop"]);

/** One network request observed during the page load. */
export const NetworkRequestSchema = z.object({
  url: z.string(),
  /** document | image | stylesheet | script | font | xhr | fetch | media | other */
  resourceType: z.string(),
  status: z.number(),
  fromCache: z.boolean(),
  /** Transferred (on-the-wire, compressed) bytes. 0 if unknown. */
  encodedBytes: z.number(),
  /** Decompressed body bytes. 0 if unknown. */
  decodedBytes: z.number(),
  requestHeaders: HeaderMapSchema,
  /** Response headers, keys lowercased. */
  responseHeaders: HeaderMapSchema,
  /** Resolved MIME type from the content-type response header (no charset). */
  mimeType: z.string(),
  /**
   * Load-vs-interaction phase, set by the collector from the request's send time.
   * - "load": initiated during the quiet initial page load (incl. cookie acceptance),
   *   before any synthetic user/browser interaction.
   * - "interaction": initiated ONLY after the collector dispatched synthetic
   *   user-intent events (mousemove/pointer/touch/keydown/wheel) and let the browser
   *   go idle — i.e. event-based ("fine-tuned") deferred loading.
   * Optional for backward-compat with evidence captured before this field existed;
   * a missing phase is treated as "load" by every control.
   */
  phase: z.enum(["load", "interaction"]).optional(),
});

/** A significant tag inside <head>, in document order. */
export const HeadTagSchema = z.object({
  /** meta | title | link | style | script | base */
  tag: z.string(),
  attrs: HeaderMapSchema,
});

export const ParsedHeadSchema = z.object({
  /**
   * Ordered list of significant head tags as normalized tokens, e.g.
   * ["meta[charset]", "meta[viewport]", "title", "link[stylesheet]", "script"].
   * Used by the Critical Path topic; ignores meta[alternate]/lang per CLAUDE.md.
   */
  order: z.array(z.string()),
  tags: z.array(HeadTagSchema),
});

/** A @font-face declaration (parsed from raw CSS) or an observed font request. */
export const FontFaceSchema = z.object({
  family: z.string().optional(),
  src: z.string().optional(),
  /** woff2 | woff | ttf | otf | eot */
  format: z.string().optional(),
  /** value of font-display: swap | optional | block | fallback | auto */
  fontDisplay: z.string().optional(),
  unicodeRange: z.string().optional(),
  sizeAdjust: z.string().optional(),
});

/** The Largest Contentful Paint element, resolved from a PerformanceObserver. */
export const LcpElementSchema = z.object({
  tagName: z.string(),
  /** Resolved absolute URL if the LCP element is/loads an image. */
  src: z.string().optional(),
  selector: z.string().optional(),
  /** value of the `loading` attribute on the element, if any. */
  loadingAttr: z.string().optional(),
  /** value of the `fetchpriority` attribute on the element, if any. */
  fetchPriorityAttr: z.string().optional(),
});

export const PerfMetricsSchema = z.object({
  lcpMs: z.number().nullable(),
  lcpElement: LcpElementSchema.nullable(),
  cls: z.number().nullable(),
  ttfbMs: z.number().nullable(),
  longTasks: z.array(z.object({ startTime: z.number(), duration: z.number() })),
  /** Sum of transferred bytes across all requests. */
  totalBytes: z.number(),
});

/** Coverage tracking is best-effort — the collector may leave these null when
 *  CDP rule-usage tracking is unavailable for a given capture. */
export const CoverageMetricsSchema = z.object({
  cssUnusedPct: z.number().nullable(),
  jsUnusedPct: z.number().nullable(),
});

/**
 * Derived facts about ALL stylesheets seen (inline <style> blocks + external
 * stylesheet responses fetched via CDP during capture). Only booleans/counts are
 * kept — the raw CSS text itself is never persisted (see EvidenceBundle size
 * constraints in app/CLAUDE.md).
 */
export const CssAuditSchema = z.object({
  /** data:image/svg or data:font/data:application/font URI found in any stylesheet. */
  hasInlinedSvgOrFontDataUri: z.boolean(),
  /** Count of distinct external stylesheet responses whose body was fetched and scanned. */
  externalStylesheetsParsed: z.number(),
  /** @import found in any stylesheet — forces a serial, render-blocking fetch chain. */
  hasAtImport: z.boolean(),
});

/** Network-layer facts gathered by Node probes (outside the browser). */
export const NetworkProbeSchema = z.object({
  /** e.g. "TLSv1.3" */
  tlsVersion: z.string().nullable(),
  /** negotiated ALPN protocol, e.g. "h2", "http/1.1" */
  alpn: z.string().nullable(),
  /** origin resolves an AAAA record */
  ipv6: z.boolean().nullable(),
  /** advertised via alt-svc h3 or negotiated */
  http3: z.boolean().nullable(),
});

export const CruxDataSchema = z.object({
  ttfbMs: z.number().optional(),
  lcpMs: z.number().optional(),
  cls: z.number().optional(),
  inpMs: z.number().optional(),
  source: z.enum(["crux", "psi"]),
});

export const PageFeaturesSchema = z.object({
  sliderDetected: z.boolean(),
  sliderLib: z.string().optional(),
  videoDetected: z.boolean(),
  cookieAccepted: z.boolean(),
});

export const EvidenceBundleSchema = z.object({
  /** URL requested. */
  url: z.string(),
  /** URL after redirects. */
  finalUrl: z.string(),
  device: DeviceSchema,
  /** ISO timestamp of capture. */
  capturedAt: z.string(),
  /** Raw view-source HTML (fetched separately, BEFORE JS execution). */
  rawHtml: z.string(),
  /** Serialized DOM AFTER JS execution. */
  renderedHtml: z.string(),
  /** Response headers of the main HTML document (lowercased keys). */
  mainResponseHeaders: HeaderMapSchema,
  head: ParsedHeadSchema,
  requests: z.array(NetworkRequestSchema),
  perf: PerfMetricsSchema,
  coverage: CoverageMetricsSchema,
  fonts: z.array(FontFaceSchema),
  /** Optional for backward-compat with evidence captured before external CSS was
   *  fetched; a missing value defaults to "nothing captured" (not "nothing found"). */
  css: CssAuditSchema.default({
    hasInlinedSvgOrFontDataUri: false,
    externalStylesheetsParsed: 0,
    hasAtImport: false,
  }),
  /**
   * Lowercased response headers of a 103 Early Hints interim response observed
   * while fetching the main document, or null if none was sent/observed.
   * Optional for backward-compat with evidence captured before this field existed.
   */
  earlyHints: HeaderMapSchema.nullable().default(null),
  field: CruxDataSchema.nullable(),
  network: NetworkProbeSchema,
  features: PageFeaturesSchema,
});

export type HeaderMap = z.infer<typeof HeaderMapSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type NetworkRequest = z.infer<typeof NetworkRequestSchema>;
export type HeadTag = z.infer<typeof HeadTagSchema>;
export type ParsedHead = z.infer<typeof ParsedHeadSchema>;
export type FontFace = z.infer<typeof FontFaceSchema>;
export type LcpElement = z.infer<typeof LcpElementSchema>;
export type PerfMetrics = z.infer<typeof PerfMetricsSchema>;
export type CoverageMetrics = z.infer<typeof CoverageMetricsSchema>;
export type CssAudit = z.infer<typeof CssAuditSchema>;
export type NetworkProbe = z.infer<typeof NetworkProbeSchema>;
export type CruxData = z.infer<typeof CruxDataSchema>;
export type PageFeatures = z.infer<typeof PageFeaturesSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
