/**
 * Browser-provider selection: how a persisted/CLI/form string becomes a provider,
 * and where an escalated retry keeps its warm profile. There is deliberately no
 * fallback chain — a blocked page is retried with the SAME provider turned up
 * (see CaptureMode), never with a weaker Chromium.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import {
  asProvider,
  PROVIDERS,
  cdpEndpointAlive,
  cloakProfileDirFor,
} from "../src/collector/browser";

describe("asProvider", () => {
  it("accepts every known provider verbatim", () => {
    expect(asProvider("playwright")).toBe("playwright");
    expect(asProvider("cloak")).toBe("cloak");
    expect(asProvider("cdp")).toBe("cdp");
  });

  it("falls back to cloak for unknown / missing values", () => {
    expect(asProvider("firefox")).toBe("cloak");
    expect(asProvider("")).toBe("cloak");
    expect(asProvider(undefined)).toBe("cloak");
  });

  it("only ever returns a provider from the known list", () => {
    for (const value of ["cloak", "playwright", "cdp", "nope", undefined]) {
      expect(PROVIDERS).toContain(asProvider(value));
    }
  });
});

describe("cloakProfileDirFor", () => {
  const root = path.join("/tmp", "profiles");

  it("gives each origin its own directory — the pool may run several in parallel", () => {
    const a = cloakProfileDirFor("https://www.kenzo.com/fr/", root);
    const b = cloakProfileDirFor("https://www.buly1803.com/", root);
    expect(a).not.toBe(b);
    expect(path.basename(a)).toBe("www.kenzo.com");
  });

  it("reuses one directory for every page of the same host — that is the warmth", () => {
    expect(cloakProfileDirFor("https://www.kenzo.com/fr/hp", root)).toBe(
      cloakProfileDirFor("https://www.kenzo.com/fr/pdp/123", root),
    );
  });

  it("never escapes the root, whatever the URL looks like", () => {
    for (const url of ["not a url", "https://a b/../../x", "https://../evil"]) {
      const dir = cloakProfileDirFor(url, root);
      expect(path.dirname(dir)).toBe(root);
      expect(path.basename(dir)).not.toContain("..");
    }
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

/**
 * The escalated retry's persistent profile. cloakbrowser's
 * `launchPersistentContext` takes ONE options object carrying `userDataDir` —
 * NOT Playwright's `(userDataDir, options)` signature. Calling it the Playwright
 * way used to crash the retry with ERR_INVALID_ARG_TYPE ("path" undefined), so
 * a blocked page lost its only escalation.
 */
describe("openCloak (escalated)", () => {
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
    vi.doMock("cloakbrowser", () => ({
      launchPersistentContext: async (options: any) => {
        calls.push(options);
        return { close: async () => {} } as any;
      },
      launch: async () => ({
        newContext: async () => ({ close: async () => {} }),
        close: async () => {},
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock("cloakbrowser");
    vi.resetModules();
  });

  it("passes userDataDir inside a single options object", async () => {
    const { openBrowser } = await import("../src/collector/browser");
    const root = path.join("C:", "tmp", "profiles");
    await openBrowser({
      browser: "cloak",
      mode: "escalated",
      device: "mobile",
      cloakProfileRoot: root,
    } as any, "https://www.fresh.com/us/home");

    expect(calls).toHaveLength(1);
    const [options] = calls;
    expect(options.userDataDir).toBe(path.join(root, "www.fresh.com"));
    // Headed is the whole point of the escalation.
    expect(options.headless).toBe(false);
    // Mobile emulation that has no top-level field must travel in contextOptions.
    expect(options.viewport).toEqual({ width: 390, height: 844 });
    expect(options.contextOptions).toMatchObject({ isMobile: true, hasTouch: true });
  });

  it("falls back to a fresh headed context when the profile cannot be opened", async () => {
    vi.doMock("cloakbrowser", () => ({
      launchPersistentContext: async () => {
        throw new Error("profile locked");
      },
      launch: async () => ({
        newContext: async () => ({ close: async () => {} }),
        close: async () => {},
      }),
    }));
    const { openBrowser } = await import("../src/collector/browser");
    const opened = await openBrowser({
      browser: "cloak",
      mode: "escalated",
      device: "mobile",
    } as any, "https://www.fresh.com/us/home");
    expect(opened.context).toBeDefined();
  });
});
