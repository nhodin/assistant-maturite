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
- **Evidence persistence**: the run executor (`web/runner.ts`) scores from the **in-memory**
  bundle and stores only a **slimmed** EvidenceBundle (no rawHtml/renderedHtml, no request
  headers) — a full bundle exceeds MySQL `max_allowed_packet` and drops the connection.

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
npm test                                  # vitest (245 tests)

# CLI (no DB, writes out/ reports)
npm run audit -- --browser cloak          # full audit over data/WEBSITES.csv
npm run collect -- https://example.com    # capture one URL → evidence/<host>.json
npx tsx src/cli/rescore.ts                # re-score evidence/*.json against current topics
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
