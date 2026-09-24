/**
 * Prospect diagnostic — low-level pure detectors. Spec: ../../../docs/DIAGNOSTIC.md,
 * section "Détection du SSR".
 *
 * All functions here are PURE: given HTML strings (or an `EvidenceBundle`), they
 * return a fact. No I/O, no scoring, no verdict — `checks.ts` builds the `DiagCheck`
 * objects from these; `verdict.ts` (owned elsewhere) turns checks into GO/NOGO.
 */
import { header, headSlice, bodySlice, visibleText, parseTags, stripHtmlComments } from "../topics/util";
import { CDN_HEADERS } from "../topics/cdn";
import { blockSignature } from "../collector/challenge";
import type { EvidenceBundle, HeaderMap } from "../core";

/* ── Calibrated thresholds ─────────────────────────────────────────────────
 * CALIBRATED on a real prospect corpus (per docs/DIAGNOSTIC.md — "Détection du
 * SSR"). Do NOT change these values without re-running the calibration pass on
 * that corpus; they are kept as named constants for exactly that reason.
 * Starting values, to be revisited once the corpus pass runs.
 */
/**
 * Reference share of the rendered DOM's visible text found in the raw HTML.
 *
 * NO LONGER GATES the verdict: it measures "how much of the FINAL text was already
 * there", which is not the question the criterion asks and which punishes a
 * correctly server-rendered page that loads menus, reviews and recommendations in
 * JS. Kept as reported context — see docs/DIAGNOSTIC.md.
 */
export const SSR_TEXT_RATIO = 0.5;
/** Minimum number of visible-text words the raw HTML itself must contain. */
export const SSR_MIN_WORDS = 120;

/** Shingle size (word n-grams) used for the text-overlap measure. */
const SHINGLE_SIZE = 3;

/**
 * Split visible text into word n-grams ("shingles") of `n` words. Shingling makes
 * the overlap measure robust to minor reordering/whitespace differences between
 * the raw and rendered HTML, unlike exact string equality. Text shorter than `n`
 * words becomes a single shingle (the whole text) so short pages remain comparable.
 */
export function shingles(text: string, n: number = SHINGLE_SIZE): string[] {
  const words = text.split(" ").filter(Boolean);
  if (words.length === 0) return [];
  if (words.length < n) return [words.join(" ")];
  const out: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * Share of the RENDERED text's shingles that are also found in the RAW text — i.e.
 * "how much of what ends up on screen was already in the pre-JS HTML". 0 when the
 * rendered text carries no shingles (nothing to check content against).
 */
export function shingleOverlapRatio(rawText: string, renderedText: string): number {
  const renderedShingles = shingles(renderedText);
  if (renderedShingles.length === 0) return 0;
  const rawSet = new Set(shingles(rawText));
  let hits = 0;
  for (const s of renderedShingles) if (rawSet.has(s)) hits++;
  return hits / renderedShingles.length;
}

export interface TextOverlapResult {
  ratio: number;
  rawWords: number;
  overlapOk: boolean;
}

/**
 * Word count of the served HTML, plus the share of the rendered DOM's text already
 * present in it. Compares `bodySlice` of both HTML strings, with script/style/
 * comment content stripped via `visibleText`/`stripHtmlComments`.
 *
 * `rawWords` gates criterion 1; `ratio`/`overlapOk` are reported context only —
 * see SSR_TEXT_RATIO.
 */
export function textOverlap(rawHtml: string, renderedHtml: string): TextOverlapResult {
  const rawText = visibleText(stripNoscript(bodySlice(rawHtml)));
  const renderedText = visibleText(stripNoscript(bodySlice(renderedHtml)));
  const rawWords = rawText ? rawText.split(" ").filter(Boolean).length : 0;
  const ratio = shingleOverlapRatio(rawText, renderedText);
  return { ratio, rawWords, overlapOk: ratio >= SSR_TEXT_RATIO && rawWords >= SSR_MIN_WORDS };
}

/**
 * Drop `<noscript>` content. A browser with JS never displays it, so it is not
 * text a visitor sees before JS runs — and counting it would let a client-side
 * page clear the word threshold with a fallback message (opodo.fr's "Veuillez
 * activer JavaScript…" dialog was ~30 of its 268 served words).
 */
function stripNoscript(html: string): string {
  return html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
}

/** Title strings that are placeholders, not a real page identity — never a valid anchor. */
const GENERIC_TITLES = /^(document|untitled|home|new tab|loading\.{0,3}|react app|vite ?\+? ?(react|vue)?( ?app)?|webpack app|index|app|template)$/i;

function titleAnchor(html: string): string | null {
  const head = stripHtmlComments(headSlice(html));
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!m) return null;
  // Decoded first: Akamai's interstitial is titled "&nbsp;", which is blank, not
  // a page identity (run 46, the four Inditex sites).
  const text = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  if (!text || GENERIC_TITLES.test(text)) return null;
  return text;
}

