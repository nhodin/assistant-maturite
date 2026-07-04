# CLAUDE.md — Maturity Analyzer (app)

Guidance for Claude Code working in this directory (`app/`). The evaluation
*framework* (the 12 topics + criteria) lives in the repository-root `../CLAUDE.md`;
this file documents the **application** that implements it.

## Purpose

Deterministic web-performance **maturity analyzer — no LLM**. Each criterion from
`../CLAUDE.md` is a pure rule (`Control`) that awards points; topics sum to a 0–100
score. A site is captured with a headless/stealth browser, scored, and the results are
persisted and browsed through a web UI.

## Stack

- **Node.js / TypeScript** (ESM, `"type":"module"`, tsconfig `moduleResolution: "Bundler"` → extensionless relative imports).
- **Playwright** (+ **CloakBrowser** stealth Chromium) for capture.
- **Prisma 6** (pinned) + **MySQL** for persistence.
- **Fastify + EJS + HTMX** for the server-rendered UI.
- **Vitest** for tests, **tsx** to run TS directly.

## Architecture (modular by folder)

```
src/
  core/        # Shared contract. EvidenceBundle (Zod schema → inferred types) +
               # Control / TopicModule interfaces + makeEvidence() test fixture. DO NOT fork.
  collector/   # Capture → EvidenceBundle. Playwright/CloakBrowser + CDP network +
               # Node probes (TLS/IPv6/HTTP3) + view-source fetch + CrUX. Scores nothing.
               #   browser.ts = swappable provider (playwright | cloak).
  topics/      # One module per topic (01..12). Each Control is a PURE function of an
               # EvidenceBundle → { passed, evidence }. util.ts = shared helpers.
  engine/      # Loads config, runs controls, aggregates per-site, exports MD/CSV.
  cli/         # index.ts = full audit over data/WEBSITES.csv; collect.ts = debug one URL;
               # rescore.ts = re-score saved evidence without re-capturing.
  web/         # Fastify app: server.ts, routes/*, views/* (EJS), public/app.css,
               # db.ts (Prisma), config-store.ts, runner.ts (run executor), seed.ts.
prisma/schema.prisma   # MySQL schema
tests/         # Vitest: per-control tests + engine + topics.meta
data/WEBSITES.csv      # seed source (website;url_hp;url_plp;url_pdp)
```

## Key concepts

- **`Control` is pure**: returns only `{ passed, evidence }`. It does NOT compute points
  and does NOT do I/O. The engine turns `passed` into points using `defaultPoints`
  (optionally overridden by config) — so points/enable/disable are data, not code.
- **Scoring** (matches `../CLAUDE.md`): topic score = sum of awarded points, capped 100;
  `appliesTo`→false means N/A (excluded from the topic max); Overall = average of topics
  **1–10** (excluding fully-N/A); topics **11 (GEO)** and **12 (China)** are standalone.
- **Anti-bot**: LVMH sites sit behind Akamai and block headless Playwright. Use the
  **`cloak`** browser provider (CloakBrowser stealth Chromium) — `--browser cloak` in the
  CLI, default in the UI run form. A residential IP (or proxy) is needed in production.
  **Cloudflare Browser Run was evaluated as a third provider and rejected** (2026-07):
  it's CDP-compatible (Network domain, CSS coverage, PerformanceObserver, mouse/keyboard
  all work — see `src/cli/spike-cloudflare-browser.ts`), but all traffic egresses from
  Cloudflare's own IP ranges with no proxy/IP-rotation/stealth option, and gets a
  403 "Access Denied" from Akamai on the first request — same failure mode as vanilla
  Playwright. Don't re-evaluate it for LVMH sites unless Cloudflare adds proxy/stealth
  support; it remains a legitimate option for capturing *unprotected* sites without
  installing Chromium/CloakBrowser locally.
- **Evidence persistence**: the run executor (`web/runner.ts`) scores from the **in-memory**
  bundle and stores only a **slimmed** EvidenceBundle (no rawHtml/renderedHtml, no request
  headers) — a full bundle exceeds MySQL `max_allowed_packet` and drops the connection.
- **Capture health check**: `collector/sanity.ts` (`assessCaptureHealth`) rejects a capture
  that landed on an error/bot-block page (document request ≥400 mid-capture, a Cloudflare/Akamai
  challenge title, or real `<img>` markup with zero image/stylesheet requests actually captured)
  instead of silently scoring it. The run executor retries once with the **other** browser
  provider (`playwright` ↔ `cloak`) when the configured one fails or is rejected; if the fallback
  succeeds the `RunPage` is `DONE` with a note in `error` saying which provider actually worked,
  and if both fail it's `FAILED` with both providers' reasons. Only the healthy bundle (if any)
  feeds scoring.
