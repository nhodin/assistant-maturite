/**
 * Platform probe — web application (e-commerce platform / CMS) and CDN/WAF
 * fingerprinting for the prospect diagnostic (see ../../docs/DIAGNOSTIC.md,
 * "Informations relevées, hors verdict"). Purely informational: it never feeds
 * the GO/NOGO verdict, only the report.
 *
 * Signatures are a curated subset of the Wappalyzer community fingerprints
 * (github.com/enthec/webappanalyzer, GPL-3.0 — the patterns are re-expressed
 * here, not vendored) plus field observations. Curated rather than the full
 * engine on purpose: Wappalyzer reports every technology a page TOUCHES, so a
 * third-party widget built on Shopify or a CSP listing cdnjs.cloudflare.com
 * would read as the site's own stack. Here each signal is chosen to say what
 * SERVES the page:
 *   - headers are read on the main document only;
 *   - cookies are the page's first-party cookies only (the collector filters);
 *   - URL patterns flagged `firstParty` only match requests on the page's
 *     registrable domain (a `/wp-content/` path on a partner blog proves nothing).
 *
 * Pure function of already-collected facts — unit-testable without a browser.
 * The collector reads the cookies and the `window` globals in-page and calls it.
 */
import type { HeaderMap } from "../core";
import { registrableDomain } from "../topics/util";

type Role = "platform" | "edge";

interface Fingerprint {
  label: string;
  role: Role;
  /** Main-document response headers: name → value pattern (null = presence). */
  headers?: Record<string, RegExp | null>;
  /** First-party cookie NAMES. */
  cookies?: RegExp[];
  /** Rendered HTML, markup only (<script>/<style> bodies removed). */
  markup?: RegExp[];
  /** Any request URL. */
  urls?: RegExp[];
  /** Request URLs on the page's own registrable domain only. */
  firstPartyUrls?: RegExp[];
  /** Exact `window` global names (must be listed in PLATFORM_WINDOW_GLOBALS). */
  globals?: string[];
}

/**
 * Order = display order within a role: a specific product first (a headless
 * front, a WAF) before the generic one it sits on, so "Shopify Hydrogen" reads
 * before "Shopify" and "Akamai Bot Manager" next to "Akamai".
 */
