/**
 * Debug runner: collects one URL, validates the EvidenceBundle, prints a summary,
 * and writes the full bundle to evidence/<host>.json
 *
 * Usage: npx tsx src/cli/collect.ts <url>
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { collect } from "../collector/index";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = join(__filename, "..", "..", "..");

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npx tsx src/cli/collect.ts <url>");
    process.exit(1);
  }

  console.log(`\nCollecting: ${url}`);
  console.log("This may take up to 60 seconds...\n");

  const startMs = Date.now();
  let bundle;
  try {
    bundle = await collect(url, {
      device: "mobile",
      acceptCookies: true,
      timeoutMs: 45000,
    });
  } catch (err) {
    console.error("Collection failed:", err);
    process.exit(1);
  }

  const elapsedMs = Date.now() - startMs;

  // Print summary
  console.log("═".repeat(60));
  console.log("EVIDENCE BUNDLE SUMMARY");
  console.log("═".repeat(60));
  console.log(`URL:              ${bundle.url}`);
  console.log(`Final URL:        ${bundle.finalUrl}`);
  console.log(`Device:           ${bundle.device}`);
  console.log(`Captured at:      ${bundle.capturedAt}`);
  console.log(`Elapsed:          ${elapsedMs}ms`);
  console.log("");
  console.log("── Requests ──────────────────────────────────────────────");
  console.log(`Total requests:   ${bundle.requests.length}`);
  console.log(
    `Total bytes:      ${(bundle.perf.totalBytes / 1024).toFixed(1)} KB`,
  );
  const byType = bundle.requests.reduce<Record<string, number>>((acc, r) => {
    acc[r.resourceType] = (acc[r.resourceType] ?? 0) + 1;
    return acc;
  }, {});
  for (const [type, count] of Object.entries(byType).sort()) {
    console.log(`  ${type.padEnd(15)} ${count}`);
  }
  console.log("");
  console.log("── Performance ────────────────────────────────────────────");
  console.log(`TTFB:             ${bundle.perf.ttfbMs?.toFixed(0) ?? "null"} ms`);
  console.log(`LCP:              ${bundle.perf.lcpMs?.toFixed(0) ?? "null"} ms`);
  console.log(`CLS:              ${bundle.perf.cls?.toFixed(4) ?? "null"}`);
  console.log(`Long tasks:       ${bundle.perf.longTasks.length}`);
  if (bundle.perf.lcpElement) {
    const el = bundle.perf.lcpElement;
    console.log(`LCP element:      <${el.tagName}>${el.selector ? ` [${el.selector}]` : ""}`);
    if (el.src) console.log(`LCP src:          ${el.src.slice(0, 80)}`);
    console.log(
      `LCP loading:      ${el.loadingAttr ?? "(none)"}  fetchpriority: ${el.fetchPriorityAttr ?? "(none)"}`,
    );
  } else {
    console.log(`LCP element:      null`);
  }
  console.log("");
  console.log("── Network probe ──────────────────────────────────────────");
  console.log(`TLS version:      ${bundle.network.tlsVersion ?? "null"}`);
  console.log(`ALPN:             ${bundle.network.alpn ?? "null"}`);
  console.log(`IPv6:             ${String(bundle.network.ipv6)}`);
  console.log(`HTTP/3:           ${String(bundle.network.http3)}`);
  console.log("");
  console.log("── Head ───────────────────────────────────────────────────");
  console.log(`Head tags:        ${bundle.head.tags.length}`);
  console.log(`Head order:       ${bundle.head.order.join(", ")}`);
  console.log("");
  console.log("── Fonts ──────────────────────────────────────────────────");
  console.log(`@font-face:       ${bundle.fonts.length}`);
  for (const f of bundle.fonts.slice(0, 5)) {
    console.log(
      `  ${f.family ?? "(no family)"}  display:${f.fontDisplay ?? "?"} format:${f.format ?? "?"}`,
    );
  }
  console.log("");
  console.log("── Features ───────────────────────────────────────────────");
  console.log(`Slider detected:  ${bundle.features.sliderDetected}`);
  console.log(`Video detected:   ${bundle.features.videoDetected}`);
  console.log(`Cookie accepted:  ${bundle.features.cookieAccepted}`);
  console.log("");
  console.log("── Main response headers (sample) ─────────────────────────");
  const interestingHeaders = [
    "cache-control",
    "x-cache",
    "cf-cache-status",
    "content-encoding",
    "server",
    "content-type",
    "alt-svc",
  ];
  for (const h of interestingHeaders) {
    const v = bundle.mainResponseHeaders[h];
    if (v) console.log(`  ${h}: ${v}`);
  }
  console.log("═".repeat(60));

  // Write to evidence/<host>.json
  const host = new URL(bundle.finalUrl).hostname;
  const safeHost = host.replace(/[^a-zA-Z0-9._-]/g, "_");
  const evidenceDir = join(projectRoot, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const outPath = join(evidenceDir, `${safeHost}.json`);
  writeFileSync(outPath, JSON.stringify(bundle, null, 2), "utf-8");
  console.log(`\nBundle written to: ${outPath}`);
  console.log(`Raw HTML length:  ${bundle.rawHtml.length} chars`);
  console.log(`Rendered HTML:    ${bundle.renderedHtml.length} chars`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
