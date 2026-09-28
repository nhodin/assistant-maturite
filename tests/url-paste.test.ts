/**
 * Pure parsing/grouping of a pasted URL list (prospect diagnostic project
 * creation). See ../src/web/url-paste.ts and ../../docs/DIAGNOSTIC.md.
 */
import { describe, it, expect } from "vitest";
import { canonicalUrlKey, findCanonicalMatch, parseUrlPaste } from "../src/web/url-paste";

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
    expect(res.counts).toEqual({ urls: 18, sites: 18, rejected: 0, duplicates: 0 });
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

  it("merges the same page written another way, keeping the first spelling", () => {
    const res = parseUrlPaste(
      [
        "https://www.maxizoo.fr/chats/",
        "http://www.maxizoo.fr/chats",
        "https://WWW.Maxizoo.FR/chats",
        "https://www.maxizoo.fr/chats//",
      ].join("\n"),
    );
    expect(res.sites[0]!.pages).toEqual(["https://www.maxizoo.fr/chats/"]);
    expect(res.duplicates.map((d) => d.line)).toEqual([
      "http://www.maxizoo.fr/chats",
      "https://WWW.Maxizoo.FR/chats",
      "https://www.maxizoo.fr/chats//",
    ]);
    expect(res.duplicates.every((d) => d.duplicateOf === "https://www.maxizoo.fr/chats/")).toBe(true);
    expect(res.counts).toMatchObject({ urls: 1, duplicates: 3 });
  });

  it("does not report a strictly identical line as a duplicate — it is just merged", () => {
    const res = parseUrlPaste("https://www.maxizoo.fr/\nhttps://www.maxizoo.fr/");
    expect(res.counts).toMatchObject({ urls: 1, duplicates: 0 });
  });

  it("keeps query strings in the comparison: other parameters, other page", () => {
    const res = parseUrlPaste(
      [
        "https://www.marcovasco.fr/circuit?l=11",
        "https://www.marcovasco.fr/circuit?l=12",
        "https://www.marcovasco.fr/circuit/?l=11", // same page, trailing slash
        "https://www.marcovasco.fr/circuit",
      ].join("\n"),
    );
    expect(res.sites[0]!.pages).toEqual([
      "https://www.marcovasco.fr/circuit?l=11",
      "https://www.marcovasco.fr/circuit?l=12",
      "https://www.marcovasco.fr/circuit",
    ]);
    expect(res.duplicates).toEqual([
      { line: "https://www.marcovasco.fr/circuit/?l=11", duplicateOf: "https://www.marcovasco.fr/circuit?l=11" },
    ]);
  });

  it("keeps a rejected line apart from a valid URL of the same host", () => {
    // "www.maxizoo.fr" has no scheme: rejected, and not swallowed as a duplicate.
    const res = parseUrlPaste("https://www.maxizoo.fr/\nwww.maxizoo.fr\nwww.maxizoo.fr");
    expect(res.sites[0]!.pages).toEqual(["https://www.maxizoo.fr/"]);
    expect(res.rejected.map((r) => r.line)).toEqual(["www.maxizoo.fr"]);
    expect(res.duplicates).toEqual([]);
  });

  it("does not add a home the host already has, however it was written", () => {
    for (const home of [
      "http://www.maxizoo.fr",
      "https://www.maxizoo.fr",
      "http://WWW.MAXIZOO.FR/",
    ]) {
      const res = parseUrlPaste(`${home}\nhttps://www.maxizoo.fr/chats`, {
        includeHomepages: true,
      });
      expect(res.sites[0]!.pages).toEqual([home, "https://www.maxizoo.fr/chats"]);
    }
  });

  it("still adds the home when the host only has the root with parameters", () => {
    // `/?lang=en` is another URL under the canonical rule — not the home.
    const res = parseUrlPaste("https://www.maxizoo.fr/?lang=en", { includeHomepages: true });
    expect(res.sites[0]!.pages).toEqual(["https://www.maxizoo.fr/?lang=en", "https://www.maxizoo.fr/"]);
  });

  it("lets a pasted home win over the generated one, wherever it sits in the paste", () => {
    // Homes are generated after every pasted line has been read, so a home
    // pasted last still counts and is kept as typed.
    const res = parseUrlPaste("https://www.maxizoo.fr/chats\nhttp://www.maxizoo.fr", {
      includeHomepages: true,
    });
    expect(res.sites[0]!.pages).toEqual(["https://www.maxizoo.fr/chats", "http://www.maxizoo.fr"]);
    expect(res.duplicates).toEqual([]);
  });
});

describe("canonicalUrlKey", () => {
  it("ignores the scheme, the host case and the trailing slash", () => {
    const key = canonicalUrlKey("https://www.shop.fr/fr");
    expect(canonicalUrlKey("http://WWW.Shop.FR/fr/")).toBe(key);
    expect(canonicalUrlKey("  https://www.shop.fr/fr/  ")).toBe(key);
  });

  it("reads a bare host and its root as the same page", () => {
    expect(canonicalUrlKey("https://www.shop.fr")).toBe(canonicalUrlKey("http://www.shop.fr/"));
  });

  it("keeps the path case, the query string and the fragment", () => {
    expect(canonicalUrlKey("https://www.shop.fr/FR")).not.toBe(canonicalUrlKey("https://www.shop.fr/fr"));
    expect(canonicalUrlKey("https://www.shop.fr/p?id=1")).not.toBe(canonicalUrlKey("https://www.shop.fr/p?id=2"));
    expect(canonicalUrlKey("https://www.shop.fr/#/p/1")).not.toBe(canonicalUrlKey("https://www.shop.fr/#/p/2"));
  });

  it("keeps a non-default port", () => {
    expect(canonicalUrlKey("https://www.shop.fr:8443/")).not.toBe(canonicalUrlKey("https://www.shop.fr/"));
  });

  it("returns a non-URL string trimmed, as its own key", () => {
    expect(canonicalUrlKey("  not a url ")).toBe("not a url");
  });
});

describe("findCanonicalMatch (stored pages)", () => {
  const stored = [
    { id: 1, url: "https://www.shop.fr/" },
    { id: 2, url: "https://www.shop.fr/fr/produit?id=42" },
    { id: 3, url: "http://www.shop.fr/fr/produit/?id=42" }, // older twin already in DB
  ];

  it("reuses the stored page written another way", () => {
    expect(findCanonicalMatch(stored, "http://www.shop.fr")?.id).toBe(1);
    expect(findCanonicalMatch(stored, "https://WWW.SHOP.FR/fr/produit/?id=42")?.id).toBe(2);
  });

  it("resolves to the first candidate when several spellings are stored", () => {
    expect(findCanonicalMatch(stored, "https://www.shop.fr/fr/produit?id=42")?.id).toBe(2);
  });

  it("finds nothing for another page", () => {
    expect(findCanonicalMatch(stored, "https://www.shop.fr/fr/produit?id=43")).toBeUndefined();
    expect(findCanonicalMatch([], "https://www.shop.fr/")).toBeUndefined();
  });
});
