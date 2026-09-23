/**
 * Fingerprint of the rules that decide a diagnostic.
 *
 * Why this exists: the views are re-read on every request but the detection code
 * is TypeScript loaded at boot, so a server left running across a rule change
 * keeps scoring with the OLD rules. That failure is invisible — a stale verdict
 * looks exactly like a fresh one — and it has already produced a confident,
 * wrong NOGO (kiabi.com scored off a DataDome interstitial, after the guard that
 * turns it into « à confirmer » had been written). Stamping the run with the
 * rules it was produced by makes it visible instead.
 *
 * The fingerprint is a hash of the SOURCE of every module whose change can move
 * a verdict or a reported fact. It is deliberately coarse: a comment-only edit
 * bumps it too. A false "stale" costs one re-run; a false "current" costs a wrong
 * decision on a prospect, so the asymmetry is the right way round.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Modules a diagnostic's result depends on, relative to `src/`. Detection and
 * verdict first, then the collector pieces that produce the facts they read.
 */
const RULE_MODULES = [
  "prospect/detect.ts",
  "prospect/checks.ts",
  "prospect/verdict.ts",
  "collector/challenge.ts",
  "collector/bot-fetch.ts",
  "collector/stack-probe.ts",
  "collector/nav-probe.ts",
];

/** Returned when the sources cannot be read (a bundled/packaged deployment). */
export const UNKNOWN_RULES_VERSION = "unknown";

let cached: string | null = null;

/**
 * Short hash of the current rule sources. Computed once per process — the code
 * cannot change under a running process, which is precisely the problem this
 * guards against.
 */
export function diagRulesVersion(): string {
  if (cached !== null) return cached;
  const srcDir = path.join(import.meta.dirname, "..");
  const hash = createHash("sha256");
  try {
    for (const rel of RULE_MODULES) {
      hash.update(rel);
      hash.update(readFileSync(path.join(srcDir, rel), "utf-8"));
    }
    cached = hash.digest("hex").slice(0, 12);
  } catch {
    // Never fail a run over a missing source file: an unknown version reads as
    // "cannot vouch for it", which the UI reports rather than hides.
    cached = UNKNOWN_RULES_VERSION;
  }
  return cached;
}

/** How a stored run's rules compare to the ones running now. */
export type RulesFreshness = "current" | "stale" | "unknown";

/**
 * `stale` only when both versions are known AND differ — never guess. A run
 * captured before stamping existed carries no version, which is `unknown`: worth
 * saying, not worth claiming as out of date.
 */
export function rulesFreshness(stored: string | null | undefined): RulesFreshness {
  if (!stored || stored === UNKNOWN_RULES_VERSION) return "unknown";
  const current = diagRulesVersion();
  if (current === UNKNOWN_RULES_VERSION) return "unknown";
  return stored === current ? "current" : "stale";
}

/** Test seam: forget the memoized fingerprint. */
export function resetDiagRulesVersion(): void {
  cached = null;
}