- **No more POC-mode controls** (resolved 2026-07 — see `../CLAUDE.md` topics 7/8/9 for the
  criteria these back):
  - **Registrable domain** (`topics/util.ts:registrableDomain`) uses `tldts` (Public Suffix
    List, `allowPrivateDomains: true`) instead of a naive last-two-labels split — this backs
    every first/third-party comparison (CDN, third-parties, fonts self-host, CSS-external),
    so multi-part TLDs (`co.uk`, `com.au`) and PSL-private hosts (`github.io`, `vercel.app`)
    are no longer misclassified as one site.
  - **External CSS is now fetched and parsed.** The collector fetches the body of every
    stylesheet response over CDP (`Network.getResponseBody`, capped at 40 files / 2 MB each)
    as it finishes loading, and combines it with inline `<style>` text before: (a) parsing
    `@font-face` into `EvidenceBundle.fonts` (topic 9 — `fonts.fontdisplay`/`fallback`/
    `subsetting` are no longer blind to fonts declared in an external stylesheet, the common
    case), and (b) computing `EvidenceBundle.css.hasInlinedSvgOrFontDataUri` (topic 7 —
    `css.nosvgfonts`). Only derived booleans/counts are kept on the bundle, not the raw CSS
    text, to stay within the slimmed-evidence size budget (see below).
  - **103 Early Hints are now observed.** The raw-HTML fetch (`collector/index.ts`, formerly
    `fetch()`) uses Node's `http`/`https` `request()` directly and listens for the
    `'information'` event, which surfaces 1xx interim responses — including a 103's headers —
    that `fetch()`/undici silently discard. Populates `EvidenceBundle.earlyHints` (headers of
    the first 103 seen, or `null`), which now drives topic 8's `cp.earlyhints`, and is OR'd
    into topic 7's `css.preload` and topic 1's `images.earlyhint` (both criteria read "in
    response headers **or** 103" in `../CLAUDE.md`).
  - Both `css` and `earlyHints` are zod-defaulted (`css` → all-false/zero, `earlyHints` →
    `null`) so evidence JSON captured before this change still re-scores via
    `npx tsx src/cli/rescore.ts` without a migration step.
- **Criterion detail refinements** (2026-07, expert review — no points/criteria added, only
  detection folded into existing controls):
  - **Topic 1 `images.fixedheight`**: also recognizes CSS-set width/height via an inline
    `style="width:...;height:..."` attribute (not just the HTML `width=`/`height=` attributes),
    and requires `aspect-ratio:` with a colon (not a bare substring match, which false-positived
    on class names like `aspect-ratio-container`).
  - **Topic 7 `css.criticalinline`**: now also fails when an `@import` rule is found in inline
    or external CSS (`EvidenceBundle.css.hasAtImport`, computed alongside
    `hasInlinedSvgOrFontDataUri` from the same combined inline+external CSS text) — `@import`
    forces a serial, render-blocking fetch chain, undermining the "avoid render blocking" intent
    of this criterion.
  - **Topic 8 `cp.headorder`**: in addition to relative tag order, now requires that a present
    `meta[charset]` starts within the first 1024 bytes of `rawHtml` (UTF-8), per the HTML
    Standard's encoding-sniffing rule — a later charset declaration forces the browser to
    re-parse the whole document from scratch.

## Data model (Prisma / MySQL)

`Site → Page` (inventory, Site has a Category) · `Project → ProjectPage` (page selection) ·
`Run → RunPage` (per-page capture + slim evidence) + `RunSiteScore` (aggregated per-site,
ranked) · `ControlConfig` (enable/points/naForced, edited in Settings).
Categories: Beauty, Fragrances, WatchesJewelry, WineSpirits, SR, Other.

## Commands

```bash
# Setup (one-time)
npm install
npx playwright install chromium          # Playwright browser (CloakBrowser self-downloads on first use)
cp .env.example .env                      # set DATABASE_URL (MySQL) — default: maturite/maturite@127.0.0.1:3306/maturite
npm run db:push                           # create/sync MySQL tables (+ prisma generate)
npm run db:seed-inventory                 # optional: seed sites/pages from data/WEBSITES.csv

# Web app (UI + persistence)
npm run web                               # → http://localhost:5173
npm run db:studio                         # Prisma Studio (inspect DB)

# Quality
npm run typecheck                         # tsc --noEmit
npm test                                  # vitest (292 tests)

# CLI (no DB, writes out/ reports)
npm run audit -- --browser cloak          # full audit over data/WEBSITES.csv
npm run collect -- https://example.com    # capture one URL → evidence/<host>.json
npx tsx src/cli/rescore.ts                # re-score evidence/*.json against current topics

# Spike (not wired into the app — see "Anti-bot" above)
npm run spike:cloudflare -- <url>         # Cloudflare Browser Run CDP feasibility check
```

## Conventions / gotchas

- ESM + Bundler resolution → import without file extensions (`from "../core"`).
- Prisma is **pinned to v6** (v7 dropped `url = env()` in the schema).
- `.env` is gitignored; Prisma CLI auto-loads it, the server loads it via `dotenv` (first import).
- The run executor runs **one run at a time** (in-process); the UI polls status via HTMX.
- When adding a topic: create `src/topics/NN-name.ts` exporting a `TopicModule`, register it
  in `src/topics/index.ts`, add per-control tests. Points must sum to 100 (enforced by
  `tests/topics.meta.test.ts`).
- Restart `npm run web` after code changes (tsx does not hot-reload).
