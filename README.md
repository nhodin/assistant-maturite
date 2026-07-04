# Maturity Analyzer

Deterministic web-performance **maturity analyzer — no LLM**. Each evaluation
criterion is a pure rule (a `Control`) that awards points; a topic's criteria sum
into a 0–100 score. A site is captured with a stealth headless browser, scored,
and the results are persisted to MySQL and browsed through a web UI (or exported
as Markdown/CSV reports from the CLI).

Built to audit e-commerce sites (LVMH brands) across **12 performance topics**:
images, sliders, videos, third parties, TTFB/cache, JS, CSS, critical path,
fonts, CDN, technical GEO and China market access.

## How it works

```
Capture (Playwright/CloakBrowser + CDP)  →  EvidenceBundle (Zod-validated JSON)
                                         →  Scoring (pure rules per topic)
                                         →  MySQL + web UI  /  MD & CSV reports
```

- **Capture**: mobile-emulated navigation, CDP network interception, raw-HTML
  fetch (listening for 103 Early Hints), Node probes (TLS 1.3, IPv6, HTTP/3),
  external CSS fetching and parsing (`@font-face`, `@import`, data-URIs), CrUX
  field data.
- **Scoring**: a `Control` is a pure function `EvidenceBundle → { passed, evidence }`.
  Points, enable/disable and forced-N/A are **data** (editable in the UI Settings),
  not code.
- **Anti-bot**: sites behind Akamai block vanilla headless Playwright — the
  `cloak` provider (CloakBrowser stealth Chromium) is the default in the UI.
  A capture health check (`src/collector/sanity.ts`) rejects error/bot-challenge
  pages instead of silently scoring them, and the run executor retries once with
  the other browser provider.

## Scoring rules

- Each control awards its points independently if `passed` (no prerequisite order).
- Topic score = sum of awarded points, capped at 100. Point distribution is
  degressive: simple high-impact optimizations award more.
- **N/A** is possible (e.g. no slider/video on any page) → topic excluded from the average.
- **Overall score** = average of topics 1–10. Topics **11 (Technical GEO)** and
  **12 (China Market Access)** are standalone scores reported separately.

| # | Topic | # | Topic |
|---|---|---|---|
| 1 | Images management | 7 | CSS management |
| 2 | Slider management | 8 | Critical path |
| 3 | Videos management | 9 | Fonts management |
| 4 | Third parties | 10 | CDN |
| 5 | TTFB/Cache | 11 | Technical GEO *(standalone)* |
| 6 | JS management | 12 | China Market Access *(standalone)* |

The executable source of truth for every criterion and its points is
`src/topics/*.ts` — each topic's points sum to 100, enforced by
`tests/topics.meta.test.ts`.

## Stack

- **Node.js ≥ 20 / TypeScript** (ESM)
- **Playwright** + **CloakBrowser** (stealth Chromium) for capture
- **Prisma 6** + **MySQL** for persistence
- **Fastify + EJS + HTMX** for the server-rendered UI
- **Vitest** for tests, **tsx** to run TS directly

## Architecture

```
src/
  core/        # Shared contract: EvidenceBundle (Zod schema) + Control/TopicModule interfaces
  collector/   # Capture → EvidenceBundle (scores nothing); sanity.ts = capture health check
  topics/      # One module per topic (01..12), pure controls
  engine/      # Loads config, runs controls, aggregates, exports MD/CSV
  cli/         # index.ts (full audit), collect.ts (debug one URL), rescore.ts (re-score saved evidence)
  web/         # Fastify app: routes, EJS views, run executor, seeds, client grouping, score trends
prisma/schema.prisma   # MySQL schema
tests/                 # Vitest — 633 tests
data/WEBSITES.csv      # Inventory source (website;url_hp;url_plp;url_pdp)
```

## Setup

```bash
npm install
npx playwright install chromium      # CloakBrowser self-downloads on first use
cp .env.example .env                 # set DATABASE_URL (MySQL)
npm run db:push                      # create/sync tables (+ prisma generate)
npm run db:seed-inventory            # optional: seed sites/pages from data/WEBSITES.csv
```

## Usage

```bash
# Web app (runs, ranking, inventory, settings, diagnostics)
npm run web                          # → http://localhost:5173

# CLI (no DB, writes reports to out/)
npm run audit -- --browser cloak     # full audit over data/WEBSITES.csv
npm run collect -- https://example.com   # capture one URL → evidence/<host>.json
npx tsx src/cli/rescore.ts           # re-score evidence/*.json without re-capturing

# Quality
npm run typecheck
npm test
```

## Web app features

**Inventory** (sites + pages, by category) · **Projects** (select pages to test
together) · **Runs** (launch, live progress via HTMX, history) · per-run/per-site
**detail** with control-level evidence · global + per-category **ranking** ·
**score trends** across runs · **client grouping** · **Settings**
(enable/disable controls, re-point) · **Diagnostics** (MySQL / headless /
CloakBrowser / collect).

Data model: `Site → Page` (inventory) · `Project → ProjectPage` (selection) ·
`Run → RunPage` (per-page capture + slim evidence) + `RunSiteScore` (aggregated,
ranked) · `ControlConfig` (edited from Settings).

## Notes

- `.env` is gitignored; see `.env.example` for the expected variables.
- Prisma is pinned to **v6** (v7 dropped `url = env()` in the schema).
- The run executor runs **one run at a time** (in-process); the UI polls status via HTMX.
- See [CLAUDE.md](CLAUDE.md) for architecture details and conventions.