const FINGERPRINTS: Fingerprint[] = [
  // ── Web application: e-commerce platforms ──────────────────────────────────
  {
    label: "Salesforce Commerce Cloud (PWA Kit)",
    role: "platform",
    firstPartyUrls: [/\/mobify\/(?:bundle|proxy|caching)\//],
  },
  {
    label: "Salesforce Commerce Cloud",
    role: "platform",
    headers: { server: /demandware/i },
    cookies: [/^dwsid$/, /^dwanonymous_/, /^dwac_/, /^dw_dnt$/, /^__cq_dnt$/],
    urls: [/\/on\/demandware\.(?:static|store)\//, /demandware\.edgesuite\.net/],
    globals: ["dwAnalytics"],
  },
  {
    label: "SAP Commerce Cloud (Spartacus)",
    role: "platform",
    markup: [/<cx-storefront\b/, /\bcx-page-layout\b/],
  },
  {
    label: "SAP Commerce Cloud (Hybris)",
    role: "platform",
    headers: { "x-sap-pad": null },
    cookies: [/^_hybris/, /^acceleratorSecureGUID$/],
    markup: [/\byCmsContentSlot\b/, /\byCmsComponent\b/, /\/_ui\/(?:responsive|desktop)\//],
    firstPartyUrls: [/\/_ui\/(?:responsive|desktop|addons)\//, /\/medias\/.*context=/],
    globals: ["ACC"],
  },
  {
    label: "Shopify Hydrogen",
    role: "platform",
    headers: { "powered-by": /hydrogen/i, "oxygen-full-page-cache": null },
  },
  {
    label: "Shopify",
    role: "platform",
    headers: { "x-shopid": null, "x-shopify-stage": null, "powered-by": /shopify/i },
    cookies: [/^_shopify_(?:y|s|essential)/, /^cart_currency$/, /^_tracking_consent$/],
    urls: [/\/\/cdn\.shopify\.com\//, /\.myshopify\.com\//, /sdks\.shopifycdn\.com/],
    globals: ["Shopify", "ShopifyAnalytics"],
  },
  {
    label: "Magento / Adobe Commerce",
    role: "platform",
    headers: { "x-magento-cache-debug": null, "x-magento-tags": null },
    cookies: [/^mage-cache-/, /^X-Magento-Vary$/, /^mage-translation-/],
    markup: [/type="text\/x-magento-init"/, /data-requiremodule="(?:mage\/|Magento_)/],
    firstPartyUrls: [/\/static\/(?:version\d+\/)?frontend\/[^/]+\/[^/]+\//],
    globals: ["Mage"],
  },
  {
    label: "VTEX",
    role: "platform",
    headers: { server: /^vtex/i, powered: /vtex/i },
    cookies: [/^vtex_session$/, /^VtexWorkspace$/, /^VtexFingerPrint$/],
    urls: [/\.vteximg\.com\.br\//, /\.vtexassets\.com\//],
  },
  {
    label: "BigCommerce",
    role: "platform",
    urls: [/cdn\d+\.bigcommerce\.com\//, /\.mybigcommerce\.com\//],
    globals: ["BCData"],
  },
  {
    label: "Oracle Commerce Cloud",
    role: "platform",
    headers: { "oraclecommercecloud-version": null },
    markup: [/id="oracle-cc"/],
  },
  {
    label: "PrestaShop",
    role: "platform",
    headers: { "powered-by": /prestashop/i },
    cookies: [/^PrestaShop-/],
    firstPartyUrls: [/\/modules\/ps_[a-z]+\//],
    globals: ["prestashop"],
  },
  {
    label: "WooCommerce",
    role: "platform",
    firstPartyUrls: [/\/wp-content\/plugins\/woocommerce\//],
    cookies: [/^woocommerce_/, /^wp_woocommerce_session_/],
  },
  // ── Web application: CMS / site builders ───────────────────────────────────
  {
    label: "Adobe Experience Manager",
    role: "platform",
    markup: [/\baem-Grid\b/, /data-component-path="[^"]*jcr:/],
    firstPartyUrls: [/\/etc\.clientlibs\//, /\/etc\/(?:designs|clientlibs)\//],
  },
  {
    label: "Sitecore",
    role: "platform",
    cookies: [/^SC_ANALYTICS_GLOBAL_COOKIE$/, /^sxa_site$/],
    firstPartyUrls: [/\/-\/media\//, /\/_sitecore\//],
  },
  {
    label: "Drupal",
    role: "platform",
    headers: { "x-drupal-cache": null, "x-drupal-dynamic-cache": null, "x-generator": /drupal/i },
    globals: ["Drupal"],
  },
  {
    label: "WordPress",
    role: "platform",
    firstPartyUrls: [/\/wp-(?:content|includes)\//],
    headers: { link: /api\.w\.org/ },
  },
  {
    label: "Wix",
    role: "platform",
    headers: { "x-wix-request-id": null },
    urls: [/static\.wixstatic\.com\//],
  },
  {
    label: "Webflow",
    role: "platform",
    markup: [/\bdata-wf-site="/],
  },

  // ── CDN / WAF ───────────────────────────────────────────────────────────────
  {
    label: "Fasterize",
    role: "edge",
    headers: { "x-fstrz": null },
    globals: ["fstrz"],
  },
  {
    label: "Akamai Bot Manager",
    role: "edge",
    cookies: [/^_abck$/, /^bm_sz$/, /^ak_bmsc$/, /^bm_sv$/],
  },
  {
    label: "Akamai",
    role: "edge",
    headers: {
      "akamai-grn": null,
      "akamai-cache-status": null,
      "x-akamai-transformed": null,
      "x-akamai-request-id": null,
      server: /akamai/i,
      "server-timing": /\bak_p\b/,
      "x-cache": /akamaitechnologies/i,
    },
  },
  {
    label: "Cloudflare",
    role: "edge",
    headers: { "cf-ray": null, "cf-cache-status": null, server: /^cloudflare$/i },
    cookies: [/^__cf_bm$/, /^cf_clearance$/, /^__cflb$/],
  },
  {
    label: "Imperva",
    role: "edge",
    headers: { "x-iinfo": null, "x-cdn": /incapsula|imperva/i },
    cookies: [/^incap_ses_/, /^visid_incap_/, /^nlbi_/, /^reese84$/],
    firstPartyUrls: [/\/_Incapsula_Resource/],
  },
  {
    label: "Fastly",
    role: "edge",
    headers: {
      "x-fastly-request-id": null,
      "fastly-debug-digest": null,
      // Fastly POP ids: "cache-par-lfpg1960045-PAR", "cache-cdg20727-CDG".
      "x-served-by": /\bcache-[a-z]{3}(?:-[a-z]+)?\d/i,
      server: /fastly/i,
    },
  },
  {
    label: "Amazon CloudFront",
    role: "edge",
    headers: { "x-amz-cf-id": null, "x-amz-cf-pop": null, via: /cloudfront/i },
  },
  {
    label: "AWS WAF",
    role: "edge",
    headers: { "x-amzn-waf-action": null },
    cookies: [/^aws-waf-token$/],
  },
  {
    label: "Azure Front Door",
    role: "edge",
    headers: { "x-azure-ref": null },
  },
  {
    label: "Google Cloud CDN / LB",
    role: "edge",
    headers: { via: /\bgoogle\b/i },
  },
  {
    label: "Vercel",
    role: "edge",
    headers: { "x-vercel-id": null, server: /^vercel$/i },
  },
  {
    label: "Netlify",
    role: "edge",
    headers: { "x-nf-request-id": null, server: /^netlify$/i },
  },
  {
    label: "Sucuri",
    role: "edge",
    headers: { "x-sucuri-id": null, server: /sucuri/i },
  },
  {
    label: "DataDome",
    role: "edge",
    headers: { "x-datadome": null, "x-datadome-cid": null, server: /^datadome$/i },
    cookies: [/^datadome$/],
    urls: [/\/\/(?:js|ct)\.datadome\.co\//],
  },
  {
    label: "HUMAN (PerimeterX)",
    role: "edge",
    cookies: [/^_px3$/, /^_pxhd$/, /^_pxvid$/],
    urls: [/client\.a\.pxi\.pub\//, /\.perimeterx\.net\//],
  },
  {
    label: "Kasada",
    role: "edge",
    headers: { "x-kpsdk-ct": null, "x-kpsdk-r": null },
    cookies: [/^KP_UIDz/],
  },
  {
    label: "Alibaba Cloud CDN",
    role: "edge",
    headers: { "ali-swift-global-savetime": null, eagleid: null },
  },
  {
    label: "Tencent Cloud CDN",
    role: "edge",
    headers: { "x-nws-log-uuid": null },
  },
];

/** `window` globals the collector must probe in-page for the fingerprints above. */
export const PLATFORM_WINDOW_GLOBALS: string[] = [
  ...new Set(FINGERPRINTS.flatMap((fp) => fp.globals ?? [])),
];

export interface PlatformFacts {
  /** Final page URL — defines what "first-party" means for URLs. */
  pageUrl: string;
  /** Rendered HTML (post-JS DOM serialization). */
  renderedHtml: string;
  requestUrls: string[];
  /** Main-document response headers. */
  headers: HeaderMap;
  /** Names of the page's first-party cookies at end of capture. */
  cookieNames?: string[];
  /** `window` global names found present in-page. */
  windowGlobals?: Iterable<string>;
}

export interface PlatformProbe {
  /** Web application (e-commerce platform / CMS) labels. */
  platforms: string[];
  platformSignals: string[];
  /** CDN / WAF labels. */
  edge: string[];
  edgeSignals: string[];
}

/** Drop <style>/<script> BODIES but keep their opening tags (`type="text/x-magento-init"` is a signal). */
function markupOnly(html: string): string {
  return html
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, "$1</style>")
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, "$1</script>");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Names of the FIRST-PARTY cookies a response sets. A `Domain=` attribute on
 * another registrable domain disqualifies the cookie; a host-only cookie
 * (no `Domain=`) belongs to the responding host, i.e. the page.
 */
export function firstPartyCookieNames(setCookies: string[], pageUrl: string): string[] {
  const pageHost = hostOf(pageUrl);
  const pageSite = pageHost ? registrableDomain(pageHost) : null;
  const names: string[] = [];
  for (const line of setCookies) {
    const name = line.split("=", 1)[0]?.trim();
    if (!name) continue;
    const domain = /;\s*domain=\.?([^;]+)/i.exec(line)?.[1]?.trim().toLowerCase();
    if (domain && pageSite && registrableDomain(domain) !== pageSite) continue;
    names.push(name);
  }
  return [...new Set(names)];
}

/**
 * Re-run the probe on a run captured EARLIER (web/runner.ts:enrichRunTechno):
 * the stored diag evidence keeps the document headers, every request URL and a
 * rendered-HTML excerpt, but neither the cookies nor the `window` globals — so
 * the caller supplies cookie names from a fresh lightweight fetch, and the
 * global-only signatures (a minority, always doubled by another signal) are lost.
 */
export async function fetchSetCookieNames(url: string, timeoutMs = 10_000): Promise<string[]> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    // A WAF block page still sets the WAF's cookies — which is precisely a signal here.
    const cookies = res.headers.getSetCookie();
    await res.body?.cancel().catch(() => {});
    return firstPartyCookieNames(cookies, res.url || url);
  } catch {
    return [];
  }
}

export function detectPlatform(facts: PlatformFacts): PlatformProbe {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(facts.headers ?? {})) headers[k.toLowerCase()] = v;
  const cookies = facts.cookieNames ?? [];
  const globals = new Set(facts.windowGlobals ?? []);
  const markup = markupOnly(facts.renderedHtml || "");
  const pageHost = hostOf(facts.pageUrl);
  const pageSite = pageHost ? registrableDomain(pageHost) : null;
  const firstPartyUrls = facts.requestUrls.filter((u) => {
    const h = hostOf(u);
    return h !== null && pageSite !== null && registrableDomain(h) === pageSite;
  });

  const out: PlatformProbe = { platforms: [], platformSignals: [], edge: [], edgeSignals: [] };

  for (const fp of FINGERPRINTS) {
    const evidence: string[] = [];

    for (const [name, re] of Object.entries(fp.headers ?? {})) {
      const value = headers[name];
      if (value === undefined) continue;
      if (re === null) evidence.push(`header ${name}`);
      else if (re.test(value)) evidence.push(`header ${name}: ${value.slice(0, 60)}`);
    }
    for (const re of fp.cookies ?? []) {
      const hit = cookies.find((c) => re.test(c));
      if (hit) evidence.push(`cookie ${hit}`);
    }
    for (const re of fp.markup ?? []) {
      if (re.test(markup)) evidence.push(`motif ${re.source} dans le HTML`);
    }
    for (const re of fp.urls ?? []) {
      const hit = facts.requestUrls.find((u) => re.test(u));
      if (hit) evidence.push(`requête ${hit.slice(0, 100)}`);
    }
    for (const re of fp.firstPartyUrls ?? []) {
      const hit = firstPartyUrls.find((u) => re.test(u));
      if (hit) evidence.push(`requête first-party ${hit.slice(0, 100)}`);
    }
    for (const name of fp.globals ?? []) {
      if (globals.has(name)) evidence.push(`global window.${name}`);
    }

    if (evidence.length === 0) continue;
    const signal = `${fp.label} : ${evidence.join(" ; ")}`;
    if (fp.role === "platform") {
      out.platforms.push(fp.label);
      out.platformSignals.push(signal);
    } else {
      out.edge.push(fp.label);
      out.edgeSignals.push(signal);
    }
  }

  // A headless front implies its platform: keep "SFCC (PWA Kit)" alone rather
  // than "SFCC (PWA Kit) + SFCC" when both matched.
  const collapse = (specific: string, generic: string) => {
    if (out.platforms.includes(specific) && out.platforms.includes(generic)) {
      out.platforms = out.platforms.filter((p) => p !== generic);
    }
  };
  collapse("Salesforce Commerce Cloud (PWA Kit)", "Salesforce Commerce Cloud");
  collapse("SAP Commerce Cloud (Spartacus)", "SAP Commerce Cloud (Hybris)");
  collapse("Shopify Hydrogen", "Shopify");
  collapse("WooCommerce", "WordPress");

  // SFCC's embedded eCDN runs on Cloudflare: behind another CDN (Akamai on
  // givenchy.com) its cf-ray passes through, and "Akamai + Cloudflare" would
  // read as two CDNs the brand bought. Name the layer for what it is.
  if (out.platforms.some((p) => p.startsWith("Salesforce Commerce Cloud"))) {
    out.edge = out.edge.map((e) => (e === "Cloudflare" ? "Cloudflare (eCDN SFCC)" : e));
  }

  return out;
}
