/**
 * Navigation probe — decides MPA vs SPA for the prospect diagnostic (see
 * ../../docs/DIAGNOSTIC.md, "Informations relevées, hors verdict"). Purely
 * informational: it never feeds the GO/NOGO verdict, only the report.
 *
 * Method: set a marker on `window`, click a same-registrable-domain internal
 * link that actually navigates, wait for the URL to settle, then check whether
 * the marker survived (client-side routing) and whether a new main-frame
 * `document` request was observed (a full reload). This module is split in two:
 *  - `pickInternalLink` / `decideNavigation` are PURE and unit-testable without
 *    a browser (link-selection rules, and the spa/mpa/unknown decision table).
 *  - `probeNavigation` is the thin browser-dependent wiring (Playwright), kept
 *    as small as possible around the pure decision.
 *
 * MUST run LAST in the collector's capture sequence: it clicks a link and can
 * navigate the page away, so anything captured after it would be unreliable.
 */
import type { Page, Request } from "playwright";
import type { NavigationProbe } from "../core";
import { host, registrableDomain } from "../topics/util";

export interface CandidateLink {
  href: string;
  targetBlank?: boolean;
}

const SKIP_HREF_RE = /^\s*(#|javascript:|mailto:|tel:)/i;

/**
 * Pick the first same-registrable-domain internal link that would actually
 * navigate: skips `#`/`javascript:`/`mailto:`/`tel:` hrefs, `target=_blank`
 * links, and links whose resolved URL is the current page (hash-only or exact
 * duplicate — clicking either would not exercise navigation at all). Returns
 * the resolved absolute URL, or null when nothing qualifies.
 */
export function pickInternalLink(links: CandidateLink[], pageUrl: string): string | null {
  const pageHost = host(pageUrl);
  if (!pageHost) return null;
  const pageDomain = registrableDomain(pageHost);
  const pageUrlNoHash = pageUrl.split("#")[0];

  for (const link of links) {
    const href = (link.href ?? "").trim();
    if (!href) continue;
    if (SKIP_HREF_RE.test(href)) continue;
    if (link.targetBlank) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

    const resolvedStr = resolved.toString();
    if (resolvedStr.split("#")[0] === pageUrlNoHash) continue; // same page, hash-only or exact

    const linkHost = resolved.hostname.toLowerCase();
    if (!linkHost || registrableDomain(linkHost) !== pageDomain) continue;

    return resolvedStr;
  }
  return null;
}

/**
 * Same rules as `pickInternalLink`, but returns up to `max` candidates instead of
 * the first one. The probe needs several: the first internal link in DOM order is
 * almost always the header logo, which on a mobile viewport sits under a sticky
 * header, a consent banner or a promo overlay — Playwright then refuses the click
 * ("element is covered by <DIV>") and the probe learns nothing about the site.
 */
export function pickInternalLinks(
  links: CandidateLink[],
  pageUrl: string,
  max = 8,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let rest = links;
  while (out.length < max) {
    const next = pickInternalLink(rest, pageUrl);
    if (!next) break;
    const idx = rest.findIndex((l) => {
      try {
        return new URL((l.href ?? "").trim(), pageUrl).toString() === next;
      } catch {
        return false;
      }
    });
    rest = rest.slice(idx + 1);
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

export interface NavigationDecisionInput {
  /** The link the probe picked, or null when none qualified. */
  linkUrl: string | null;
  /** Whether the click itself succeeded (element found and clickable). */
  clicked: boolean;
  landedUrl?: string;
  /** The `window` marker survived the click. */
  contextSurvived?: boolean;
  /** A new main-frame `document` request was observed after the click. */
  documentRequested?: boolean;
  /** The probe gave up waiting for the navigation to settle. */
  timedOut?: boolean;
}

/**
 * The spa/mpa/unknown decision table from docs/DIAGNOSTIC.md: marker survival
 * beats everything (client-side routing is conclusive on its own — SSR and SPA
 * are not mutually exclusive, Next/Nuxt/SvelteKit/Remix commonly do both);
 * marker gone + a new document request is a full reload (mpa); anything else
 * (no eligible link, click failed, timeout, neither signal fired) is `unknown`
 * with a French `note` naming why.
 */
export function decideNavigation(input: NavigationDecisionInput): NavigationProbe {
  if (!input.linkUrl) {
    return { kind: "unknown", note: "aucun lien interne éligible trouvé sur la page" };
  }
  if (!input.clicked) {
    return {
      kind: "unknown",
      linkUrl: input.linkUrl,
      note: "le clic sur le lien interne a échoué",
    };
  }

  const base: NavigationProbe = {
    kind: "unknown",
    linkUrl: input.linkUrl,
    ...(input.landedUrl !== undefined ? { landedUrl: input.landedUrl } : {}),
    ...(input.contextSurvived !== undefined ? { contextSurvived: input.contextSurvived } : {}),
    ...(input.documentRequested !== undefined ? { documentRequested: input.documentRequested } : {}),
  };

  if (input.contextSurvived) {
    return { ...base, kind: "spa" };
  }
  if (input.documentRequested) {
    return { ...base, kind: "mpa" };
  }
  if (input.timedOut) {
    return {
      ...base,
      note: "délai dépassé en attendant que la navigation se stabilise",
    };
  }
  return {
    ...base,
    note: "ni routing client-side ni nouvelle requête document constatés après le clic",
  };
}

const MARKER_ATTR_PREFIX = "data-diag-nav-target";

/**
 * Browser-dependent wiring around the pure decision above. Reads the page's
 * anchors, picks one with `pickInternalLink`, sets a `window` marker, clicks
 * the anchor (a real click — a synthetic `page.goto` would not exercise the
 * site's own click handlers, which is exactly what client-side routing needs
 * to kick in), waits for the URL to settle, then reports what survived.
 *
 * Never throws: every step degrades to the `unknown` outcome on failure.
 */
export async function probeNavigation(
  page: Page,
  pageUrl: string,
  opts: { timeoutMs?: number; maxCandidates?: number } = {},
): Promise<NavigationProbe> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxCandidates = opts.maxCandidates ?? 6;

  let links: CandidateLink[] = [];
  try {
    links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => ({
        href: a.getAttribute("href") ?? "",
        targetBlank: (a.getAttribute("target") ?? "").toLowerCase() === "_blank",
      })),
    );
  } catch {
    links = [];
  }

  const candidates = pickInternalLinks(links, pageUrl, maxCandidates);
  if (candidates.length === 0) {
    return decideNavigation({ linkUrl: null, clicked: false });
  }

  let documentRequested = false;
  const onRequest = (req: Request): void => {
    try {
      if (req.resourceType() === "document" && req.frame() === page.mainFrame()) {
        documentRequested = true;
      }
    } catch {
      // ignore
    }
  };
  page.on("request", onRequest);

  let lastFailure = "";
  try {
    for (const linkUrl of candidates) {
      const marker = `probe-${Math.random().toString(36).slice(2)}`;
      const markerAttr = `${MARKER_ATTR_PREFIX}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        await page.evaluate(
          ({ m }) => {
            (window as unknown as Record<string, unknown>).__diagProbe = m;
          },
          { m: marker },
        );
      } catch {
        lastFailure = "le marqueur n'a pas pu être posé sur la page";
        continue;
      }

      // Tag the DOM anchor whose resolved href matches the candidate, so the click
      // targets a real element rather than a synthesized navigation.
      let tagged = false;
      try {
        tagged = await page.evaluate(
          ({ target, attr }) => {
            for (const a of Array.from(document.querySelectorAll("a[href]"))) {
              try {
                if (new URL(a.getAttribute("href") || "", location.href).toString() === target) {
                  a.setAttribute(attr, "1");
                  return true;
                }
              } catch {
                // skip unparsable hrefs
              }
            }
            return false;
          },
          { target: linkUrl, attr: markerAttr },
        );
      } catch {
        tagged = false;
      }
      if (!tagged) {
        lastFailure = "le lien retenu n'existe plus dans le DOM au moment du clic";
        continue;
      }

      const before = safeUrl(page) ?? pageUrl;
      documentRequested = false;

      // A real user-like click first — it exercises the site's own handlers, which
      // is exactly what a client-side router needs to kick in.
      let clicked = false;
      let covered = false;
      try {
        await page.click(`[${markerAttr}]`, { timeout: 2500 });
        clicked = true;
      } catch (err) {
        // "element is covered by <DIV>" is the common case on a mobile viewport:
        // a sticky header, a consent layer or a promo overlay sits over the link.
        // The probe is not simulating a user — it asks whether following this link
        // reloads the document — so falling back to the element's own .click() is
        // legitimate: the site's handlers still run, only Playwright's
        // actionability gate is bypassed.
        covered = /covered by|intercepts pointer events|not receiving events|outside of the viewport|not visible|not stable/i.test(
          String(err),
        );
        if (covered) {
          try {
            await page.evaluate((attr) => {
              const el = document.querySelector(`[${attr}]`) as HTMLElement | null;
              el?.click();
            }, markerAttr);
            clicked = true;
          } catch {
            clicked = false;
          }
        }
      }

      if (!clicked) {
        lastFailure = covered
          ? "lien masqué par une surcouche, et le clic de repli a échoué"
          : "le clic sur le lien interne a échoué";
        continue;
      }

      let timedOut = false;
      try {
        await page.waitForLoadState("load", { timeout: timeoutMs });
      } catch {
        timedOut = true;
      }
      // Let a client-side router finish its own (JS-driven) settling too.
      await page.waitForTimeout(400).catch(() => {});

      let contextSurvived = false;
      try {
        contextSurvived = await page.evaluate(
          ({ m }) => (window as unknown as Record<string, unknown>).__diagProbe === m,
          { m: marker },
        );
      } catch {
        // A destroyed execution context is itself evidence of a full reload.
        contextSurvived = false;
      }

      const landedUrl = safeUrl(page);
      const moved = landedUrl !== undefined && landedUrl !== before;

      // Nothing happened at all: the click was swallowed (an overlay ate it, or the
      // anchor is decorative). Try the next candidate rather than reporting SPA —
      // "the marker survived" only means client-side routing if we actually moved.
      if (!moved && !documentRequested) {
        lastFailure = "le clic n'a produit aucune navigation";
        continue;
      }

      return decideNavigation({
        linkUrl,
        clicked,
        landedUrl,
        contextSurvived,
        documentRequested,
        timedOut,
      });
    }
  } finally {
    page.off("request", onRequest);
  }

  return {
    kind: "unknown",
    linkUrl: candidates[0],
    note: `${candidates.length} lien(s) interne(s) essayé(s) sans résultat — ${lastFailure}`,
  };
}

/** `page.url()` never throws in practice, but a closed page would. */
function safeUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}
