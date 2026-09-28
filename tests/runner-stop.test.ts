/**
 * « ⏹ Arrêter » on a running run (pure part — no DB, no browser): the pages in
 * capture finish, the ones behind them never start, and the skipped pages are
 * returned so the executor can leave the run resumable. See runner.stopRun.
 */
import { describe, it, expect } from "vitest";
import { captureBuckets, stopRun, isStopping } from "../src/web/runner";

/** A capture that resolves when told to, recording starts and ends. */
function controlledCapture() {
  const started: string[] = [];
  const finished: string[] = [];
  const release = new Map<string, () => void>();
  const capture = (item: string) =>
    new Promise<void>((resolve) => {
      started.push(item);
      release.set(item, () => {
        finished.push(item);
        resolve();
      });
    });
  return { started, finished, release, capture };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("captureBuckets", () => {
  it("captures every page when nothing stops it", async () => {
    const done: string[] = [];
    const skipped = await captureBuckets(
      [["a1", "a2"], ["b1"]],
      2,
      async (x) => {
        done.push(x);
      },
      new AbortController().signal,
    );
    expect(skipped).toEqual([]);
    expect(done.sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("lets the captures in flight finish and starts none after the stop", async () => {
    const c = controlledCapture();
    const stop = new AbortController();
    const pending = captureBuckets([["a1", "a2", "a3"], ["b1", "b2"], ["c1"]], 2, c.capture, stop.signal);
    await tick();
    expect(c.started).toEqual(["a1", "b1"]); // two slots busy

    stop.abort();
    c.release.get("a1")!();
    c.release.get("b1")!();
    const skipped = await pending;

    expect(c.finished).toEqual(["a1", "b1"]); // in flight: finished, not cut
    expect(c.started).toEqual(["a1", "b1"]); // nothing started after the stop
    // Rest of the started buckets, then the bucket that never got a slot.
    expect(skipped).toEqual(["a2", "a3", "b2", "c1"]);
  });

  it("skips everything when stopped before the first capture", async () => {
    const stop = new AbortController();
    stop.abort();
    const started: string[] = [];
    const skipped = await captureBuckets(
      [["a1"], ["b1", "b2"]],
      2,
      async (x) => {
        started.push(x);
      },
      stop.signal,
    );
    expect(started).toEqual([]);
    expect(skipped).toEqual(["a1", "b1", "b2"]);
  });

  it("reports nothing skipped when the stop comes after the last page started", async () => {
    const c = controlledCapture();
    const stop = new AbortController();
    const pending = captureBuckets([["a1"], ["b1"]], 2, c.capture, stop.signal);
    await tick();
    stop.abort();
    c.release.get("a1")!();
    c.release.get("b1")!();
    // The run then completes normally: the stop prevented nothing.
    expect(await pending).toEqual([]);
  });
});

describe("stopRun", () => {
  it("refuses a run that is not executing in this process", () => {
    const res = stopRun(999_999);
    expect(res.stopping).toBe(false);
    expect(res.reason).toMatch(/pas en cours/);
    expect(isStopping(999_999)).toBe(false);
  });
});
