/**
 * CLI entry-point for the maturity analysis tool.
 *
 * Usage:
 *   tsx src/cli/index.ts [options]
 *
 * Options:
 *   --limit <n>              Only audit the first n sites
 *   --device <mobile|desktop> Emulation device (default: mobile)
 *   --no-cookies             Skip cookie acceptance
 *   --crux-key <key>         Google CrUX/PSI API key
 *   --out <dir>              Output directory (default: out)
 */
import { program } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import { scoreSite, loadConfig, renderMarkdown, renderCsv } from "../engine/index";

/* ── dynamic imports (built by other agents) ─────────────────────────────── */

async function loadDeps() {
  let collect: import("../core/types").CollectFn;
  let TOPICS: import("../core/types").TopicModule[];

  try {
    const collectorMod = await import("../collector");
    collect = collectorMod.collect;
  } catch (err) {
    console.error(
      "ERROR: Could not import '../collector'. Make sure the collector module is built.\n",
      String(err),
    );
    process.exit(1);
  }

  try {
    const topicsMod = await import("../topics");
    TOPICS = topicsMod.TOPICS;
  } catch (err) {
    console.error(
      "ERROR: Could not import '../topics'. Make sure the topics module is built.\n",
      String(err),
    );
    process.exit(1);
  }

  return { collect, TOPICS };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function dateString(): string {
  return new Date().toISOString().slice(0, 10);
}

interface SiteRow {
  website: string;
  url_hp: string;
  url_plp: string;
  url_pdp: string;
}

function parseCsv(filePath: string): SiteRow[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const records = parse(content, {
    delimiter: ";",
    columns: true,
    skip_empty_lines: true,
    trim: true,
    // WEBSITES.csv has a trailing ";" on the header (5 cols) but 4-col data rows.
    relax_column_count: true,
  }) as Record<string, string>[];

  return records.map((r) => ({
    website: r["website"] ?? "",
    url_hp: r["url_hp"] ?? "",
    url_plp: r["url_plp"] ?? "",
    url_pdp: r["url_pdp"] ?? "",
  }));
}

/* ── main ─────────────────────────────────────────────────────────────────── */

program
  .name("maturity-audit")
  .description("LVMH Web Performance Maturity Analysis Tool")
  .option("--limit <n>", "Only audit the first N sites", (v) => parseInt(v, 10))
  .option("--device <mobile|desktop>", "Emulation device", "mobile")
  .option("--no-cookies", "Skip cookie acceptance")
  .option("--crux-key <key>", "Google CrUX/PSI API key")
  .option("--out <dir>", "Output directory", "out")
  .action(async (opts) => {
    const { collect, TOPICS } = await loadDeps();

    // Resolve paths relative to cwd
    const csvPath = path.resolve("data", "WEBSITES.csv");
    if (!fs.existsSync(csvPath)) {
      console.error(`ERROR: WEBSITES.csv not found at ${csvPath}`);
      process.exit(1);
    }

    let sites = parseCsv(csvPath);
    if (opts.limit !== undefined) {
      sites = sites.slice(0, opts.limit);
    }

    const outDir = path.resolve(opts.out as string);
    const evidenceDir = path.resolve("evidence");
    ensureDir(outDir);
    ensureDir(evidenceDir);

    const config = loadConfig(TOPICS, "config.json");

    const device = (opts.device as string) === "desktop" ? "desktop" : "mobile";
    const acceptCookies = opts.cookies !== false; // commander: --no-cookies sets cookies=false
    const cruxApiKey = opts.cruxKey as string | undefined;

    const siteResults = [];

    for (const site of sites) {
      console.log(`\n[${site.website}] Auditing…`);
      const pages: import("../core/schema").EvidenceBundle[] = [];

      const urlMap: Record<string, string> = {
        hp: site.url_hp,
        plp: site.url_plp,
        pdp: site.url_pdp,
      };

      for (const [kind, url] of Object.entries(urlMap)) {
        if (!url) continue;
        console.log(`  → ${kind.toUpperCase()}: ${url}`);
        try {
          const bundle = await collect(url, {
            device,
            acceptCookies,
            cruxApiKey,
          });
          pages.push(bundle);

          // Write raw evidence
          const evidenceFile = path.join(
            evidenceDir,
            `${site.website}-${kind}.json`,
          );
          fs.writeFileSync(evidenceFile, JSON.stringify(bundle, null, 2), "utf-8");
          console.log(`     saved evidence → ${evidenceFile}`);
        } catch (err) {
          console.warn(
            `  WARNING: Failed to collect ${url}: ${String(err)}`,
          );
        }
      }

      if (pages.length === 0) {
        console.warn(`  WARNING: No pages collected for ${site.website}, skipping.`);
        continue;
      }

      const result = scoreSite(site.website, pages, TOPICS, config);
      siteResults.push(result);
      console.log(
        `  overall: ${result.overall !== null ? result.overall : "N/A"}`,
      );
    }

    // Write reports
    const date = dateString();
    const mdPath = path.join(outDir, `${date}-maturity.md`);
    const csvPath2 = path.join(outDir, `${date}-maturity.csv`);

    const md = renderMarkdown(siteResults, { date });
    const csv = renderCsv(siteResults);

    fs.writeFileSync(mdPath, md, "utf-8");
    fs.writeFileSync(csvPath2, csv, "utf-8");

    console.log(`\nReports written:`);
    console.log(`  ${mdPath}`);
    console.log(`  ${csvPath2}`);

    // Console summary table
    console.log("\n── Summary ──────────────────────────────────────────────");
    console.log(
      `${"Site".padEnd(30)} ${"Overall".padStart(8)}`,
    );
    console.log("─".repeat(40));
    for (const r of siteResults) {
      const score =
        r.overall !== null ? String(r.overall).padStart(8) : "     N/A";
      console.log(`${r.site.padEnd(30)} ${score}`);
    }
    console.log("");
  });

program.parseAsync(process.argv).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
