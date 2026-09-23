/**
 * Verdict engine tests — pure, built from hand-made `DiagCheck[]` and
 * `makeEvidence`. Never relies on the real (still placeholder) bodies of
 * src/prospect/checks.ts.
 */
import { describe, expect, it } from "vitest";
import { makeEvidence } from "../src/core/fixture";
import type { DiagCheck, PageDiagnostic } from "../src/prospect/types";
import {
  applyManualDiagCheck,
  countPendingDiagConfirmations,
  decide,
  diagnosePage,
  rescorePageDiagnostic,
  siteDiagnostic,
} from "../src/prospect/verdict";

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function userCheck(overrides: Partial<DiagCheck> = {}): DiagCheck {
  return {
    id: "ssr.user",
    label: "SSR — utilisateur",
    passed: true,
    evidence: "texte recouvert à 90%",
    ...overrides,
  };
}

function botCheck(overrides: Partial<DiagCheck> = {}): DiagCheck {
  return {
    id: "ssr.bot",
    label: "SSR — crawler",
    passed: true,
    evidence: "texte recouvert à 90%",
    ...overrides,
  };
}

/* ── decision table (docs/DIAGNOSTIC.md) ─────────────────────────────────── */

describe("decide", () => {
  it("row 1 — user pass, bot pass => speed GO, seo GO", () => {
    const result = decide([userCheck({ passed: true }), botCheck({ passed: true })]);
    expect(result).toEqual({ speed: "GO", seo: "GO" });
  });

  it("row 2 — user fail, bot pass => speed NOGO, seo GO (dynamic rendering)", () => {
    const result = decide([userCheck({ passed: false }), botCheck({ passed: true })]);
    expect(result).toEqual({ speed: "NOGO", seo: "GO" });
  });

  it("row 3 — user pass, bot fail-but-unknown => speed GO, seo UNKNOWN", () => {
    const result = decide([
      userCheck({ passed: true }),
      botCheck({ passed: false, unknown: true }),
    ]);
    expect(result).toEqual({ speed: "GO", seo: "UNKNOWN" });
  });

  it("row 4 — user fail, bot fail => speed NOGO, seo NOGO", () => {
    const result = decide([userCheck({ passed: false }), botCheck({ passed: false })]);
    expect(result).toEqual({ speed: "NOGO", seo: "NOGO" });
  });

  it("an unarbitrated unknown never reads as a NOGO", () => {
    const result = decide([
      userCheck({ passed: false, unknown: true }),
      botCheck({ passed: false, unknown: true }),
    ]);
    expect(result.speed).toBe("UNKNOWN");
    expect(result.seo).toBe("UNKNOWN");
  });

  it("a manual override wins over unknown and counts as a normal verdict", () => {
    const result = decide([
      userCheck({ passed: false }),
      // Operator arbitrated a check the engine could not measure: manual + a
      // still-true unknown flag (mirrors the maturity route, which never clears
      // `unknown` on a manual correction) must still read as an ordinary GO.
      botCheck({ passed: true, unknown: true, manual: true }),
    ]);
    expect(result.seo).toBe("GO");
  });

  it("a manual fail overrides an unknown into a normal NOGO", () => {
    const result = decide([
      userCheck({ passed: true }),
      botCheck({ passed: false, unknown: true, manual: true }),
    ]);
    expect(result.seo).toBe("NOGO");
  });

  it("a missing check is treated as a measured failure, never a silent GO", () => {
    const result = decide([userCheck({ passed: true })]);
    expect(result.seo).toBe("NOGO");
  });
});

/* ── diagnosePage: informational data never moves the verdict ───────────── */

describe("diagnosePage", () => {
  it("assembles checks, verdict, and informational data straight from the bundle", () => {
    const bundle = makeEvidence({
      url: "https://example.com/pdp",
      stack: { frameworks: ["next"], signals: ["__NEXT_DATA__ present"] },
      navigation: { kind: "mpa", documentRequested: true },
    });
    const page = diagnosePage(bundle, "PDP");

    expect(page.url).toBe("https://example.com/pdp");
    expect(page.label).toBe("PDP");
    expect(page.checks).toHaveLength(2);
    expect(page.checks.map((c) => c.id).sort()).toEqual(["ssr.bot", "ssr.user"]);
    expect(page.stack).toEqual({ frameworks: ["next"], signals: ["__NEXT_DATA__ present"] });
    expect(page.navigation).toEqual({ kind: "mpa", documentRequested: true });
    expect(page.flags).toEqual([]);
    expect(page.dynamicRendering).toBe(false);
  });

  it("stack/navigation/flags never influence speed or seo", () => {
    // Two bundles that would drive checks.ts identically (both placeholders
    // return the same failing verdict regardless of input) but carry very
    // different informational payloads — the verdict must be identical.
    const plain = makeEvidence({ url: "https://example.com/a" });
    const rich = makeEvidence({
      url: "https://example.com/b",
      stack: { frameworks: ["react", "next"], signals: ["a", "b"], serviceWorker: true },
      navigation: { kind: "spa", contextSurvived: true },
    });

    const a = diagnosePage(plain);
    const b = diagnosePage(rich);

    expect(a.speed).toBe(b.speed);
    expect(a.seo).toBe(b.seo);
  });

  it("omits label when none is given", () => {
    const page = diagnosePage(makeEvidence());
    expect(page.label).toBeUndefined();
  });
});

/* ── siteDiagnostic: divergence, never an aggregate verdict ──────────────── */

