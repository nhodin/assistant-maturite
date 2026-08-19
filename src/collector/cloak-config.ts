/**
 * CloakBrowser Pro configuration — one place that turns environment variables
 * into the `launch()` options the "cloak" browser provider passes to the stealth
 * Chromium.
 *
 * Everything is optional: with no variables set the provider behaves exactly as
 * before (free tier, no proxy, humanize/careful). Dropping a Pro license key in
 * `.env` as `CLOAKBROWSER_LICENSE_KEY` is the only step needed to switch the
 * capture to the Pro binary — the key is read here AND, independently, by the
 * browser binary itself from its own process environment.
 *
 * Variables (all optional, see .env.example):
 *   CLOAKBROWSER_LICENSE_KEY    cb_xxxxx — Pro license. Also readable from
 *                               ~/.cloakbrowser/license.key by the binary.
 *   CLOAKBROWSER_RELEASE_CHANNEL  stable | preview
 *   CLOAKBROWSER_VERSION        exact Chromium version pin
 *   CLOAK_PROXY                 http://user:pass@host:port (or socks5://…)
 *   CLOAK_GEOIP                 1 → align timezone/locale with the proxy IP
 *   CLOAK_HUMANIZE              0 → disable human-like mouse/keyboard/scroll
 *   CLOAK_HUMAN_PRESET          default | careful   (default: careful)
 *   CLOAK_HEADLESS              0 → force HEADED from the first attempt. Captures
 *                               start headless by default (vendor guidance:
 *                               headed is the escalation after a block, not the
 *                               starting point).
 */

import { createRequire } from "node:module";

/** Resolved CloakBrowser settings, before they become `launch()` options. */
export interface CloakConfig {
  /** Pro license key, or undefined for the free tier. */
  licenseKey?: string;
  /** Proxy URL handed to the browser, credentials included. */
  proxy?: string;
  /** Align timezone/locale with the proxy IP (needs the `mmdb-lib` package). */
  geoip: boolean;
  /** Human-like input emulation. */
  humanize: boolean;
  humanPreset: "default" | "careful";
  /** Explicit headless choice; undefined leaves the provider's own default in place. */
  headless?: boolean;
  releaseChannel?: "stable" | "preview";
  browserVersion?: string;
}

type Env = Record<string, string | undefined>;

/** Trimmed value, or undefined when unset/blank. */
function str(env: Env, name: string): string | undefined {
  const value = (env[name] ?? "").trim();
  return value === "" ? undefined : value;
}

/** "1"/"true"/"yes"/"on" → true, "0"/"false"/"no"/"off" → false, else fallback. */
function bool(env: Env, name: string, fallback: boolean): boolean {
  const value = str(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

/**
 * `geoip: true` silently needs the optional `mmdb-lib` peer dependency. Checking
 * here turns a confusing launch-time failure into a warning plus a capture that
 * still runs — geo alignment is a refinement, never a reason to lose the audit.
 */
export function geoipAvailable(): boolean {
  try {
    // Resolution only — mmdb-lib is an optional peer dependency of cloakbrowser.
    createRequire(import.meta.url).resolve("mmdb-lib");
    return true;
  } catch {
    return false;
  }
}

/** Read the CloakBrowser settings out of the environment (defaults applied). */
export function cloakConfigFromEnv(env: Env = process.env): CloakConfig {
  const preset = str(env, "CLOAK_HUMAN_PRESET")?.toLowerCase();
  const channel = str(env, "CLOAKBROWSER_RELEASE_CHANNEL")?.toLowerCase();
  const headless = str(env, "CLOAK_HEADLESS");

  return {
    licenseKey: str(env, "CLOAKBROWSER_LICENSE_KEY"),
    proxy: str(env, "CLOAK_PROXY"),
    geoip: bool(env, "CLOAK_GEOIP", false),
    humanize: bool(env, "CLOAK_HUMANIZE", true),
    humanPreset: preset === "default" ? "default" : "careful",
    headless: headless === undefined ? undefined : bool(env, "CLOAK_HEADLESS", false),
    releaseChannel: channel === "preview" || channel === "stable" ? channel : undefined,
    browserVersion: str(env, "CLOAKBROWSER_VERSION"),
  };
}

/**
 * Build the object handed to `cloakbrowser`'s `launch()`.
 *
 * `overrides` carries what the caller already decided (a `--proxy` CLI flag, an
 * explicit headless choice); it wins over the environment, which wins over the
 * defaults. Keys are omitted rather than set to undefined so cloakbrowser's own
 * fallbacks (env var, license file) stay in play.
 */
export function cloakLaunchOptions(
  cfg: CloakConfig,
  overrides: {
    proxy?: string;
    headless?: boolean;
    humanize?: boolean;
    humanPreset?: "default" | "careful";
  } = {},
): Record<string, unknown> {
  const proxy = overrides.proxy ?? cfg.proxy;
  // Headless by default: it needs no display and is simpler to run. A site that
  // blocks or challenges us gets ONE headed retry (see CaptureMode) — headless is
  // detectable on its own, so headed is the escalation, not the starting point.
  const headless = overrides.headless ?? cfg.headless ?? true;
  const geoip = cfg.geoip && !!proxy && geoipAvailable();

  return {
    headless,
    humanize: overrides.humanize ?? cfg.humanize,
    humanPreset: overrides.humanPreset ?? cfg.humanPreset,
    ...(cfg.licenseKey ? { licenseKey: cfg.licenseKey } : {}),
    ...(proxy ? { proxy } : {}),
    ...(geoip ? { geoip: true } : {}),
    ...(cfg.releaseChannel ? { releaseChannel: cfg.releaseChannel } : {}),
    ...(cfg.browserVersion ? { browserVersion: cfg.browserVersion } : {}),
  };
}

/** `cb_1234…cdef` — enough to recognise a key, not enough to reuse it. */
export function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  return key.length <= 12 ? "cb_****" : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Proxy string with the password replaced — safe to print in logs. */
export function maskProxy(proxy: string | undefined): string {
  if (!proxy) return "(none)";
  return proxy.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:****@");
}

/** Human-readable, secret-free summary for CLI output and diagnostics. */
export function describeCloakConfig(cfg: CloakConfig): string[] {
  const lines = [
    `license      ${maskKey(cfg.licenseKey)}${cfg.licenseKey ? "" : "  → free tier"}`,
    `proxy        ${maskProxy(cfg.proxy)}`,
    `geoip        ${cfg.geoip ? (geoipAvailable() ? "on" : "requested but mmdb-lib is missing → off") : "off"}`,
    `humanize     ${cfg.humanize ? `on (${cfg.humanPreset})` : "off"}`,
    `headless     ${cfg.headless === undefined ? "default (headless; headed on retry)" : cfg.headless}`,
  ];
  if (cfg.releaseChannel) lines.push(`channel      ${cfg.releaseChannel}`);
  if (cfg.browserVersion) lines.push(`version      ${cfg.browserVersion}`);
  return lines;
}
