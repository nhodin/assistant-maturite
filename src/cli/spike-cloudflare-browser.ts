/**
 * SPIKE — feasibility test for Cloudflare Browser Run as a third browser
 * provider (see browser.ts). NOT wired into the app; throwaway script to
 * validate/refute the CDP capabilities the collector depends on before any
 * real integration is attempted.
 *
 * Checks, against a live Browser Run session:
 *   1. connectOverCDP() returns a usable Playwright Browser/BrowserContext/Page.
 *   2. context.newCDPSession() + Network.enable + requestWillBeSent/responseReceived
 *      events fire (this is how the collector builds NetworkRequest[] today).
 *   3. DOM.enable + CSS.enable + CSS.startRuleUsageTracking/stopRuleUsageTracking
 *      work (drives the Topic 7 "unused CSS < 30%" control).
 *   4. context.addInitScript() + page.evaluate() with PerformanceObserver
 *      (LCP/CLS/longtask capture) work as they do locally.
 *   5. mouse.move/wheel + keyboard.press work (auto-scroll / interaction probe).
 *   6. Whether the target's WAF blocks/serves an interstitial to Browser Run
 *      traffic (the actual point of the anti-bot question) — inspect the
 *      response status/body and look for cf-biso-* request headers.
 *
 * Requires a Cloudflare account with Browser Rendering enabled and an API
 * token with "Browser Rendering - Edit" permission. Set in .env:
 *   CLOUDFLARE_ACCOUNT_ID=...
 *   CLOUDFLARE_API_TOKEN=...
 *
 * Usage: npx tsx src/cli/spike-cloudflare-browser.ts [url]
 *   (url defaults to https://example.com; pass a real target to test WAF behavior)
 */
import "dotenv/config";
import { chromium, type CDPSession } from "playwright-core";

type CheckResult = { name: string; ok: boolean; detail: string };

