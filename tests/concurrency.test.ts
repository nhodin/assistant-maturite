import { describe, it, expect } from "vitest";
import {
  captureConcurrencyFromEnv,
  groupByOrigin,
  runPool,
  DEFAULT_CAPTURE_CONCURRENCY,
} from "../src/collector/concurrency";

describe("captureConcurrencyFromEnv", () => {
  it("defaults to 2 origins in parallel, without a warning", () => {
    expect(captureConcurrencyFromEnv({})).toEqual({ slots: DEFAULT_CAPTURE_CONCURRENCY });
  });

  it("reads an explicit value within the licensed sessions", () => {
    expect(captureConcurrencyFromEnv({ CAPTURE_CONCURRENCY: " 5 " })).toEqual({ slots: 5 });
  });

  it("treats a blank value as unset, so a commented-out .env line is harmless", () => {
    expect(captureConcurrencyFromEnv({ CAPTURE_CONCURRENCY: "   " })).toEqual({
      slots: DEFAULT_CAPTURE_CONCURRENCY,
    });
  });

  it("warns and keeps the value when it exceeds the licensed sessions", () => {
    const { slots, warning } = captureConcurrencyFromEnv({ CAPTURE_CONCURRENCY: "6" });
    expect(slots).toBe(6);
    expect(warning).toMatch(/exceeds the 5 concurrent session/);
  });

  it("respects a raised session limit after a plan upgrade", () => {
    expect(
      captureConcurrencyFromEnv({ CAPTURE_CONCURRENCY: "20", CLOAK_SESSION_LIMIT: "20" }),
    ).toEqual({ slots: 20 });
  });

  it.each(["0", "-1", "2.5", "many"])(
    "falls back to the default and warns on the malformed value %s",
    (value) => {
      const { slots, warning } = captureConcurrencyFromEnv({ CAPTURE_CONCURRENCY: value });
      expect(slots).toBe(DEFAULT_CAPTURE_CONCURRENCY);
      expect(warning).toMatch(/not a positive integer/);
    },
  );
});

describe("groupByOrigin", () => {
  const originOf = (url: string) => new URL(url).origin;

  it("keeps every page of an origin in one bucket, in first-seen order", () => {
    const pages = [
      "https://a.com/hp",
      "https://b.com/hp",
      "https://a.com/plp",
      "https://b.com/pdp",
      "https://a.com/pdp",
    ];
    expect(groupByOrigin(pages, originOf)).toEqual([
      ["https://a.com/hp", "https://a.com/plp", "https://a.com/pdp"],
      ["https://b.com/hp", "https://b.com/pdp"],
    ]);
  });

  it("separates origins that share a registrable domain — the WAF counts per origin", () => {
    const pages = ["https://fr.lv.com/hp", "https://us.lv.com/hp"];
    expect(groupByOrigin(pages, originOf)).toHaveLength(2);
  });

  it("returns no bucket for an empty run", () => {
    expect(groupByOrigin([], originOf)).toEqual([]);
  });
});

describe("runPool", () => {
  /** Resolves after `ticks` macrotask turns, so interleaving is observable. */
  const after = (ticks: number, fn: () => void): Promise<void> =>
    new Promise((resolve) => {
      let left = ticks;
      const step = () => (left-- > 0 ? setTimeout(step, 0) : (fn(), resolve()));
      step();
    });

  it("returns results in input order, whatever the completion order", async () => {
    const results = await runPool(
      [
        () => after(3, () => {}).then(() => "slow"),
        () => Promise.resolve("fast"),
        () => after(1, () => {}).then(() => "middle"),
      ],
      3,
    );
    expect(results).toEqual(["slow", "fast", "middle"]);
  });

  it("never exceeds the slot count", async () => {
    let live = 0;
    let peak = 0;
    const tasks = Array.from({ length: 9 }, () => async () => {
      peak = Math.max(peak, ++live);
      await after(2, () => {});
      live--;
    });
    await runPool(tasks, 3);
    expect(peak).toBe(3);
  });

  it("keeps every slot busy — a slow task must not idle the others", async () => {
    const order: number[] = [];
    const tasks = [
      async () => {
        await after(6, () => {});
        order.push(0);
      },
      ...Array.from({ length: 4 }, (_, i) => async () => {
        order.push(i + 1);
      }),
    ];
    await runPool(tasks, 2);
    // The 4 quick tasks all ran on the second slot while task 0 was still going.
    expect(order).toEqual([1, 2, 3, 4, 0]);
  });

  it("runs sequentially when given a single slot", async () => {
    let live = 0;
    let peak = 0;
    const tasks = Array.from({ length: 4 }, () => async () => {
      peak = Math.max(peak, ++live);
      await after(1, () => {});
      live--;
    });
    await runPool(tasks, 1);
    expect(peak).toBe(1);
  });

  it("handles an empty task list", async () => {
    expect(await runPool([], 4)).toEqual([]);
  });
});
