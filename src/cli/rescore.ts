/**
 * Re-score already-captured EvidenceBundle JSON files (from a previous run) against
 * the current topic registry — WITHOUT re-launching the browser. Useful to validate
 * scoring/topic changes fast on real captured data.
 *
 *   npx tsx src/cli/rescore.ts
 *
 * Reads evidence/<Site>-<kind>.json, groups by site, writes out/<date>-maturity.{md,csv}.
 */
import fs from "node:fs";
import path from "node:path";
import { EvidenceBundleSchema, type EvidenceBundle } from "../core";
import { TOPICS } from "../topics";
import { scoreSite, renderMarkdown, renderCsv, loadConfig } from "../engine";
import { parseHead } from "../collector/head";

function dateString(): string {
  return new Date().toISOString().slice(0, 10);
}

const evidenceDir = path.resolve("evidence");
const outDir = path.resolve("out");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = fs
  .readdirSync(evidenceDir)
  .filter((f) => f.endsWith(".json"));

// Group by site: filename is "<site>-<kind>.json"; kind ∈ {hp,plp,pdp}.
const bySite = new Map<string, EvidenceBundle[]>();
for (const f of files) {
  const base = f.replace(/\.json$/, "");
  const m = base.match(/^(.*)-(hp|plp|pdp)$/i);
  const site = m ? m[1] : base;
  let bundle: EvidenceBundle;
  try {
    bundle = EvidenceBundleSchema.parse(
      JSON.parse(fs.readFileSync(path.join(evidenceDir, f), "utf-8")),
    );
    // Re-derive head from the stored rawHtml so improvements to parseHead apply to
    // previously-captured bundles without re-launching the browser.
    bundle.head = parseHead(bundle.rawHtml);
  } catch (err) {
    console.warn(`  skip ${f}: ${String(err).slice(0, 120)}`);
    continue;
  }
  const arr = bySite.get(site) ?? [];
  arr.push(bundle);
  bySite.set(site, arr);
}

const config = loadConfig(TOPICS, "config.json");
const results = [...bySite.entries()].map(([site, pages]) =>
  scoreSite(site, pages, TOPICS, config),
);

const date = dateString();
fs.writeFileSync(
  path.join(outDir, `${date}-maturity.md`),
  renderMarkdown(results, { date }),
  "utf-8",
);
fs.writeFileSync(
  path.join(outDir, `${date}-maturity.csv`),
  renderCsv(results),
  "utf-8",
);

console.log("Re-scored", results.length, "site(s) from", files.length, "evidence file(s).");
console.log("── Summary ──────────────────────────────");
for (const r of results) {
  console.log(
    `${r.site.padEnd(24)} overall=${r.overall ?? "N/A"}  GEO=${r.geo ?? "—"}  China=${r.china ?? "—"}`,
  );
}
