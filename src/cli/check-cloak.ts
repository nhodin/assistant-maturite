/**
 * CloakBrowser Pro smoke test — verifies the licence, the binary and the stealth
 * fingerprint end to end, without touching the audit pipeline.
 *
 * Usage:
 *   npm run cloak:check                       # default target: bot.sannysoft.com
 *   npm run cloak:check -- https://some.site  # any URL
 *
 * Reads everything from .env (see .env.example). With no licence key it still
 * runs — on the free binary — and says so, which makes the before/after obvious.
 */
import "dotenv/config";
import {
  cloakConfigFromEnv,
  cloakLaunchOptions,
  describeCloakConfig,
  geoipAvailable,
} from "../collector/cloak-config";

const DEFAULT_TARGET = "https://bot.sannysoft.com/";

/** Section header, so the three phases are readable in a terminal. */
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const cfg = cloakConfigFromEnv();

  section("Configuration (.env)");
  for (const line of describeCloakConfig(cfg)) console.log(`  ${line}`);
  if (cfg.geoip && !geoipAvailable()) {
    console.log("\n  ⚠ CLOAK_GEOIP=1 but `mmdb-lib` is not installed → geoip disabled.");
    console.log("    Fix: npm i mmdb-lib");
  }
  if (cfg.geoip && !cfg.proxy) {
    console.log("\n  ⚠ CLOAK_GEOIP=1 has no effect without CLOAK_PROXY.");
  }

  const cloak: any = await import("cloakbrowser");

  section("Licence");
  if (!cfg.licenseKey) {
    console.log("  Aucune clé — le binaire gratuit sera utilisé.");
    console.log("  Ajoute CLOAKBROWSER_LICENSE_KEY=cb_… dans app/.env pour activer le Pro.");
  } else {
    let info: any = null;
    try {
      info = await cloak.validateLicense(cfg.licenseKey);
    } catch {
      info = null;
    }
    if (!info) {
      console.log("  ✗ Validation impossible (serveur injoignable ou clé refusée).");
    } else {
      console.log(`  ${info.valid ? "✓" : "✗"} valid=${info.valid}  plan=${info.plan}  expires=${info.expires ?? "—"}`);
    }
  }

  section("Binaire");
  // binaryInfo() is sync in the current build but typed loosely — await covers both.
  let info: any = null;
  try {
    info = await cloak.binaryInfo();
  } catch (err) {
    console.log(`  ✗ binaryInfo() a échoué : ${(err as Error).message}`);
  }
  if (info) {
    console.log(`  tier=${info.tier}  version=${info.version}  platform=${info.platform}`);
    console.log(`  installed=${info.installed}  path=${info.binaryPath}`);
    if (!info.installed) {
      console.log("  → le binaire (~535 Mo) sera téléchargé au premier lancement.");
    }
  }

  section(`Lancement → ${target}`);
  const launchOptions = cloakLaunchOptions(cfg);
  const browser = await cloak.launch(launchOptions);
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await context.newPage();
    const response = await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // The three signals that tell a stealth failure apart from a network failure.
    const probe = await page.evaluate(() => ({
      webdriver: (navigator as any).webdriver,
      userAgent: navigator.userAgent,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      plugins: navigator.plugins.length,
    }));

    console.log(`  HTTP ${response?.status() ?? "—"}  ${await page.title()}`);
    console.log(`  navigator.webdriver = ${probe.webdriver}  ${probe.webdriver ? "✗ détectable" : "✓"}`);
    console.log(`  UA        ${probe.userAgent}`);
    console.log(`  languages ${probe.languages.join(", ")}  timezone ${probe.timezone}`);
    console.log(`  plugins   ${probe.plugins}`);

    // Public IP — the fastest way to confirm the proxy is actually in the path.
    const ip = await page
      .evaluate(async () => {
        const res = await fetch("https://api.ipify.org?format=json");
        return (await res.json()).ip as string;
      })
      .catch(() => null);
    console.log(`  IP sortante ${ip ?? "(non déterminée)"}${cfg.proxy ? "  (proxy attendu)" : ""}`);

    console.log("\n  ✓ Lancement OK.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