function ogTitleAnchor(html: string): string | null {
  const metas = parseTags(headSlice(html), "meta");
  for (const meta of metas) {
    const prop = (meta.attrs["property"] ?? meta.attrs["name"] ?? "").toLowerCase();
    const content = decodeEntities(meta.attrs["content"] ?? "").trim();
    if (prop === "og:title" && content) return content;
  }
  return null;
}

function h1Anchor(html: string): string | null {
  // Only an h1 the parser would render: stellantisandyou.com carries
  // "<h1 …>Bienvenue chez Stellantis &You</h1>" inside a JSON string in a
  // <script>, over a body with 0 words. <noscript> is out for the same reason it
  // is out of the word count.
  const clean = stripHtmlComments(html).replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, " ");
  const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(clean);
  if (!m) return null;
  const text = decodeEntities(visibleText(m[1])).replace(/\s+/g, " ").trim();
  return text ? text : null;
}

/** True if a JSON-LD block describes a page entity (any object carrying "@type"). */
function jsonLdAnchor(html: string): string | null {
  const clean = stripHtmlComments(html);
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item === "object" && "@type" in item) {
          return String((item as Record<string, unknown>)["@type"]);
        }
      }
    } catch {
      // Malformed JSON-LD — not a usable anchor, keep scanning other blocks.
    }
  }
  return null;
}

export interface SemanticAnchorResult {
  present: boolean;
  detail: string;
  /** Where it came from. `"h1"` lives in the body; the others live in the head. */
  source?: "h1" | "title" | "og:title" | "jsonld";
  /** The anchor's own text, used by the anti-shell guard below. */
  text?: string;
}

/**
 * Criterion 2 — semantic anchor: at least one of a non-empty `<h1>`, a non-generic
 * `<title>`, `og:title`, or a JSON-LD block describing the page entity.
 */
export function semanticAnchor(html: string): SemanticAnchorResult {
  const h1 = h1Anchor(html);
  if (h1) return { present: true, detail: `h1 non vide ("${h1.slice(0, 60)}")`, source: "h1", text: h1 };
  const title = titleAnchor(html);
  if (title) {
    return { present: true, detail: `title non générique ("${title.slice(0, 60)}")`, source: "title", text: title };
  }
  const og = ogTitleAnchor(html);
  if (og) return { present: true, detail: `og:title ("${og.slice(0, 60)}")`, source: "og:title", text: og };
  const jsonLd = jsonLdAnchor(html);
  if (jsonLd) return { present: true, detail: `JSON-LD @type="${jsonLd}"`, source: "jsonld", text: jsonLd };
  return { present: false, detail: "aucun ancrage sémantique (h1/title/og:title/JSON-LD)" };
}

/**
 * Anti-shell guard: when the anchor lives in the HEAD (`title`, `og:title`,
 * JSON-LD), its subject must also appear in the served BODY.
 *
 * Without it, dropping the text-overlap ratio would let a page whose header and
 * footer alone carry 120+ words pass while its actual content is client-side —
 * exactly what the ratio used to catch. An `h1` anchor needs no guard: it IS in
 * the body.
 *
 * Matching is token-based, not literal: a `<title>` is usually
 * "Bermuda en molleton léger bleu | Kiabi" while the body says
 * "Bermuda en molleton léger", so the site-name suffix is stripped and a MAJORITY
 * of the remaining words must be present. Returns null when the anchor carries
 * too few usable words to judge — an unjudgeable guard must not fail a page.
 */
