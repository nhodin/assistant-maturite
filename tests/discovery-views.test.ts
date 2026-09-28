/**
 * The PDP/PLP proposal block and the URL paste preview of a diagnostic project.
 * See ../src/web/views/partials/page-candidates.ejs and docs/DIAGNOSTIC.md,
 * « Découverte des PDP / PLP ».
 */
import { describe, it, expect } from "vitest";
import ejs from "ejs";
import path from "node:path";
import { viewHelpers } from "../src/web/helpers";
import { parseUrlPaste } from "../src/web/url-paste";
import { pendingCandidates, pastedPageKind } from "../src/web/discovery-runner";
import { discoveryKindsOf } from "../src/web/routes/projects";

const ROOT = path.join(import.meta.dirname, "..", "src", "web", "views");
const render = (file: string, ctx: Record<string, unknown>) =>
  ejs.renderFile(path.join(ROOT, file), { ...viewHelpers, ...ctx }, { root: ROOT });

const cand = (over: Record<string, unknown>) => ({
  id: 1, siteId: 7, kind: "PDP", status: "PROPOSED", startUrl: "https://www.shop.fr/",
  url: "https://www.shop.fr/p/robe-12345", confidence: "confirmed", source: "lien de la PLP",
  via: "http", note: "page ouverte : JSON-LD Product", alternatives: ["https://www.shop.fr/p/jupe-23456"],
  site: { name: "shop.fr" }, ...over,
});

describe("page-candidates partial", () => {
  it("offers to validate a confirmed proposal, with its evidence and its alternatives", async () => {
    const html = await render("partials/page-candidates.ejs", { project: { id: 3 }, candidates: [cand({})] });
    expect(html).toContain("✓ confirmée");
    expect(html).toContain('action="/projects/3/candidates/1/accept"');
    expect(html).toContain('formaction="/projects/3/candidates/1/reject"');
    expect(html).toContain('value="https://www.shop.fr/p/robe-12345"');
    expect(html).toContain("lien de la PLP · page ouverte : JSON-LD Product");
    expect(html).toContain("https://www.shop.fr/p/jupe-23456");
    expect(html).toContain("✓ Valider les 1 confirmée");
    expect(html).not.toContain("hx-get"); // nothing is searching: no polling
  });

  it("polls while a search runs, and preserves what the operator typed", async () => {
    const html = await render("partials/page-candidates.ejs", {
      project: { id: 3 },
      candidates: [cand({ id: 2, status: "SEARCHING", url: null, confidence: null }), cand({ siteId: 8, site: { name: "b.fr" } })],
    });
    expect(html).toContain('hx-get="/projects/3/candidates"');
    expect(html).toContain('id="cand-url-1" hx-preserve="true"');
    expect(html).toContain("depuis https://www.shop.fr/");
  });

  it("asks for a URL when nothing was found, and says why and which way it went", async () => {
    const html = await render("partials/page-candidates.ejs", {
      project: { id: 3 },
      candidates: [cand({ status: "NOT_FOUND", url: null, confidence: null, source: null, via: "browser",
        note: "home illisible (interstitiel DataDome)", alternatives: [] })],
    });
    expect(html).toContain("introuvable");
    expect(html).toContain("Collez l'URL de la PDP");
    expect(html).toContain("home illisible (interstitiel DataDome)");
    expect(html).toContain("🌐 navigateur");
  });

  it("marks an unverified proposal as probable, never as confirmed", async () => {
    const html = await render("partials/page-candidates.ejs", {
      project: { id: 3 },
      candidates: [cand({ confidence: "probable" })],
    });
    expect(html).toContain("~ probable");
    expect(html).not.toContain("✓ confirmée");
    expect(html).not.toContain("Valider les");
  });
});

describe("url paste preview", () => {
  it("names where each site's search starts, and badges the homes", async () => {
    const result = parseUrlPaste("https://www.shop.fr/fr-fr/\nhttps://www.other.fr/matelas");
    const html = await render("partials/url-paste-preview.ejs", { result, discoveryKinds: ["PDP", "PLP"] });
    expect(html).toContain("PDP + PLP à rechercher depuis");
    expect(html).toContain("https://www.shop.fr/fr-fr/");
    expect(html).toContain("https://www.other.fr/"); // no home pasted: its root
    expect(html).toContain('<span class="badge">HP</span> https://www.shop.fr/fr-fr/');
  });

  it("says nothing about a search nobody asked for", async () => {
    const result = parseUrlPaste("https://www.shop.fr/");
    const html = await render("partials/url-paste-preview.ejs", { result, discoveryKinds: [] });
    expect(html).not.toContain("à rechercher depuis");
  });
});

describe("runner helpers", () => {
  it("counts what the operator still has to settle", () => {
    const n = pendingCandidates(
      ["SEARCHING", "PROPOSED", "NOT_FOUND", "ACCEPTED", "REJECTED"].map((status) => ({ status })),
    );
    expect(n).toBe(3);
  });

  it("stores a pasted home as HP and anything else as OTHER — never a guessed PDP", () => {
    expect(pastedPageKind("https://www.shop.fr/")).toBe("HP");
    expect(pastedPageKind("https://www.shop.fr/fr-fr/")).toBe("HP");
    expect(pastedPageKind("https://www.shop.fr/p/robe-12345")).toBe("OTHER");
  });

  it("reads the two checkboxes of the form", () => {
    expect(discoveryKindsOf({ discoverPdp: "on" })).toEqual(["PDP"]);
    expect(discoveryKindsOf({ discoverPdp: "on", discoverPlp: "on" })).toEqual(["PDP", "PLP"]);
    expect(discoveryKindsOf({})).toEqual([]);
    expect(discoveryKindsOf(undefined)).toEqual([]);
  });
});

describe("project detail, diagnostic project", () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    active: "projects", title: "Prospects",
    project: { id: 3, name: "Prospects", mode: "DIAGNOSTIC", client: null, description: null, pages: [], runs: [] },
    trend: null, diagSummaries: {}, latestDiagRun: null,
    cruxTrends: [], cruxLatest: [], cruxFormFactors: [], selectedFF: "PHONE",
    candidates: [cand({}), cand({ id: 2, kind: "PLP", status: "NOT_FOUND", url: null, confidence: null })],
    candidatesPending: 2, flash: null, ...over,
  });

  it("shows the proposals and warns before a run that would leave them out", async () => {
    const html = await render("project-detail.ejs", ctx());
    expect(html).toContain('id="candidates"');
    expect(html).toContain("Pages à valider");
    expect(html).toContain("2 propositions de page non traitées");
    expect(html).toContain("return confirm(");
    expect(html).toContain('action="/projects/3/discover"');
  });

  it("does not warn when every proposal is settled", async () => {
    const html = await render("project-detail.ejs", ctx({ candidatesPending: 0 }));
    expect(html).not.toContain("non traitée");
    expect(html).not.toContain("return confirm(");
  });

  it("reports how many sites a search was launched on", async () => {
    const html = await render("project-detail.ejs", ctx({ flash: "discovery_started_4" }));
    expect(html).toContain("Recherche lancée sur 4 sites");
  });
});
