/**
 * Stack probe — JS framework fingerprinting for the prospect diagnostic (see
 * ../../docs/DIAGNOSTIC.md, "Informations relevées, hors verdict"). Purely
 * informational: it never feeds the GO/NOGO verdict, only the report.
 *
 * `detectStack` is a PURE function of already-collected facts (rendered HTML,
 * request URLs, `window` global names read in-page, service-worker fact) so it
 * is unit-testable without a browser. The thin browser-dependent part — reading
 * `window` globals and `navigator.serviceWorker.getRegistrations()` — lives in
 * the collector (src/collector/index.ts), which calls this function with what
 * it read.
 */
import type { StackProbe } from "../core";

interface FrameworkFingerprint {
  id: string;
  label: string;
  /** Patterns tested against the rendered HTML (post-JS DOM serialization). */
  htmlPatterns?: RegExp[];
  /** Match htmlPatterns on markup only, with <style>/<script> bodies removed. */
  markupOnly?: boolean;
  /** Patterns tested against every observed request URL. */
  urlPatterns?: RegExp[];
  /** Exact `window` global names that identify this framework. */
  windowGlobalNames?: string[];
  /**
   * Prefixes matched against the `window`/root-element property names the
   * collector read in-page — for markers that aren't real `window` globals
   * (e.g. React's `__reactContainer$<hash>`, which lives on the root DOM node)
   * but are surfaced to us the same way (as a name in the `windowGlobals` set).
   */
  windowGlobalPrefixes?: string[];
}

/**
 * Order matters: this is the "most specific first" priority used to sort the
 * output. A meta-framework (Next, Nuxt, SvelteKit, Remix, Gatsby, Qwik, Astro)
 * implies its underlying library (React/Vue) but is the more useful fact, so it
 * must be reported first — e.g. a Next.js app matches both "next" and "react",
 * and the report should read ["next", "react"], never the reverse.
 */
const FRAMEWORK_FINGERPRINTS: FrameworkFingerprint[] = [
  {
    id: "next",
    label: "Next.js",
    htmlPatterns: [/__NEXT_DATA__/, /\/_next\//],
    urlPatterns: [/\/_next\//],
  },
  {
    id: "nuxt",
    label: "Nuxt",
    htmlPatterns: [/__NUXT__/],
  },
  {
    id: "sveltekit",
    label: "SvelteKit",
    htmlPatterns: [/__sveltekit/i],
  },
  {
    id: "remix",
    label: "Remix",
    htmlPatterns: [/__remixContext/],
  },
  {
    id: "gatsby",
    label: "Gatsby",
    htmlPatterns: [/___gatsby/],
  },
  {
    id: "qwik",
    label: "Qwik",
    htmlPatterns: [/\bq:container\b/],
  },
  {
    id: "astro",
    label: "Astro",
    htmlPatterns: [/astro-island/],
  },
  {
    id: "angular",
    label: "Angular",
    htmlPatterns: [/\bng-version\b/, /\b_nghost\b/],
  },
  {
    id: "react",
    label: "React",
    htmlPatterns: [/data-reactroot/],
    windowGlobalNames: ["__REACT_DEVTOOLS_GLOBAL_HOOK__"],
    windowGlobalPrefixes: ["__reactContainer$"],
  },
  {
    id: "vue",
    label: "Vue",
    // Scoped-style attribute. Matched on MARKUP ONLY (see `markupOnly` below):
    // a third-party Vue widget injects its scoped CSS as <style> blocks full of
    // `[data-v-…]` selectors, which is how chantelle.com — a Next site — was
    // fingerprinted "next + vue" off 310 occurrences that all belonged to Yotpo's
    // reviews widget. The page's OWN Vue puts the attribute on its elements.
    htmlPatterns: [/\bdata-v-[0-9a-f]{6,}\b/i],
    markupOnly: true,
    windowGlobalNames: ["__vue_app__"],
  },
];

/**
 * Drop `<style>` and `<script>` BODIES, keeping the markup around them.
 *
 * A fingerprint that is an ELEMENT ATTRIBUTE (`data-v-…`, `data-reactroot`,
 * `ng-version`) means the framework rendered this page's DOM. The same string
 * inside a stylesheet is a CSS selector — it says some component somewhere uses
 * that convention, which a third-party widget satisfies just as well as the site.
 */
function markupWithoutEmbeddedCode(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style></style>")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script></script>");
}

/**
 * Fingerprint the JS stack from already-collected facts. Pure — no I/O, no
 * browser. `windowGlobals` is whatever names the collector found present on
 * `window` (or, for React, on the likely root DOM node) during capture; an
 * empty/omitted set still lets HTML- and URL-based signatures match.
 */
export function detectStack(
  renderedHtml: string,
  requestUrls: string[],
  windowGlobals: Iterable<string> = [],
  serviceWorker?: boolean,
): StackProbe {
  const globals = new Set(windowGlobals);
  const html = renderedHtml || "";
  // Computed once: several fingerprints are attribute-based (see markupOnly).
  const markup = markupWithoutEmbeddedCode(html);
  const frameworks: string[] = [];
  const signals: string[] = [];

  for (const fp of FRAMEWORK_FINGERPRINTS) {
    const evidence: string[] = [];

    for (const re of fp.htmlPatterns ?? []) {
      const haystack = fp.markupOnly ? markup : html;
      if (re.test(haystack)) {
        evidence.push(`motif ${re.source} trouvé dans le HTML rendu${fp.markupOnly ? " (markup)" : ""}`);
      }
    }
    for (const re of fp.urlPatterns ?? []) {
      const hit = requestUrls.find((u) => re.test(u));
      if (hit) {
        evidence.push(`URL de requête correspondant à ${re.source} (${hit})`);
      }
    }
    for (const name of fp.windowGlobalNames ?? []) {
      if (globals.has(name)) {
        evidence.push(`global window.${name} présent`);
      }
    }
    for (const prefix of fp.windowGlobalPrefixes ?? []) {
      const hit = [...globals].find((g) => g.startsWith(prefix));
      if (hit) {
        evidence.push(`propriété ${hit} détectée`);
      }
    }

    if (evidence.length > 0) {
      frameworks.push(fp.id);
      signals.push(`${fp.label} : ${evidence.join(" ; ")}`);
    }
  }

  return {
    frameworks,
    signals,
    ...(serviceWorker !== undefined ? { serviceWorker } : {}),
  };
}