export function anchorPresentInBody(anchor: SemanticAnchorResult, html: string): boolean | null {
  if (!anchor.present || !anchor.text) return null;
  if (anchor.source === "h1") return true; // in the body by construction
  // Every segment of the title, not just the first. The site name is not always a
  // suffix: snipes.com's "SNIPES Onlineshop - Sneaker, Streetwear & Accessories!"
  // puts it FIRST, and "Onlineshop" appears nowhere in the German body — judging
  // on that segment alone failed a page serving 1711 words (96% of its final
  // text). Pooling the words keeps the guard's teeth: a shell whose footer only
  // names the brand still matches 1 word of "Bermuda en molleton léger bleu Kiabi".
  const words = [
    ...new Set(
      decodeEntities(anchor.text)
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3),
    ),
  ];
  if (words.length < 2) return null; // nothing solid enough to look for
  const body = decodeEntities(visibleText(bodySlice(html))).toLowerCase();
  const found = words.filter((w) => body.includes(w)).length;
  return found / words.length >= 0.6;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç",
  ocirc: "ô", ucirc: "û", ugrave: "ù", icirc: "î", iuml: "ï", euml: "ë",
  auml: "ä", ouml: "ö", uuml: "ü", szlig: "ß", rsquo: "’", lsquo: "‘",
  laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…",
};

/**
 * Decode HTML character references in a text run, so `&amp;` does not become a
 * word "amp" and `&eacute;` in a title matches a literal "é" in the body.
 * Numeric references in full, named ones for the common Latin-1 set.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? m;
  });
}

/** A `src`/`srcset` value that the HTML PARSER can resolve without JS — not a base64 placeholder. */
function isRealImageSrc(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  if (/^data:/i.test(v)) return false;
  return true;
}

export interface ImagePresenceResult {
  present: boolean;
  count: number;
  /** Of `count`, the raster CSS backgrounds declared in the served HTML itself. */
  cssBackgrounds?: number;
}