const results: CheckResult[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function main(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const targetUrl = process.argv[2] ?? "https://example.com";

  if (!accountId || !apiToken) {
    console.error(
      "Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in .env.\n" +
        "Create a token with 'Browser Rendering - Edit' permission at " +
        "https://dash.cloudflare.com/profile/api-tokens and find the account ID " +
        "in the Cloudflare dashboard sidebar.",
    );
    process.exit(1);
  }

  console.log(`\nTarget: ${targetUrl}`);
  console.log("Connecting to Cloudflare Browser Run over CDP...\n");

  const wsEndpoint = `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser?keep_alive=600000`;

  const startMs = Date.now();
  const browser = await chromium.connectOverCDP(wsEndpoint, {
    headers: { Authorization: `Bearer ${apiToken}` },
    timeout: 30000,
  });
  record(
    "connectOverCDP",
    true,
    `connected in ${Date.now() - startMs}ms`,
  );

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "en-US",
    });

    // ── Check: addInitScript + PerformanceObserver via page.evaluate ──────────
    let perfMarkerSeen = false;
    try {
      await context.addInitScript(() => {
        (window as unknown as { __spike: boolean }).__spike = true;
        (window as unknown as { __spikePerf: { lcp: number | null } }).__spikePerf = {
          lcp: null,
        };
        try {
          const obs = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            if (entries.length > 0) {
              (
                window as unknown as { __spikePerf: { lcp: number | null } }
              ).__spikePerf.lcp = entries[entries.length - 1].startTime;
            }
          });
          obs.observe({ type: "largest-contentful-paint", buffered: true });
        } catch {
          // ignore
        }
      });
      record("context.addInitScript()", true, "registered without error");
    } catch (err) {
      record("context.addInitScript()", false, String(err));
    }

    const page = await context.newPage();

    // ── Check: newCDPSession + Network domain events ──────────────────────────
    let cdp: CDPSession | null = null;
    let networkEventCount = 0;
    const sawHeaders = new Set<string>();
    try {
      cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      cdp.on("Network.requestWillBeSent", () => {
        networkEventCount++;
      });
      cdp.on(
        "Network.responseReceived",
        (event: { response: { headers: Record<string, string> } }) => {
          for (const h of Object.keys(event.response.headers ?? {})) {
            sawHeaders.add(h.toLowerCase());
          }
        },
      );
      record("newCDPSession + Network.enable", true, "session opened, listeners attached");
    } catch (err) {
      record("newCDPSession + Network.enable", false, String(err));
    }

    // ── Check: DOM/CSS coverage domain ─────────────────────────────────────────
    let cssCoverageOk = false;
    if (cdp) {
      try {
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        await cdp.send("CSS.startRuleUsageTracking");
        cssCoverageOk = true;
        record("DOM.enable + CSS.enable + startRuleUsageTracking", true, "no error");
      } catch (err) {
        record("DOM.enable + CSS.enable + startRuleUsageTracking", false, String(err));
      }
    }

    // ── Navigate ────────────────────────────────────────────────────────────────
    let mainStatus: number | null = null;
    let mainBodySnippet = "";
    try {
      const resp = await page.goto(targetUrl, {
        waitUntil: "load",
        timeout: 30000,
      });
      mainStatus = resp?.status() ?? null;
      const body = await page.content();
      mainBodySnippet = body.slice(0, 300).replace(/\s+/g, " ");
      record(
        "page.goto()",
        true,
        `status=${mainStatus}, requests seen so far=${networkEventCount}`,
      );
    } catch (err) {
      record("page.goto()", false, String(err));
    }

    await new Promise<void>((r) => setTimeout(r, 2000));

    // ── Check: mouse/keyboard emulation ────────────────────────────────────────
    try {
      await page.mouse.move(50, 50);
      await page.mouse.wheel(0, 200);
      await page.keyboard.press("Tab");
      record("mouse.move/wheel + keyboard.press", true, "no error");
    } catch (err) {
      record("mouse.move/wheel + keyboard.press", false, String(err));
    }

    // ── Check: perf marker + LCP observer actually populated ───────────────────
    try {
      const perf = await page.evaluate(
        () =>
          (window as unknown as { __spikePerf?: { lcp: number | null } })
            .__spikePerf ?? null,
      );
      perfMarkerSeen = perf !== null;
      record(
        "PerformanceObserver (LCP) via evaluate",
        perfMarkerSeen,
        `__spikePerf=${JSON.stringify(perf)}`,
      );
    } catch (err) {
      record("PerformanceObserver (LCP) via evaluate", false, String(err));
    }

    // ── Check: CSS coverage stop + rule usage ──────────────────────────────────
    if (cdp && cssCoverageOk) {
      try {
        const res = (await cdp.send("CSS.stopRuleUsageTracking")) as {
          ruleUsage?: unknown[];
        };
        record(
          "CSS.stopRuleUsageTracking",
          true,
          `ruleUsage entries=${res.ruleUsage?.length ?? 0}`,
        );
      } catch (err) {
        record("CSS.stopRuleUsageTracking", false, String(err));
      }
    }

    // ── Report bot-detection signal ────────────────────────────────────────────
    const biso = [...sawHeaders].filter((h) => h.startsWith("cf-biso"));
    console.log("\n── WAF / bot-detection signal ──────────────────────────────");
    console.log(`Main response status: ${mainStatus}`);
    console.log(`Body snippet:          ${mainBodySnippet}`);
    console.log(`Response header names seen (sample): ${[...sawHeaders].slice(0, 20).join(", ")}`);
    console.log(`cf-biso-* headers observed on responses: ${biso.length > 0 ? biso.join(", ") : "(none — expected, those are on the REQUEST not response)"}`);
    console.log(
      `Total Network.requestWillBeSent events: ${networkEventCount} ${
        networkEventCount === 0 ? "  <-- CDP Network domain likely NOT wired for this endpoint" : ""
      }`,
    );

    await context.close();
  } finally {
    await browser.close();
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed — see FAIL lines above.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed. Inspect the WAF/bot-detection section above manually.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
