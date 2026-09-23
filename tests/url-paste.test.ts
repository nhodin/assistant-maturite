/**
 * Pure parsing/grouping of a pasted URL list (prospect diagnostic project
 * creation). See ../src/web/url-paste.ts and ../../docs/DIAGNOSTIC.md.
 */
import { describe, it, expect } from "vitest";
import { parseUrlPaste } from "../src/web/url-paste";

// 18 distinct registrable domains, one representative URL each (some carrying
// a query string, one a subdomain, one a multi-part PSL suffix).
const EIGHTEEN_DOMAINS_LIST = `
https://www.maxizoo.fr/
https://www.kiabi.com/vetements-homme
https://www.maisonsduvoyage.com/circuits
https://www.fabriquedestyles.com/
https://www.qoqa.ch/fr/deals
https://www.chantelle.com/fr-fr/
https://www.travisperkins.co.uk/products/cement
https://www.promod.fr/
https://www.backmarket.fr/fr-fr/
https://fr.shop-orchestra.com/product?dwvar_size=M
https://www.pfg.fr/
https://www.marcovasco.fr/circuit?l=11
https://shop.ledger.com/products/nano-x
https://www.devred.com/
https://www.byredo.com/
https://www.printemps.com/fr/fr
https://www.cafecoton.com/
https://www.emma.fr/matelas
`;

describe("parseUrlPaste", () => {
  it("groups the 18-URL reference list into 18 sites with no rejects", () => {
    const res = parseUrlPaste(EIGHTEEN_DOMAINS_LIST);
    expect(res.sites).toHaveLength(18);
    expect(res.rejected).toHaveLength(0);
    expect(res.counts).toEqual({ urls: 18, sites: 18, rejected: 0 });
  });

  it("ignores blank lines", () => {
    const res = parseUrlPaste("\n\nhttps://www.maxizoo.fr/\n\n\n");
    expect(res.sites).toEqual([{ site: "maxizoo.fr", pages: ["https://www.maxizoo.fr/"] }]);
  });

  it("merges exact duplicate lines", () => {
    const res = parseUrlPaste(
      "https://www.maxizoo.fr/\nhttps://www.maxizoo.fr/\nhttps://www.maxizoo.fr/",
    );
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0]!.pages).toEqual(["https://www.maxizoo.fr/"]);
    expect(res.counts.urls).toBe(1);
  });

  it("keeps distinct URLs on the same domain separate (not deduped)", () => {
    const res = parseUrlPaste(
      "https://www.maxizoo.fr/chats\nhttps://www.maxizoo.fr/chiens",
    );
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0]!.pages).toEqual([
      "https://www.maxizoo.fr/chats",
      "https://www.maxizoo.fr/chiens",
    ]);
  });

  it("rejects non-http(s) and malformed lines, and returns them (not silently dropped)", () => {
    const res = parseUrlPaste(
      "https://www.maxizoo.fr/\nnot-a-url\nftp://files.example.com/a.zip",
    );
    expect(res.sites).toHaveLength(1);
    expect(res.rejected).toHaveLength(2);
    expect(res.rejected.map((r) => r.line)).toEqual([
      "not-a-url",
      "ftp://files.example.com/a.zip",
    ]);
    expect(res.rejected[0]!.reason).toMatch(/invalide|http/i);
    expect(res.counts.rejected).toBe(2);
  });

  it("keeps query strings verbatim", () => {
    const res = parseUrlPaste("https://www.marcovasco.fr/circuit?l=11");
    expect(res.sites[0]!.pages).toEqual(["https://www.marcovasco.fr/circuit?l=11"]);
  });

  it("groups a multi-part PSL suffix (co.uk) as one whole registrable domain", () => {
    const res = parseUrlPaste(
      "https://www.travisperkins.co.uk/a\nhttps://www.travisperkins.co.uk/b",
    );
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0]!.site).toBe("travisperkins.co.uk");
  });

  it("groups a subdomain under its registrable domain (fr.shop-orchestra.com → shop-orchestra.com)", () => {
    const res = parseUrlPaste(
      "https://fr.shop-orchestra.com/product?dwvar_size=M\nhttps://www.shop-orchestra.com/other",
    );
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0]!.site).toBe("shop-orchestra.com");
    expect(res.sites[0]!.pages).toEqual([
      "https://fr.shop-orchestra.com/product?dwvar_size=M",
      "https://www.shop-orchestra.com/other",
    ]);
  });

  it("does not add home pages by default", () => {
    const res = parseUrlPaste("https://fr.shop-orchestra.com/product");
    expect(res.sites[0]!.pages).toEqual(["https://fr.shop-orchestra.com/product"]);
  });

  it("adds one home page per distinct host when includeHomepages is on", () => {
    const res = parseUrlPaste(
      "https://fr.shop-orchestra.com/product\nhttps://www.shop-orchestra.com/other",
      { includeHomepages: true },
    );
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0]!.pages).toEqual([
      "https://fr.shop-orchestra.com/product",
      "https://www.shop-orchestra.com/other",
      "https://fr.shop-orchestra.com/",
      "https://www.shop-orchestra.com/",
    ]);
    expect(res.counts.urls).toBe(4);
  });

  it("does not duplicate a home page already present in the pasted list", () => {
    const res = parseUrlPaste("https://www.maxizoo.fr/", { includeHomepages: true });
    expect(res.sites[0]!.pages).toEqual(["https://www.maxizoo.fr/"]);
  });

  it("is a pure function — parsing the same list twice is idempotent", () => {
    const a = parseUrlPaste(EIGHTEEN_DOMAINS_LIST);
    const b = parseUrlPaste(EIGHTEEN_DOMAINS_LIST);
    expect(b).toEqual(a);
  });
});
