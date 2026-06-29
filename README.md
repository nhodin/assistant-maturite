# Maturity Analyzer (POC)

Deterministic web-performance **maturity analyzer — no LLM**. Each criterion from
`../CLAUDE.md` becomes a pure rule (a `Control`) that awards points; topics are
summed into a 0–100 score, mirroring the existing Google Sheets grid
(`../maturity_grid.gs`).

**POC scope:** end-to-end chain (collector → engine → report) validated on **2 pilot
topics**: **1. Images** and **10. CDN**. The architecture supports the other 10 topics
by simply adding modules.

## Architecture (single TypeScript project, modular by folder)

```
src/
  core/        # Shared contract — DO NOT fork. EvidenceBundle (Zod) + Control/TopicModule interfaces.
  collector/   # "Data module": Playwright + network capture + Node probes → EvidenceBundle. Scores nothing.
  topics/      # One module per topic. POC: images.ts, cdn.ts. Pure functions of EvidenceBundle.
  engine/      # Loads config, runs controls, aggregates scores, exports MD/CSV.
  cli/         # Wires WEBSITES.csv → collector → engine → report.
data/
  WEBSITES.csv # Sites in scope (semicolon-delimited: website;url_hp;url_plp;url_pdp).
tests/         # Vitest unit tests.
```

## The contract (read `src/core/` first)

- **`EvidenceBundle`** (`src/core/schema.ts`): the only data the collector produces and
  the only data topics may read. Validated with Zod; TS types are inferred from the schema.
- **`Control`** (`src/core/types.ts`): `evaluate(e: EvidenceBundle) => { passed, evidence }`.
  A control is a **pure function**. It does NOT compute points and does NOT do I/O.
- **`TopicModule`**: groups controls; declares `hasNA` / `standalone`.
- The **engine** turns `passed` into points using `defaultPoints` (optionally overridden by
  config), so points/enable/disable are data, not code.
- **`makeEvidence()`** (`src/core/fixture.ts`): builds a valid bundle for unit tests.

## Scoring rules (from CLAUDE.md / maturity_grid.gs)

- Each control awards its points independently if `passed` (no prerequisites).
- Topic score = sum of awarded points, capped at 100.
- A control that is N/A on a page (`appliesTo` → false) is excluded from that page's topic max.
- Overall = average of topics **1–10** (excluding fully-N/A topics).
- Topics **11 (GEO)** and **12 (China)** are reported separately, never in the average.

## Commands

```bash
npm install
npx playwright install chromium   # one-time browser download
npm run typecheck
npm test
npm run audit                     # full run over data/WEBSITES.csv → reports
```
