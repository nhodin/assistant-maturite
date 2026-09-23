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
  /**
   * Whether the request belongs to the page's OWN (top-level) frame, as opposed
   * to an embedded iframe. Only meaningful for `resourceType === "document"`,
   * where it separates the page itself from a third-party iframe document — a
   * distinction the capture health check needs, since a tracking iframe that
   * 404s says nothing about whether the real page loaded.
   * Optional for backward-compat with evidence captured before this field
   * existed; consumers must treat `undefined` as unknown, never as false.
   */
  isMainFrame: z.boolean().optional(),
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
  /** value of ascent-override (local system fallback metric). */
  ascentOverride: z.string().optional(),
  /** value of descent-override (local system fallback metric). */
  descentOverride: z.string().optional(),
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
  /**
   * Which CrUX record answered: "page" for a URL-level record, "origin" for the
   * origin-wide fallback (less precise — its p75 is pulled by the homepage).
   * Optional: evidence captured before the fallback existed carries no scope.
   */
  scope: z.enum(["page", "origin"]).optional(),
  /** The URL or origin actually queried, for traceability in the report. */
  urlKey: z.string().optional(),
});

export const PageFeaturesSchema = z.object({
  sliderDetected: z.boolean(),
  sliderLib: z.string().optional(),
  /**
   * outerHTML of the FIRST detected slider container (rendered DOM, post-JS), so
   * topic-2 controls can score the slider itself instead of any page-wide <img>.
   * Capped in the collector (200 000 chars) and further truncated when slimmed for
   * DB storage. Optional/absent for evidence captured before slider markup was kept —
   * topic-2 controls fall back to a page-wide heuristic in that case.
   */
  sliderHtml: z.string().optional(),
  videoDetected: z.boolean(),
  /**
   * A video (or youtube/vimeo iframe) is rendered inside the INITIAL viewport,
   * measured at scroll position 0 after the capture's auto-scroll returned to the
   * top. Drives whether preloading its poster is worth points at all (topic 3).
   * Optional/absent for evidence captured before this was measured — controls must
   * treat `undefined` as "unknown", not as "false".
   */
  videoInViewport: z.boolean().optional(),
  cookieAccepted: z.boolean(),
});

/* ── Prospect diagnostic (Speed/SEO eligibility) ──────────────────────────────
 * All optional / nullable: a maturity capture never fills them, and evidence
 * captured before the diagnostic existed must stay valid. See docs/DIAGNOSTIC.md.
 */

/** Re-fetch of the SAME document with a crawler user-agent (Googlebot). */
export const BotFetchSchema = z.object({
  /** The exact UA string sent. */
  userAgent: z.string(),
  /** HTTP status of the bot fetch. 0 when the request itself failed. */
  status: z.number(),
  /** Raw HTML served to the crawler, before any JS. "" when the fetch failed. */
  html: z.string(),
  /** UTF-8 byte size of `html` as captured, stamped before any truncation. */
  htmlBytes: z.number(),
  responseHeaders: HeaderMapSchema,
  /**
   * The response is a WAF challenge / block page rather than the document.
   * This is what makes the "SSR user but not bot" row `unknown` instead of a
   * NOGO — see docs/DIAGNOSTIC.md.
   */
  blocked: z.boolean(),
  /** Why it was judged blocked (status, challenge signature...). */
  blockReason: z.string().optional(),
});

/** JS stack fingerprint + service-worker fact. Informational, never a verdict. */
export const StackProbeSchema = z.object({
  /** Matched framework ids, most specific first, e.g. ["next", "react"]. */
  frameworks: z.array(z.string()),
  /** Human-readable evidence backing each match, for the report. */
  signals: z.array(z.string()),
  /** A service worker is registered on the page (possible conflict at the edge). */
  serviceWorker: z.boolean().optional(),
});

/** MPA vs SPA, decided by clicking an internal link. Informational. */
export const NavigationProbeSchema = z.object({
  kind: z.enum(["spa", "mpa", "unknown"]),
  /** The internal link the probe clicked, when one was found. */
  linkUrl: z.string().optional(),
  /** URL after the click settled. */
  landedUrl: z.string().optional(),
  /** A marker set on `window` survived the navigation → client-side routing. */
  contextSurvived: z.boolean().optional(),
  /** A new main-frame document request was observed after the click. */
  documentRequested: z.boolean().optional(),
  /** Why the probe could not conclude (no internal link, click did nothing...). */
  note: z.string().optional(),
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
  /**
   * UTF-8 byte size of `rawHtml` as captured, stamped at collection time.
   *
   * `rawHtml` itself is truncated before a bundle is persisted to the database
   * (see slimEvidence), so measuring the document from it after the fact reads a
   * 2 KB stub instead of the real page. This field survives that truncation and
   * is what geo.weight1mb reads. Optional: bundles captured before it existed
   * fall back to measuring `rawHtml` directly.
   */
  htmlBytes: z.number().optional(),
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
  /** Diagnostic-only: the document as served to a crawler. Null on a maturity capture. */
  bot: BotFetchSchema.nullable().default(null),
  /** Diagnostic-only: JS stack fingerprint. Absent on a maturity capture. */
  stack: StackProbeSchema.optional(),
  /** Diagnostic-only: MPA/SPA navigation probe. Absent on a maturity capture. */
  navigation: NavigationProbeSchema.optional(),
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
export type BotFetch = z.infer<typeof BotFetchSchema>;
export type StackProbe = z.infer<typeof StackProbeSchema>;
export type NavigationProbe = z.infer<typeof NavigationProbeSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
