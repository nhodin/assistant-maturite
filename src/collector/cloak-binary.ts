/**
 * CloakBrowser binary warm-up.
 *
 * `cloakbrowser`'s own `ensureBinary` has NO cross-process or cross-call lock:
 * every caller downloads the ~515 MB archive to its own temp file, then
 * `extractArchive` does `rmSync(destDir, { recursive: true, force: true })`
 * before extracting. So N concurrent captures on a cold cache do not merely
 * waste N × 515 MB of bandwidth — the second one to finish DELETES the Chromium
 * the first one just installed, possibly while it is being launched.
 *
 * A run captures several pages in parallel, so a cold cache (a fresh checkout, or
 * a Chromium version bump) hits exactly that. The fix is to do the download ONCE,
 * before anything can run: the server calls `startCloakWarmUp()` at boot, and the
 * run executor awaits the same memoized promise before opening any browser — so a
 * run started while the download is still going waits for it instead of racing it.
 */
import { cloakConfigFromEnv } from "./cloak-config";

/** Memoized warm-up. Started at boot, awaited by anything that needs the binary. */
let warmUp: Promise<void> | null = null;

export interface CloakBinaryStatus {
  installed: boolean;
  version: string;
  tier: string;
  binaryPath: string;
}

/** What is on disk right now, without downloading anything. */
export async function cloakBinaryStatus(): Promise<CloakBinaryStatus | null> {
  const cfg = cloakConfigFromEnv();
  try {
    const { binaryInfo } = (await import("cloakbrowser")) as any;
    const info = binaryInfo(cfg.browserVersion, cfg.releaseChannel);
    return {
      installed: Boolean(info.installed),
      version: String(info.version),
      tier: String(info.tier),
      binaryPath: String(info.binaryPath),
    };
  } catch {
    return null;
  }
}

/**
 * Download the stealth Chromium if it is missing. Idempotent and memoized: every
 * caller after the first awaits the same promise, so the download happens once.
 *
 * Never throws. A warm-up failure is not a reason to refuse to serve or to refuse
 * a run — the capture itself will report the real error, with its own context.
 */
export function ensureCloakBinary(): Promise<void> {
  if (warmUp) return warmUp;
  warmUp = (async () => {
    const cfg = cloakConfigFromEnv();
    try {
      const status = await cloakBinaryStatus();
      if (status?.installed) {
        console.log(
          `  CloakBrowser ${status.version} (${status.tier}) déjà installé — pas de téléchargement.`,
        );
        return;
      }
      console.log(
        `  CloakBrowser absent du cache — téléchargement (~515 Mo) avant toute capture…`,
      );
      const { ensureBinary } = (await import("cloakbrowser")) as any;
      await ensureBinary(cfg.licenseKey, cfg.browserVersion, cfg.releaseChannel);
      const after = await cloakBinaryStatus();
      console.log(`  CloakBrowser prêt : ${after?.version ?? "?"} (${after?.tier ?? "?"})`);
    } catch (err) {
      console.warn(
        `  ⚠ Préparation de CloakBrowser impossible : ${(err as Error).message}\n` +
          `    Les captures "cloak" tenteront de le télécharger elles-mêmes.`,
      );
    }
  })();
  return warmUp;
}

/** Kick the warm-up off without blocking the caller (server boot). */
export function startCloakWarmUp(): void {
  void ensureCloakBinary();
}

/** Test seam: forget the memoized warm-up. */
export function resetCloakWarmUp(): void {
  warmUp = null;
}
