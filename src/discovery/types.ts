/**
 * Page discovery — shared types. Spec: ../../../docs/DIAGNOSTIC.md,
 * « Découverte des PDP / PLP ».
 */

/** A document as a fetcher received it. `url` is where it finally landed. */
export interface FetchedDoc {
  url: string;
  status: number;
  html: string;
}

export type FetchResult = FetchedDoc | { error: string };

/**
 * How a page is fetched. "http" is a plain request; "browser" is a stealth
 * browser whose `html` is the RENDERED DOM (links built by JavaScript included)
 * and which gets past the interstitials a plain request cannot.
 */
export interface Fetcher {
  kind: "http" | "browser";
  get(url: string): Promise<FetchResult>;
}

export type DiscoveryKind = "PDP" | "PLP";

/**
 * - confirmed: the page was opened and says what it is (product signals for a
 *   PDP, several product links for a PLP);
 * - probable: chosen on its URL shape or its source, but never confirmed — the
 *   operator must look before validating.
 */
export type Confidence = "confirmed" | "probable";

export interface Proposal {
  found: true;
  url: string;
  confidence: Confidence;
  /** Where the URL came from, in French, for the operator (« sitemap produits », « lien de la PLP »…). */
  source: string;
  /** What was checked and what it showed. */
  note: string;
  /** Other plausible URLs, best first, for the operator to pick from. */
  alternatives: string[];
  /** The fetcher that produced the proposal — "browser" when HTTP was not enough. */
  via: Fetcher["kind"];
}

export interface NotFound {
  found: false;
  /** Why nothing is proposed — a WAF block, a JS-built navigation… */
  note: string;
  /** Leads the operator may still pick: pages opened that did not prove themselves. */
  alternatives: string[];
  via: Fetcher["kind"];
}

export type DiscoveryOutcome = Proposal | NotFound;

export interface SiteDiscovery {
  startUrl: string;
  pdp?: DiscoveryOutcome;
  plp?: DiscoveryOutcome;
}
