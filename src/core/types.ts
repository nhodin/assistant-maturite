/**
 * Engine contract — the interfaces every topic module and the scoring engine share.
 *
 * Design rule: a `Control` is a PURE function of an `EvidenceBundle`. It decides
 * only `passed` + a human-readable `evidence` string. It NEVER computes points and
 * NEVER does I/O. The engine is responsible for turning `passed` into points using
 * the (optionally overridden) configuration. This keeps controls trivially testable
 * and lets the UI re-point / enable / disable controls without touching code.
 */
import type { Device, EvidenceBundle } from "./schema";

/** Per-control configuration, normally loaded from the DB and merged with defaults. */
export interface ControlConfig {
  enabled: boolean;
  /** When set, overrides the control's `defaultPoints`. */
  pointsOverride: number | null;
  /** Force this control's topic to N/A (e.g. operator override). */
  naForced: boolean;
}

export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
  enabled: true,
  pointsOverride: null,
  naForced: false,
};

/** What a control returns: just the verdict and the evidence. No points. */
export interface ControlVerdict {
  passed: boolean;
  /** Short justification with the concrete data point, mirrors the MD reports. */
  evidence: string;
}

/** A single scored criterion within a topic. */
export interface Control {
  /** Stable id, namespaced by topic, e.g. "images.lazyload". */
  id: string;
  topicId: number;
  label: string;
  description: string;
  /** Points per CLAUDE.md / maturity_grid.gs (30/25/20/15/10/5). */
  defaultPoints: number;
  /**
   * Optional applicability gate. When it returns false, the control is N/A on this
   * page and contributes neither points nor max-points (used for Slider/Video).
   * Omit for controls that always apply.
   */
  appliesTo?: (e: EvidenceBundle) => boolean;
  /** Pure evaluation. Must not throw on well-formed bundles. */
  evaluate: (e: EvidenceBundle) => ControlVerdict;
}

/** A topic groups controls and declares scoring behaviour. */
export interface TopicModule {
  /** 1..12, matching CLAUDE.md. */
  id: number;
  name: string;
  /** Slider (2) and Video (3) may be N/A across all pages. */
  hasNA: boolean;
  /** Topics 11 (GEO) and 12 (China) are reported separately, not in the average. */
  standalone: boolean;
  controls: Control[];
}

/* ── Result shapes produced by the engine ─────────────────────────────────── */

export interface ControlResult {
  controlId: string;
  label: string;
  /** false => N/A on this page (excluded from the topic max). */
  applicable: boolean;
  passed: boolean;
  pointsAwarded: number;
  maxPoints: number;
  evidence: string;
}

export interface TopicResult {
  topicId: number;
  name: string;
  /**
   * null when the topic is N/A across all evaluated pages.
   * On a PageResult this is the binary per-page score (sum of awarded points).
   * On a SiteResult this is the proportional average across pages (sum of each
   * criterion's average), capped at 100.
   */
  score: number | null;
  controls: ControlResult[];
}

/**
 * Score of a SINGLE page (one EvidenceBundle). Each control is binary here
 * (full points or 0); the site-level average is computed across these.
 */
export interface PageResult {
  /** Requested URL of the page. */
  url: string;
  /** Optional caller-supplied label (HP/PLP/PDP). The engine leaves it undefined. */
  label?: string;
  topics: TopicResult[];
  /** Average of topics 1–10 for this page, excluding N/A. */
  overall: number | null;
  /** Topic 11 standalone. */
  geo: number | null;
  /** Topic 12 standalone. */
  china: number | null;
}

export interface SiteResult {
  site: string;
  /**
   * Per-topic site scores. Each criterion is the PROPORTIONAL AVERAGE of its
   * per-page results: `round(points × passedPages / applicablePages)`.
   */
  topics: TopicResult[];
  /** Average of topics 1–10, excluding N/A. */
  overall: number | null;
  /** Topic 11 standalone. */
  geo: number | null;
  /** Topic 12 standalone. */
  china: number | null;
  /** Per-page breakdown, in input order. */
  pages: PageResult[];
}

/* ── Collector contract (implemented in src/collector) ────────────────────── */

export interface CollectOptions {
  device?: Device;
  /** Click the cookie-consent accept button before capturing (topic 4). */
  acceptCookies?: boolean;
  /** Optional CSS selector for the accept button (per-site override). */
  cookieSelector?: string;
  /** Google CrUX/PSI API key; when absent, field data is skipped (lab only). */
  cruxApiKey?: string;
  /** Hard navigation timeout in ms. */
  timeoutMs?: number;
  /**
   * Browser provider. "playwright" (default) = vanilla headless Chromium.
   * "cloak" = CloakBrowser stealth Chromium, needed for WAF-protected sites
   * (e.g. Akamai-blocked LVMH brand sites).
   */
  browser?: "playwright" | "cloak";
  /** Proxy URL passed to the browser provider, e.g. "http://user:pass@host:port". */
  proxy?: string;
  /** Override headless mode. Defaults: playwright→true, cloak→false (stealth). */
  headless?: boolean;
}

/** The single public entry point the collector must export. */
export type CollectFn = (
  url: string,
  opts?: CollectOptions,
) => Promise<EvidenceBundle>;
