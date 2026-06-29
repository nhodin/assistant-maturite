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
  /** null when the topic is N/A across all evaluated pages. */
  score: number | null;
  controls: ControlResult[];
}

export interface SiteResult {
  site: string;
  topics: TopicResult[];
  /** Average of topics 1–10, excluding N/A. */
  overall: number | null;
  /** Topic 11 standalone. */
  geo: number | null;
  /** Topic 12 standalone. */
  china: number | null;
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
}

/** The single public entry point the collector must export. */
export type CollectFn = (
  url: string,
  opts?: CollectOptions,
) => Promise<EvidenceBundle>;