/** A raster image URL in a CSS `url()` — not a data: URI, not an SVG icon, not a font. */
const CSS_RASTER_URL = /url\(\s*["']?(?!data:)([^"')]+?\.(?:jpe?g|png|webp|avif|gif)(?:\?[^"')]*)?)["']?\s*\)/gi;

/**
 * Distinct raster `background-image` URLs declared IN the served HTML — its
 * `<style>` blocks and `style=""` attributes. Painted by the browser from the
 * HTML and CSS alone, no JS: opodo.fr's only visual before JS is such a
 * background, declared inline in its <head>. External stylesheets are left out on
 * purpose: that is where icon sprites and decorative textures live, and counting
 * them would make every page "have an image".
 */
function inlineCssBackgrounds(html: string): Set<string> {
  const clean = stripHtmlComments(html);
  const css = [
    ...(clean.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []),
    ...(clean.match(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi) ?? []),
  ].join("\n");
  const urls = new Set<string>();
  for (const m of css.matchAll(CSS_RASTER_URL)) urls.add(m[1].trim());
  return urls;
}

/**
 * Criterion 3 — images: at least one `<img>` with a real `src`/`srcset` (a base64
 * placeholder or a `data-src`-only image does NOT count — both need JS to resolve).
 */
/**
 * A tracking pixel, not content: 1×1 declared size, hidden inline, or a known
 * beacon path. ysl.com's only "image without JS" was Akamai's
 * `/akam/13/pixel_…` with `visibility: hidden`.
 */
function isTrackingPixel(attrs: Record<string, string>): boolean {
  const w = Number(attrs["width"]);
  const h = Number(attrs["height"]);
  if (w > 0 && w <= 1 && h > 0 && h <= 1) return true;
  if (/(visibility\s*:\s*hidden|display\s*:\s*none)/i.test(attrs["style"] ?? "")) return true;
  return /\/akam\/\d+\/pixel|\/pixel(\.gif)?\?|facebook\.com\/tr\b|\/collect\?/i.test(attrs["src"] ?? "");
}

export function hasRealImage(html: string): ImagePresenceResult {
  const isReal = (img: { attrs: Record<string, string> }) =>
    !isTrackingPixel(img.attrs) && (isRealImageSrc(img.attrs["src"]) || isRealImageSrc(img.attrs["srcset"]));
  let count = parseTags(html, "img").filter(isReal).length;
  // A <picture> resolves its image from its <source srcset>, with no JS: the
  // browser's own source selection fills the inner <img>, which may carry no src
  // at all. g-star.com serves 18 such pictures (React's `srcSet`) and read as
  // "0 image sans JS". Counted only when the inner <img> was not counted already.
  for (const picture of stripHtmlComments(html).match(/<picture\b[\s\S]*?<\/picture>/gi) ?? []) {
    if (parseTags(picture, "img").some(isReal)) continue;
    if (parseTags(picture, "source").some((s) => isRealImageSrc(s.attrs["srcset"]))) count++;
  }
  const cssBackgrounds = inlineCssBackgrounds(html).size;
  count += cssBackgrounds;
  return { present: count > 0, count, ...(cssBackgrounds > 0 ? { cssBackgrounds } : {}) };
}

/**
 * The raw numbers behind an SSR verdict, kept alongside the formatted evidence.
 *
 * They exist so a THRESHOLD change can be re-evaluated on stored results without
 * recapturing: the evidence sentence is for humans, these are for recalibration.
 * Never parse the sentence to recover them.
 */
export interface SsrMetrics {
  /** Share of the rendered DOM's visible text already present in the pre-JS HTML. */
  overlapRatio: number;
  /** Visible words in the pre-JS HTML body. */
  rawWords: number;
  /**
   * Whether the overlap ratio cleared its reference value. INFORMATIONAL since
   * the criterion became absolute — kept because a stored result must stay
   * self-describing, never because a verdict depends on it.
   */
  overlapOk: boolean;
  /** Which semantic anchor was found, or null when none was. */
  anchor: string | null;
  /**
   * Anti-shell guard: for a head-only anchor (title/og:title/JSON-LD), whether its
   * subject also appears in the served body.  for an h1 anchor (it is in the
   * body),  when the anchor carries too few words to judge.
   */
  anchorInBody?: boolean | null;
  /**
   * Images resolvable without JS: <img>/<picture> with a real src/srcset, plus the
   * raster CSS backgrounds declared in the served HTML (see `cssBackgrounds`).
   */
  imageCount: number;
  /** Of `imageCount`, the CSS backgrounds. Absent when there are none. */
  cssBackgrounds?: number;
  /**
   * The values this verdict was measured against, so a stored result is
   * self-describing.  is a REFERENCE only — the criterion is absolute.
   */
  thresholds: { textRatio: number; minWords: number };
}

export interface SsrEvaluation {
  passed: boolean;
  evidence: string;
  metrics: SsrMetrics;
}

/**
 * The full SSR measurement (all three criteria) applied to a given pre-JS `html`
 * against the rendered DOM. Shared by `ssrUserCheck` (rawHtml) and `ssrBotCheck`
 * (bot.html) — same detection, same verdict rule, per docs/DIAGNOSTIC.md.
 * Criteria 2 and 3 alone are never enough: a complete `<head>` over an empty
 * `<body>` (the SPA case) must fail on criterion 1.
 */
export function evaluateSsr(html: string, renderedHtml: string): SsrEvaluation {
  const overlap = textOverlap(html, renderedHtml);
  const anchor = semanticAnchor(html);
  const images = hasRealImage(html);
  // The anti-shell guard is word matching, and word matching is fragile across
  // languages: snipes.com titles its German site in English ("Sneaker, Streetwear
  // & Accessories" over a body saying "Accessoires"). A shell, by definition,
  // serves its header and footer and little of the final text, so a page that
  // already serves most of it (snipes: 96%) cannot be one — the guard only speaks
  // when the overlap is low too. The overlap still never gates on its own.
  const guard = anchorPresentInBody(anchor, html);
  const anchorInBody = guard === false && overlap.ratio >= SSR_TEXT_RATIO ? null : guard;

  // The verdict is ABSOLUTE — is the content there — not a share of the final
  // page. The share (`overlap.ratio`) is reported but no longer gates: it answers
  // "how much of the final text was already there", which penalises a correctly
  // server-rendered page that loads menus, reviews and recommendations in JS.
  // Measured on the prospect corpus: Shop-Orchestra (45%, 2664 words, h1, 66
  // images) and Byredo (34%, 663 words, h1, 49 images) were both scored NOGO
  // while serving their product in full. See docs/DIAGNOSTIC.md.
  const wordsOk = overlap.rawWords >= SSR_MIN_WORDS;
  const passed = wordsOk && anchor.present && images.present && anchorInBody !== false;

  const parts = [
    `${overlap.rawWords} mots dans le HTML servi (seuil ${SSR_MIN_WORDS}) — ${wordsOk ? "OK" : "insuffisant"}`,
    `ancrage sémantique : ${anchor.detail}`,
    anchorInBody === false
      ? `mais son sujet est absent du corps servi — page coquille (en-tête/pied seuls)`
      : null,
    `images : ${
      images.present
        ? `${images.count} image(s) sans JS${images.cssBackgrounds ? ` (dont ${images.cssBackgrounds} fond(s) CSS déclaré(s) dans le HTML)` : ""}`
        : "aucune image avec src/srcset réel ni fond CSS dans le HTML (JS requis)"
    }`,
    `recouvrement du texte final : ${Math.round(overlap.ratio * 100)}% (indicatif, n'entre pas dans le verdict)`,
  ].filter((p): p is string => p !== null);

  return {
    passed,
    evidence: parts.join(" ; "),
    metrics: {
      overlapRatio: overlap.ratio,
      rawWords: overlap.rawWords,
      overlapOk: overlap.overlapOk,
      anchor: anchor.present ? anchor.detail : null,
      anchorInBody,
      imageCount: images.count,
      ...(images.cssBackgrounds ? { cssBackgrounds: images.cssBackgrounds } : {}),
      thresholds: { textRatio: SSR_TEXT_RATIO, minWords: SSR_MIN_WORDS },
    },
  };
}

/* ── Which document the VISITOR was served ────────────────────────────────── */

export interface VisitorEvaluation {
  /** "fetch" = the collector's direct Node request; "browser" = the browser's own navigation. */
  source: "fetch" | "browser";
  html: string;
  result: SsrEvaluation;
}

export interface VisitorSelection {
  /** The document the visitor verdict is measured on; null when every one was refused. */
  chosen: VisitorEvaluation | null;
  /** Why each set-aside document was refused, in French, for the evidence. */
  refused: string[];
  /** The clean documents that were measured, for the evidence when they disagree. */
  measured: VisitorEvaluation[];
}

/** Below this, a document is an empty body (evicted, reset), not a page. */
const MIN_DOC_BYTES = 200;

/** Reason a candidate document is not the page, or null when it is usable. */
function refusalOf(html: string, status: number | undefined, who: string): string | null {
  const sig = blockSignature(html);
  if (status !== undefined && status >= 400) return `${who} : HTTP ${status}${sig ? ` (${sig})` : ""}`;
  if (sig) return `${who} : ${sig}`;
  return null;
}

/**
 * Pick the visitor document to measure SSR on.
 *
 * Two candidates: the collector's direct request (`rawHtml`) and the document the
 * browser itself received (`browserDoc`). They should be the same page, and on
 * most sites they are — but a WAF or an edge may answer them differently. Run 46:
 * Node got an Akamai interstitial on four Inditex sites and marriott.com while the
 * browser got the page; homeexchange.fr served Node 28 words and the browser 633.
 * Either way the visitor DOES get the content, so a refused or poorer direct
 * fetch must not make a NOGO.
 *
 * Refused documents (4xx/5xx, a block page) are set aside; of the rest, the one
 * that passes wins (the direct fetch first when both do), else the richer one.
 */
export function selectVisitorDocument(e: EvidenceBundle): VisitorSelection {
  const candidates: { source: VisitorEvaluation["source"]; html: string; status?: number; who: string }[] = [
    { source: "fetch", html: e.rawHtml, status: e.rawStatus, who: "fetch direct" },
  ];
  if (e.browserDoc && e.browserDoc.html.trim().length >= MIN_DOC_BYTES) {
    candidates.push({ source: "browser", html: e.browserDoc.html, status: e.browserDoc.status, who: "navigateur" });
  }
  const refused: string[] = [];
  const measured: VisitorEvaluation[] = [];
  for (const c of candidates) {
    const why = refusalOf(c.html, c.status, c.who);
    if (why) refused.push(why);
    else measured.push({ source: c.source, html: c.html, result: evaluateSsr(c.html, e.renderedHtml) });
  }
  const chosen =
    measured.find((m) => m.result.passed) ??
    measured.reduce<VisitorEvaluation | null>(
      (best, m) => (best === null || m.result.metrics.rawWords > best.result.metrics.rawWords ? m : best),
      null,
    );
  return { chosen, refused, measured };
}

/* ── Dynamic rendering (SSR for crawlers only) ────────────────────────────── */

/** Hydration-payload markers a modern framework leaves in the HTML it ships to a real browser. */
const HYDRATION_MARKERS = ["__NEXT_DATA__", "__NUXT__", "__remixContext", "___gatsby"];

function hasHydrationMarker(html: string): string | null {
  for (const marker of HYDRATION_MARKERS) if (html.includes(marker)) return marker;
  return null;
}

export interface DynamicRenderingResult {
  detected: boolean;
  evidence?: string;
}

/**
 * SSR served to crawlers ONLY, recognised POSITIVELY (a deliberate architecture,
 * not an anomaly — see docs/DIAGNOSTIC.md): `x-prerender*` response headers, a
 * `via`/`server` naming a known prerender service, `<meta name="fragment">` /
 * `?_escaped_fragment_`, or the bot HTML carrying full content while app scripts
 * are absent/emptied and no hydration payload is present where the user HTML has
 * one. Requires a bot fetch (`e.bot !== null`) — otherwise there is nothing to
 * compare against a normal user fetch, so it reports not detected.
 */
export function detectDynamicRendering(e: EvidenceBundle): DynamicRenderingResult {
  if (e.bot === null) return { detected: false };
  const bot = e.bot;

  for (const key of Object.keys(bot.responseHeaders)) {
    if (/^x-prerender/i.test(key)) {
      return {
        detected: true,
        evidence: `en-tête ${key}: ${bot.responseHeaders[key]} sur la réponse crawler`,
      };
    }
  }

  for (const name of ["via", "server"]) {
    const value = header(bot.responseHeaders, name);
    if (value && /prerender|rendertron/i.test(value)) {
      return {
        detected: true,
        evidence: `en-tête ${name}: ${value} — nomme un service de prerendering`,
      };
    }
  }

  const metaFragment = parseTags(headSlice(bot.html), "meta").some(
    (t) => (t.attrs["name"] ?? "").toLowerCase() === "fragment",
  );
  if (metaFragment) {
    return { detected: true, evidence: '<meta name="fragment"> présent dans le HTML crawler' };
  }
  if (/_escaped_fragment_/i.test(e.url) || /_escaped_fragment_/i.test(e.finalUrl)) {
    return { detected: true, evidence: "paramètre ?_escaped_fragment_ présent dans l'URL" };
  }

  // Content-based signal only makes sense on a real (non-blocked) crawler fetch,
  // and against a visitor document that is the page rather than a block page —
  // a blocked visitor fetch looks exactly like "empty for users, full for bots".
  if (bot.blocked) return { detected: false };
  const visitor = selectVisitorDocument(e).chosen;
  if (visitor === null) return { detected: false };

  const userSsr = visitor.result;
  const botSsr = evaluateSsr(bot.html, e.renderedHtml);

  // THE ASYMMETRY IS THE SIGNAL: the crawler gets rendered content, the visitor
  // does not. Nothing else produces that shape once a block page is excluded.
  //
  // The hydration marker and the absence of app scripts used to be REQUIRED here,
  // which silently limited detection to Next/Nuxt/Remix/Gatsby: Travis Perkins
  // serves 0 words to a visitor and 3013 to a crawler — textbook prerendering —
  // and went undetected because it ships no such marker. They are now
  // CORROBORATING details, named in the evidence when present.
  if (!userSsr.passed && botSsr.passed) {
    const userMarker = hasHydrationMarker(visitor.html) ?? hasHydrationMarker(e.renderedHtml);
    const botHasMarker = hasHydrationMarker(bot.html) !== null;
    const botAppScripts = parseTags(bot.html, "script").filter(
      (s) => (s.attrs["src"] ?? "").trim() !== "",
    );
    const extras: string[] = [];
    if (userMarker && !botHasMarker) {
      extras.push(`payload d'hydratation "${userMarker}" côté utilisateur, absent côté crawler`);
    }
    if (botAppScripts.length === 0) extras.push("aucun script d'application dans le HTML crawler");
    return {
      detected: true,
      evidence:
        `contenu servi au crawler mais pas au visiteur : ` +
        `${Math.round(botSsr.metrics.overlapRatio * 100)}% / ${botSsr.metrics.rawWords} mots côté crawler ` +
        `contre ${Math.round(userSsr.metrics.overlapRatio * 100)}% / ${userSsr.metrics.rawWords} mots côté utilisateur` +
        (extras.length ? ` (${extras.join(" ; ")})` : ""),
    };
  }

  return { detected: false };
}

/* ── Vigilance flags (non-blocking, never part of the verdict) ────────────── */

export interface VigilanceFlagFact {
  id: string;
  label: string;
  detail: string;
}


function cspStrictFlag(headers: HeaderMap): VigilanceFlagFact | null {
  const csp = header(headers, "content-security-policy");
  if (!csp) return null;
  const scriptSrcMatch = /script-src([^;]*)/i.exec(csp);
  const scriptSrc = scriptSrcMatch ? scriptSrcMatch[0].trim() : csp.trim();
  const hasNonceOrHash = /'nonce-|'sha256-/i.test(scriptSrc);
  const hasUnsafeInline = /'unsafe-inline'/i.test(scriptSrc);
  if (hasNonceOrHash && !hasUnsafeInline) {
    return {
      id: "csp.strict",
      label: "CSP stricte (nonce/hash)",
      detail: `${scriptSrc} — bloque l'injection de script à l'edge`,
    };
  }
  return null;
}

function setCookieFlag(headers: HeaderMap): VigilanceFlagFact | null {
  const setCookie = header(headers, "set-cookie");
  if (!setCookie) return null;
  return {
    id: "html.setcookie",
    label: "Cookie de personnalisation sur le HTML",
    detail: `Set-Cookie présent sur la réponse HTML : ${setCookie.slice(0, 120)}`,
  };
}

function cdnFrontFlag(headers: HeaderMap): VigilanceFlagFact | null {
  for (const name of CDN_HEADERS) {
    const value = header(headers, name);
    if (value !== undefined) {
      return {
        id: "cdn.frontend",
        label: "CDN / anti-bot déjà en frontal",
        detail: `en-tête ${name}: ${value}`,
      };
    }
  }
  return null;
}

/**
 * The site already runs behind Fasterize (run 46: homeexchange.fr answers with
 * `x-fstrz`, `x-fstrz-page-type`, `server-timing: …desc="fstrz"`). Worth saying
 * first: the prospect is a customer, and the HTML measured is already the
 * optimised one.
 */
function fasterizeFlag(headers: HeaderMap): VigilanceFlagFact | null {
  const key = Object.keys(headers).find((k) => /^x-fstrz/i.test(k));
  const timing = header(headers, "server-timing");
  const viaTiming = timing && /desc="?fstrz/i.test(timing);
  if (!key && !viaTiming) return null;
  return {
    id: "fasterize.client",
    label: "Déjà client Fasterize",
    detail: key ? `en-tête ${key}: ${headers[key]}` : `server-timing: ${timing}`,
  };
}

function serviceWorkerFlag(e: EvidenceBundle): VigilanceFlagFact | null {
  if (e.stack?.serviceWorker !== true) return null;
  return {
    id: "sw.registered",
    label: "Service worker enregistré",
    detail: "Un service worker est enregistré sur la page — risque de conflit avec l'edge",
  };
}

/**
 * Non-blocking risks worth naming in the report, never part of a GO/NOGO verdict:
 * strict CSP, `Set-Cookie` on the HTML response, a CDN/anti-bot already in front,
 * a registered service worker.
 */
export function vigilanceFlags(e: EvidenceBundle): VigilanceFlagFact[] {
  const flags: (VigilanceFlagFact | null)[] = [
    fasterizeFlag(e.mainResponseHeaders),
    cspStrictFlag(e.mainResponseHeaders),
    setCookieFlag(e.mainResponseHeaders),
    cdnFrontFlag(e.mainResponseHeaders),
    serviceWorkerFlag(e),
  ];
  return flags.filter((f): f is VigilanceFlagFact => f !== null);
}