describe("siteDiagnostic", () => {
  function page(speed: PageDiagnostic["speed"], seo: PageDiagnostic["seo"]): PageDiagnostic {
    return {
      url: "https://example.com/" + speed + seo,
      checks: [],
      speed,
      seo,
      dynamicRendering: false,
      flags: [],
    };
  }

  it("is not divergent when every page agrees", () => {
    const site = siteDiagnostic("example.com", [page("GO", "GO"), page("GO", "GO")]);
    expect(site.divergent).toBe(false);
    expect(site).not.toHaveProperty("verdict");
  });

  it("is divergent when speed disagrees across pages", () => {
    const site = siteDiagnostic("example.com", [page("GO", "GO"), page("NOGO", "GO")]);
    expect(site.divergent).toBe(true);
  });

  it("is divergent when seo disagrees across pages", () => {
    const site = siteDiagnostic("example.com", [page("GO", "GO"), page("GO", "UNKNOWN")]);
    expect(site.divergent).toBe(true);
  });

  it("a single page is never divergent", () => {
    const site = siteDiagnostic("example.com", [page("NOGO", "NOGO")]);
    expect(site.divergent).toBe(false);
  });
});

/* ── manual correction + cheap re-derivation ─────────────────────────────── */

describe("applyManualDiagCheck + rescorePageDiagnostic", () => {
  function pageWith(checks: DiagCheck[]): PageDiagnostic {
    const { speed, seo } = decide(checks);
    return { url: "https://example.com/", checks, speed, seo, dynamicRendering: false, flags: [] };
  }

  it("flips an unarbitrated unknown to a manual pass, and the verdict follows without recapture", () => {
    const original = pageWith([
      userCheck({ passed: true }),
      botCheck({ passed: false, unknown: true }),
    ]);
    expect(original.seo).toBe("UNKNOWN");

    const corrected = applyManualDiagCheck(original.checks, "ssr.bot", "pass");
    const rescored = rescorePageDiagnostic({ ...original, checks: corrected });

    expect(rescored.seo).toBe("GO");
    expect(rescored.speed).toBe("GO"); // untouched sibling check
    const bot = corrected.find((c) => c.id === "ssr.bot")!;
    expect(bot.manual).toBe(true);
    expect(bot.passed).toBe(true);
    expect(bot.unknown).toBe(true); // preserved, so a restore goes back to "à confirmer"
    expect(bot.auto).toEqual({ passed: false, evidence: botCheck().evidence, unknown: true });
  });

  it("stashes the measured verdict only on the FIRST correction", () => {
    const original = pageWith([userCheck(), botCheck({ passed: false })]);
    const once = applyManualDiagCheck(original.checks, "ssr.bot", "pass");
    const twice = applyManualDiagCheck(once, "ssr.bot", "fail");

    const bot = twice.find((c) => c.id === "ssr.bot")!;
    expect(bot.passed).toBe(false);
    // The ORIGINAL measured verdict, not the intermediate "pass" correction.
    expect(bot.auto).toEqual({ passed: false, evidence: botCheck().evidence });
  });

  it('"auto" restores the measured verdict and drops manual/auto', () => {
    const original = pageWith([userCheck(), botCheck({ passed: false, unknown: true })]);
    const corrected = applyManualDiagCheck(original.checks, "ssr.bot", "pass");
    const restored = applyManualDiagCheck(corrected, "ssr.bot", "auto");

    const bot = restored.find((c) => c.id === "ssr.bot")!;
    expect(bot.manual).toBeUndefined();
    expect(bot.auto).toBeUndefined();
    expect(bot.passed).toBe(false);
    expect(bot.unknown).toBe(true);

    const rescored = rescorePageDiagnostic({ ...original, checks: restored });
    expect(rescored.seo).toBe("UNKNOWN");
  });

  it('"auto" is a no-op when nothing was stashed', () => {
    const original = pageWith([userCheck(), botCheck()]);
    const untouched = applyManualDiagCheck(original.checks, "ssr.bot", "auto");
    expect(untouched).toEqual(original.checks);
  });

  it("does not mutate the input array", () => {
    const checks = [userCheck(), botCheck({ passed: false })];
    const snapshot = JSON.parse(JSON.stringify(checks));
    applyManualDiagCheck(checks, "ssr.bot", "pass");
    expect(checks).toEqual(snapshot);
  });
});

/* ── "à confirmer" bookkeeping ────────────────────────────────────────────── */

describe("countPendingDiagConfirmations", () => {
  function pageWith(checks: DiagCheck[]): PageDiagnostic {
    const { speed, seo } = decide(checks);
    return { url: "https://example.com/", checks, speed, seo, dynamicRendering: false, flags: [] };
  }

  it("counts unknown checks not yet arbitrated, across pages", () => {
    const pages = [
      pageWith([userCheck(), botCheck({ passed: false, unknown: true })]),
      pageWith([userCheck({ passed: false, unknown: true }), botCheck()]),
      pageWith([userCheck(), botCheck()]),
    ];
    expect(countPendingDiagConfirmations(pages)).toBe(2);
  });

  it("excludes an unknown check once it has been manually arbitrated", () => {
    const pages = [
      pageWith([userCheck(), botCheck({ passed: false, unknown: true, manual: true })]),
    ];
    expect(countPendingDiagConfirmations(pages)).toBe(0);
  });

  it("is zero when nothing is pending", () => {
    expect(countPendingDiagConfirmations([pageWith([userCheck(), botCheck()])])).toBe(0);
  });
});
