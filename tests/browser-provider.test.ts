/**
 * Browser-provider selection: how a persisted/CLI/form string becomes a provider,
 * and in which order providers are retried when a capture fails or is rejected by
 * the health check.
 */
import { describe, it, expect } from "vitest";
import {
  asProvider,
  fallbackChain,
  providersAfterFailure,
  PROVIDER_PRIORITY,
  cdpEndpointAlive,
} from "../src/collector/browser";

describe("asProvider", () => {
  it("accepts every known provider verbatim", () => {
    expect(asProvider("playwright")).toBe("playwright");
    expect(asProvider("cloak")).toBe("cloak");
    expect(asProvider("cdp")).toBe("cdp");
  });

  it("falls back to playwright for unknown / missing values", () => {
    expect(asProvider("firefox")).toBe("playwright");
    expect(asProvider("")).toBe("playwright");
    expect(asProvider(undefined)).toBe("playwright");
  });
});

describe("fallbackChain", () => {
  it("puts the primary first and keeps every other provider", () => {
    expect(fallbackChain("cloak")).toEqual(["cloak", "playwright", "cdp"]);
    expect(fallbackChain("playwright")).toEqual(["playwright", "cloak", "cdp"]);
    expect(fallbackChain("cdp")).toEqual(["cdp", "cloak", "playwright"]);
  });

  it("never repeats a provider and covers all of them", () => {
    for (const primary of PROVIDER_PRIORITY) {
      const chain = fallbackChain(primary);
      expect(new Set(chain).size).toBe(chain.length);
      expect(new Set(chain)).toEqual(new Set(PROVIDER_PRIORITY));
    }
  });

  it("keeps cdp last unless it is the primary — it needs a graphical session", () => {
    expect(fallbackChain("cloak").at(-1)).toBe("cdp");
    expect(fallbackChain("playwright").at(-1)).toBe("cdp");
  });
});

describe("providersAfterFailure", () => {
  const chain = fallbackChain("cloak"); // ["cloak", "playwright", "cdp"]

  it("keeps every remaining provider after a technical failure", () => {
    expect(providersAfterFailure(chain, ["cloak"], "unusable")).toEqual([
      "playwright",
      "cdp",
    ]);
  });

  it("escalates ONCE, to the strongest provider left, after a WAF block", () => {
    // Not ["playwright", "cdp"]: each extra hit on a blocking origin degrades the
    // IP's standing, so we jump straight to the most human-like client.
    expect(providersAfterFailure(chain, ["cloak"], "blocked")).toEqual(["cdp"]);
  });

  it("stops once the strongest provider has itself been blocked", () => {
    expect(providersAfterFailure(chain, ["cloak", "cdp"], "blocked")).toEqual([]);
  });

  it("never proposes a provider that was already attempted", () => {
    for (const kind of ["blocked", "unusable"] as const) {
      const next = providersAfterFailure(chain, ["cloak", "playwright"], kind);
      expect(next).not.toContain("cloak");
      expect(next).not.toContain("playwright");
    }
  });

  it("returns nothing when the whole chain has been attempted", () => {
    expect(providersAfterFailure(chain, [...chain], "unusable")).toEqual([]);
    expect(providersAfterFailure(chain, [...chain], "blocked")).toEqual([]);
  });
});

describe("cdpEndpointAlive", () => {
  it("returns false (rather than throwing) when nothing listens", async () => {
    // Port picked well outside the usual debugging range; nothing should answer.
    await expect(cdpEndpointAlive("http://127.0.0.1:59987", 300)).resolves.toBe(false);
  });

  it("returns false on a malformed endpoint instead of throwing", async () => {
    await expect(cdpEndpointAlive("not-a-url", 300)).resolves.toBe(false);
  });
});
