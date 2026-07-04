/**
 * Public API of the scoring engine.
 *
 * Import everything you need from this module:
 *   import { scoreSite, renderMarkdown, renderCsv, loadConfig } from "./engine"
 */
import * as fs from "node:fs";
import type { TopicModule, ControlConfig, SiteResult } from "../core/types";
import { DEFAULT_CONTROL_CONFIG } from "../core/types";
import type { EvidenceBundle } from "../core/schema";
import { scoreSite as _scoreSite } from "./score";
import { renderMarkdown as _renderMarkdown, renderCsv as _renderCsv } from "./report";

/* ── ConfigMap ────────────────────────────────────────────────────────────── */

/** Keyed by control id. Missing keys fall back to DEFAULT_CONTROL_CONFIG. */
export type ConfigMap = Record<string, ControlConfig>;

/* ── defaultConfig ────────────────────────────────────────────────────────── */

/**
 * Build a ConfigMap with every control set to DEFAULT_CONTROL_CONFIG.
 * The engine uses this as the base; `loadConfig` merges file overrides on top.
 */
export function defaultConfig(topics: TopicModule[]): ConfigMap {
  const map: ConfigMap = {};
  for (const topic of topics) {
    for (const control of topic.controls) {
      map[control.id] = { ...DEFAULT_CONTROL_CONFIG };
    }
  }
  return map;
}

/* ── loadConfig ───────────────────────────────────────────────────────────── */

/**
 * Start from defaultConfig, then merge overrides from a JSON file if it exists.
 *
 * JSON shape: `{ [controlId]: Partial<ControlConfig> }`
 *
 * Example:
 * ```json
 * {
 *   "images.lazyload": { "pointsOverride": 20 },
 *   "cdn.brotli": { "enabled": false }
 * }
 * ```
 */
export function loadConfig(topics: TopicModule[], path?: string): ConfigMap {
  const base = defaultConfig(topics);
  if (!path) return base;

  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch {
    // File doesn't exist — silently use defaults
    return base;
  }

  let overrides: Record<string, Partial<ControlConfig>>;
  try {
    overrides = JSON.parse(raw) as Record<string, Partial<ControlConfig>>;
  } catch (err) {
    throw new Error(`Failed to parse config file ${path}: ${String(err)}`);
  }

  for (const [id, partial] of Object.entries(overrides)) {
    const existing = base[id] ?? { ...DEFAULT_CONTROL_CONFIG };
    base[id] = { ...existing, ...partial };
  }

  return base;
}

/* ── scoreSite ────────────────────────────────────────────────────────────── */

/**
 * Score a single site across all its pages for all provided topics.
 *
 * @param site     Display name of the site (e.g. "BULY1803").
 * @param pages    One EvidenceBundle per page (HP/PLP/PDP).
 * @param topics   Topic modules to evaluate (dependency-injected for testability).
 * @param config   Optional ConfigMap; defaults to defaultConfig(topics).
 */
export function scoreSite(
  site: string,
  pages: EvidenceBundle[],
  topics: TopicModule[],
  config?: ConfigMap,
): SiteResult {
  const cfg = config ?? defaultConfig(topics);
  return _scoreSite(site, pages, topics, cfg);
}

/* ── report helpers ───────────────────────────────────────────────────────── */

/**
 * Render a Markdown maturity report from an array of site results.
 * Pass `meta.date` to override the date in the heading.
 */
export function renderMarkdown(
  results: SiteResult[],
  meta?: { date?: string },
): string {
  return _renderMarkdown(results, meta);
}

/**
 * Render a semicolon-delimited CSV with the fixed column header from CLAUDE.md.
 */
export function renderCsv(results: SiteResult[]): string {
  return _renderCsv(results);
}

/* ── re-export score internals for advanced use ───────────────────────────── */
export { scoreSite as _scoreSiteRaw, scorePage } from "./score";
