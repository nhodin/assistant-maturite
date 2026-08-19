/**
 * Capture concurrency — how many browser sessions the collector may drive at the
 * same time, and how the pages of a run are sliced so that parallelism never
 * points two sessions at the same origin.
 *
 * Two hard constraints shape this:
 *
 *  1. CloakBrowser licences sessions. The free tier allows ONE concurrent
 *     session; a Pro plan allows 5, 20, 200… Exceeding the plan makes `launch()`
 *     fail, so the pool size is a licence question before it is a hardware one.
 *  2. The audit measures performance. Every extra session shares the machine's
 *     CPU and bandwidth with the one being timed, so TTFB/LCP drift upward as
 *     the pool grows. Small pools keep the lab numbers trustworthy.
 *
 * And one soft constraint that decides the SHAPE of the parallelism: WAFs count
 * per origin. `groupByOrigin` keeps every page of an origin inside a single
 * sequential bucket, so widening the pool adds brands running side by side, never
 * simultaneous hits on one brand — which is precisely the pattern that hardened
 * Akamai against us (see the notes in browser.ts / runner.ts).
 *
 * Variables (optional, see .env.example):
 *   CAPTURE_CONCURRENCY   origins captured in parallel (default 2)
 *   CLOAK_SESSION_LIMIT   sessions the CloakBrowser plan allows (default 5)
 */

/** Origins captured in parallel when CAPTURE_CONCURRENCY is unset. */
export const DEFAULT_CAPTURE_CONCURRENCY = 2;

/** Concurrent sessions the current CloakBrowser plan allows. */
export const DEFAULT_CLOAK_SESSION_LIMIT = 5;

export interface CaptureConcurrency {
  /** Number of origins to capture in parallel. Always >= 1. */
  slots: number;
  /** Set when the request was clamped, invalid, or exceeds the licensed sessions. */
  warning?: string;
}

type Env = Record<string, string | undefined>;

/** Positive integer, or undefined when unset/blank/malformed. */
function positiveInt(env: Env, name: string): number | undefined {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Resolve the pool size from the environment.
 *
 * A value above the licensed session count is NOT clamped: the licence limit is
 * declared by the operator, not observed, and silently shrinking the pool would
 * hide a plan/config mismatch behind a slow run. We warn and let the launch fail
 * loudly if the plan really is smaller.
 */
export function captureConcurrencyFromEnv(env: Env = process.env): CaptureConcurrency {
  const limit = positiveInt(env, "CLOAK_SESSION_LIMIT") ?? DEFAULT_CLOAK_SESSION_LIMIT;
  const raw = (env.CAPTURE_CONCURRENCY ?? "").trim();
  const slots = positiveInt(env, "CAPTURE_CONCURRENCY");

  if (slots === undefined) {
    return raw === ""
      ? { slots: DEFAULT_CAPTURE_CONCURRENCY }
      : {
          slots: DEFAULT_CAPTURE_CONCURRENCY,
          warning:
            `CAPTURE_CONCURRENCY="${raw}" is not a positive integer — ` +
            `falling back to ${DEFAULT_CAPTURE_CONCURRENCY}.`,
        };
  }

  if (slots > limit) {
    return {
      slots,
      warning:
        `CAPTURE_CONCURRENCY=${slots} exceeds the ${limit} concurrent session(s) ` +
        `of the CloakBrowser plan — captures beyond the ${limit}th will fail to ` +
        `launch. Lower it, or raise CLOAK_SESSION_LIMIT after upgrading the plan.`,
    };
  }

  return { slots };
}

/**
 * Slice `items` into buckets that share an origin, preserving input order both
 * between buckets (first-seen origin first) and inside them. Each bucket is meant
 * to be processed sequentially; buckets run in parallel.
 */
export function groupByOrigin<T>(items: T[], originOf: (item: T) => string): T[][] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const origin = originOf(item);
    const bucket = buckets.get(origin);
    if (bucket) bucket.push(item);
    else buckets.set(origin, [item]);
  }
  return [...buckets.values()];
}

/**
 * Run `tasks` with at most `slots` in flight, returning their results in input
 * order. Workers pull from a shared cursor, so a slow bucket never idles the
 * others. A task that throws rejects the whole pool — callers whose per-item work
 * must not abort the run (the executor's `capturePage`) catch inside the task.
 */
export async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  slots: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]!();
    }
  };

  const width = Math.max(1, Math.min(slots, tasks.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
