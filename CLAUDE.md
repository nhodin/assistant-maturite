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
               #   browser.ts = swappable provider (cloak | playwright | cdp) + stealth
               #   escalation (CaptureMode) used by the single same-provider retry.
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
- **Topic 11 (GEO) reuses other topics' controls** (2026-08). GEO defines no thresholds
  of its own any more: `topics/geo.ts` imports the borrowed controls and delegates to
  their `evaluate` — `geo.nojscontent` (40) ← `js.nojsview`, `geo.ttfb` (15) ←
  `ttfb.ttfb800`, `geo.htmlcache` (15) ← `ttfb.cdncache` (one composite of 30 split into
  two independent halves, 2026-08), `geo.compressioncdn` (20) ← `cdn.brotli` AND
  `cdn.region`, plus its own `geo.weight1mb` (10). A composite is ALL-OR-NOTHING (a
  control is binary here) and its evidence string reports both halves, so the failing
  one is still nameable. Reusing the controls means a detection fix lands in GEO at the
  same time, and no site is judged differently on the same fact by two topics. The
  borrowed controls are `export`ed from `js.ts`/`ttfbcache.ts`/`cdn.ts` for this — those
  modules must never import `geo.ts` back. The removed ids (`geo.ttfbcache`, `geo.ttfb200`, `geo.lcp25`,
  `geo.cls01`, `geo.ssrcontent`, `geo.ssrratio`, `geo.display2s`) may linger as orphan
  `ControlConfig` rows; `config-store` iterates `ALL_CONTROLS`, so they are ignored.
- **Topic 12 is 50/30/20 and its 50-pt component is DERIVED** (2026-08). `china.basics`
  carries `derivedFromTopics: true` (`core/types.ts`): its result is not a function of the
  bundle but of the OTHER topics' scores on the same China page, so the engine computes it
  in `applyDerivedControls`/`chinaBlock` (`engine/score.ts`) once everything else is
  scored, and IGNORES its `evaluate` (a placeholder kept only to satisfy the contract).
  Points are proportional — `round(50 × chinaOverall / 100)` — which makes it the only
  non-binary criterion in the engine; `passed` means "full component". The remaining
  criteria are `china.nogfwcritical` (30) and `china.cdnchinapop` (20); `china.nogfwall`,
  `china.icp` and `china.cnanalytics` were removed and may linger as orphan
  `ControlConfig` rows.
- **China pages** (`PageScoringMode` in `core/types.ts`): a page is graded `"standard"`
  (the default) or `"china"` — the latter for a `PageKind.CHINA` page, i.e. one served
  to the Chinese market. The rule lives in ONE function, `planControl` in
  `engine/score.ts`; controls stay pure and know nothing about it.
  - `"china"`: topics 1–11 keep only their FIRST enabled criterion, which carries the
    whole topic (`CHINA_TOPIC_POINTS` = 100 → the topic reads 0 or 100, on the same
    scale as a standard score); every other criterion is N/A. Topic 12 is scored in full.
  - `"standard"`: topics 1–11 as before, and topic 12 is N/A — China Market Access is
    only measured on a China page.
  - A site may mix both. They are aggregated in **two separate blocks** and never
    averaged together: `SiteResult.topics/overall/geo` (standard pages) vs
    `SiteResult.chinaTopics/chinaOverall/china` (China pages, the last one being topic 12).
    `RunSiteScore` persists both (`chinaTopicsJson`, `chinaOverall`), `RunPage.mode`
    records the family a page was graded in so a later inventory edit cannot rewrite
    history, and the CSV export appends a `China pages overall score` column.
- **Anti-bot**: LVMH sites sit behind Akamai and block headless Playwright. Use the
  **`cloak`** browser provider (CloakBrowser stealth Chromium) — `--browser cloak` in the
  CLI, default in the UI run form. A residential IP (or proxy) is needed in production.
  **CloakBrowser Pro** is configured entirely from `.env` — `src/collector/cloak-config.ts`
  turns `CLOAKBROWSER_LICENSE_KEY` / `CLOAK_PROXY` / `CLOAK_GEOIP` / `CLOAK_HUMANIZE` /
  `CLOAK_HUMAN_PRESET` / `CLOAK_HEADLESS` into the `launch()` options the provider passes.
  Optional keys are **omitted**, not set to `undefined`, so cloakbrowser's own fallbacks
  (env var read by the binary itself, `~/.cloakbrowser/license.key`) stay in play; a blank
  key value is treated as absent, so the placeholder line in `.env` is harmless. Caller
  overrides (`--proxy`, explicit headless) win over the environment. `geoip` needs the
  optional `mmdb-lib` peer and a proxy — both are checked, and a missing one degrades to a
  warning rather than a failed capture. `npm run cloak:check` prints the resolved config
  (secrets masked), validates the licence, reports the binary tier and runs one stealth
  probe.
  **Cloudflare Browser Run was evaluated as a third provider and rejected** (2026-07):
  it's CDP-compatible (Network domain, CSS coverage, PerformanceObserver, mouse/keyboard
  all work — see `src/cli/spike-cloudflare-browser.ts`), but all traffic egresses from
  Cloudflare's own IP ranges with no proxy/IP-rotation/stealth option, and gets a
  403 "Access Denied" from Akamai on the first request — same failure mode as vanilla
  Playwright. Don't re-evaluate it for LVMH sites unless Cloudflare adds proxy/stealth
  support; it remains a legitimate option for capturing *unprotected* sites without
  installing Chromium/CloakBrowser locally.
- **`cdp` provider — a REAL, user-owned Chrome** (2026-08). Third provider, highest
  anti-bot fidelity, for the sites CloakBrowser itself can't get through. Two modes,
  auto-selected in `collector/browser.ts`:
  1. **attach** — a Chrome is already listening on `cdpEndpoint` (default
     `http://127.0.0.1:9222`, overridable via `CDP_ENDPOINT`), started with
     `chrome.exe --remote-debugging-port=9222`: `connectOverCDP` + **`browser.contexts()[0]`**
     (never `newContext()`, which would create a fresh incognito context and throw the
     user's real cookies/history away). Verified: `browser.close()` on a CDP connection
     only *detaches* — the user's Chrome keeps running — and we close only the tab we
     opened. An attached context carries no Playwright emulation, so the provider
     returns a `preparePage` hook that applies mobile metrics/UA/touch over CDP's
     `Emulation` domain; the collector calls it right after `newPage()` (the ONLY
     provider-specific branch in the collector).
  2. **launch** — nothing on the endpoint: `launchPersistentContext` on the *installed*
     Chrome (`channel: "chrome"`, not the bundled Chromium), headful, with a dedicated
     persistent profile at `data/chrome-profile/` (gitignored) so accepted banners and
     device reputation accumulate across runs.
  Both modes need a graphical session (a Chrome window appears), and nothing selects `cdp`
  automatically any more — it is a manual choice for a human-warmed rescue. `collector/index.ts` no longer calls
  `context.close()`; teardown is the provider's business (closing the context in attach
  mode would close the user's own tabs).
  **Measured on `fr.louisvuitton.com/fra-fr/homepage` (Akamai), 2026-08 — read the whole
  story before trusting `cdp` as an answer to anti-bot:**
  - First attempt: `cloak` → document HTTP 403, 11 requests, 12 KB rendered DOM, rejected
    by `assessCaptureHealth`; `cdp` → health OK, 2 MB rendered DOM, real LCP `<img>`, 197
    head tags, 10 `@font-face`, TLS 1.3 / h2 / HTTP3 / IPv6 probed. So the provider works.
  - One hour and a handful of blocked captures later, from the same IP: **every** provider
    got 403 — `cloak`, `playwright`, `cdp` in launch mode, `cdp` in attach mode against a
    Chrome started with human-style flags, AND a fresh throwaway profile. The plain Node
    raw-HTML fetch, which had returned 1 MB earlier, also started returning a 12 KB
    maintenance page. Meanwhile the operator's own everyday Chrome loaded the site fine.
  - Diagnosis: Akamai hardened its stance **towards this client**, and now demands a valid
    `_abck` sensor cookie that only a warm, genuinely human session holds. The blocker is
    the client's standing (IP + session), not which Chromium drives the capture — so no
    provider is a general answer here, and repeated automated captures actively make it
    worse. A residential proxy, a human-warmed attach session, or manual evidence import
    are the real mitigations.
  - Note for attach mode: Chrome 136+ refuses `--remote-debugging-port` on the DEFAULT
    user-data-dir, so attaching to the operator's actual everyday profile is not possible;
    attach targets a separate `--user-data-dir`, which starts cold.
- **No provider fallback — the retry is a STEALTH ESCALATION on the same browser**
  (2026-08, replaces the old `fallbackChain`). CloakBrowser Pro is already the most
  human-like client available, so switching to a weaker Chromium after a block could only
  do worse while handing the WAF another data point. `asProvider` therefore defaults to
  `cloak`, and a page gets **at most two attempts, both on the configured provider**, per
  `CaptureMode` (`core/types.ts`) — the escalation ladder CloakBrowser's own guidance
  prescribes:
  - `"standard"`: **headless**, fresh context, humanize per `.env`. Where every capture
    starts (headless needs no display and is simpler to run).
  - `"escalated"`: fired once when the first attempt throws or is rejected by
    `assessCaptureHealth`. **Headed** (headless is detectable on its own, so headed is the
    escalation, not the starting point) + `humanize`/`careful` forced on + a **persistent
    per-origin profile** under `data/cloak-profiles/<host>/` (gitignored) via
    `launchPersistentContext`, so cookies and history accumulate and the session reads as a
    returning user. Per-ORIGIN, not shared: the pool captures several origins in parallel
    and a persistent context locks its directory.
  - After a `"blocked"` failure the retry waits `BLOCK_COOLDOWN_MS` (20 s) first, and the
    per-origin budget (`ORIGIN_BLOCK_BUDGET` = 2) skips the escalation entirely once an
    origin has blocked that many captures in the run — the LV measurement above is why.
  - **Scoring caveat**: a warm profile may already hold the site's consent cookie, so
    consent-gated third parties can load without the banner being clicked. A page rescued
    by the escalated attempt is `DONE` with a note in `RunPage.error` saying so — Topic 4
    evidence from such a capture is weaker than from a standard one.
- **`vitest.config.ts` pins `include` to `tests/**/*.test.ts`** — the `cdp` launch mode's
  persistent profile (`data/chrome-profile/`) contains Chrome extensions that ship their own
  `.spec.js` files, which the default glob happily collected and failed on.
- **Evidence persistence**: the run executor (`web/runner.ts`) scores from the **in-memory**
  bundle and stores only a **slimmed** EvidenceBundle (no rawHtml/renderedHtml, no request
  headers) — a full bundle exceeds MySQL `max_allowed_packet` and drops the connection.
- **Interruption & resume**: a run lives only in the server process, so stopping the server
  kills it. Three things make that recoverable:
  1. **Site aggregates are rebuilt from the per-page scores, not from the bundles**
     (`engine.scoreSiteFromPages`). The aggregation rule only ever reads `applicable`/`passed`
     per page, and those are exactly what `RunPage.topicsJson` persists — so a site can be
     aggregated from pages captured minutes or days apart. `tests/runner-resume.test.ts` pins
     that this path is criterion-for-criterion identical to `scoreSite` on live bundles.
     Consequence: no bundle is held in memory waiting for a site to complete, and each site's
     `RunSiteScore` is written as soon as its last page settles rather than at the end of the run.
  2. `recoverStaleRuns()` runs once at server start and flips any run left `RUNNING`/`PENDING`
     (plus its non-terminal pages) to `FAILED` with an explicit reason — otherwise the UI polls
     a spinner nobody will ever advance.
  3. `resumeRun(id)` (`POST /runs/:id/resume`) continues it: `planResume` recaptures **exactly
     the pages that are not DONE**, nothing else, then re-aggregates the sites those pages belong
     to. The resume reuses the run's stored `configJson`, never the current settings, so one
     ranking never mixes two scoring rules.
     One endpoint covers two situations, and the UI labels them apart: an interrupted run offers
     « Reprendre » (pages never captured), a **DONE** run with failures offers « Relancer les
     échecs » — a WAF block on 3 of 30 pages is retried without paying for the other 27. Note
     that `donePages` counts failures too, so the run list shows a `N KO` badge next to `30/30`
     rather than pretending the run is complete.
  4. `recaptureSite(runId, siteId)` (`POST /runs/:id/sites/:siteId/recapture`, button on the
     per-site page) shares the same executor with a **site scope**: it takes every page of that
     one site, DONE ones included, and rebuilds only its aggregate. Resume *finishes* a run,
     recapture *refreshes* one site of it — hence the different page selection. Like a resume it
     reuses the run's stored `configJson`, so the refreshed site stays comparable to its siblings.
- **Bot-challenge wait**: `collector/challenge.ts` (`waitForChallengeToSettle`) runs right after
  the post-navigation `networkidle`. An interstitial is a tiny page, so `networkidle` settles ON
  IT within a second and everything after would measure the challenge; a self-clearing
  Cloudflare/Akamai interstitial gets `CAPTURE_CHALLENGE_TIMEOUT_MS` (default 30 s) to hand over,
  and when it does the collected requests are dropped so the capture restarts clean on the real
  document (the perf init script re-runs on it anyway). **The module only waits** — no checkbox
  is clicked, no CAPTCHA solved; an interactive challenge times out and is reported blocked, to
  be cleared by hand with `CLOAK_HEADLESS=0` or allowlisted by the origin. Two consequences
  elsewhere: `assessCaptureHealth` judges the LAST document response per URL (a challenge is a
  403 on the very URL the page is then served from), and the main-document headers are taken
  from a **successful** document response only, never the WAF's 403.
- **Raw-HTML rescue**: Step 1's raw fetch is a bare Node request with no cookies, so a protected
  origin serves it the interstitial however patient the browser was. When it comes back empty,
  header-less, or with a challenge title, `collect` refetches through `context.request` — the
  browser session's cookies (`cf_clearance` & co) come with it. Skipped on a healthy capture, so
  a normal origin takes no extra hit.
- **Capture health check**: `collector/sanity.ts` (`assessCaptureHealth`) rejects a capture
  that landed on an error/bot-block page (document request ≥400 mid-capture, a Cloudflare/Akamai
  challenge title, or real `<img>` markup with zero image/stylesheet requests actually captured)
  instead of silently scoring it, and returns a `kind` (`"blocked"` | `"unusable"`) that drives
  the retry above. The run executor retries once with the SAME provider in `"escalated"` mode;
  if that rescues the page the `RunPage` is `DONE` with a note in `error` (first failure +
  warm-profile caveat), and if both attempts fail it's `FAILED` with both reasons. Only the
  healthy bundle (if any) feeds scoring.
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
    `css.nosvgfonts`, scoped to the **external stylesheets only**: inline `<style>` blocks
    belong to the page HTML and are out of scope for that criterion, though they still count
    for `hasAtImport`). Only derived booleans/counts are kept on the bundle, not the raw CSS
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
- **Topic 3 (video) — poster resolution + critical-path gate** (2026-08):
  - **`resolvePosterEvidence(rawHtml)`** (exported from `topics/video.ts`) is the ONE poster
    resolver, shared by `video.posternojs` and `video.preloadposter` so both judge the same
    poster and a detection fix lands in both at once. It returns `{ kind, urls, detail }` for
    three forms, in priority order: `<video poster>` (`"attribute"`), an `<img>`/`<source srcset>`
    stacked over a `<video>` (`"overlay"`), or a `<noscript><img>` fallback (`"noscript"`).
    The overlay pattern (louisvuitton.com HP) puts the poster in a SIBLING element hidden once
    the video loads, so the old `<video poster>`-only check scored 0 on a page whose poster does
    paint without JS. Three traps it handles, each pinned by a test: a URL living only in
    `srcset` counts (the parser resolves it — `src` is often a base64 GIF placeholder) while
    `data-src`/`data-srcset` do not (they need JS); `<source>` is only a candidate when it has
    `srcset`, because `<source src>` inside a `<video>` is the video file; and the poster-name
    tokens (`poster|cover|placeholder|fallback|still|preview`) are matched with word boundaries
    on `class`/`id`/`data-*` only, so "discover" is not "cover". Association with the video is
    positional — a 4 KB-before / 1 KB-after window around each `<video>` — which is a heuristic:
    the `evidence` string always names the element retained so a reviewer can audit it.
  - **`videoGate` now also requires the video to be on the critical path**: `videoDetected` AND
    (`features.videoInViewport !== false` OR the LCP element is the video/its poster). ALL six
    controls share it, so the topic is N/A **as a block** (a test asserts the single shared
    gate). Rationale: none of the criteria describe good practice for a below-the-fold video —
    preloading its poster would steal bandwidth from the real LCP, and deferring its player is
    what it should do — so scoring it would penalise a correct decision. Consequence: the topic
    leaves the topic max AND the Overall average, which can RAISE a site's overall score, so
    runs before/after this change are not comparable on Overall.
  - **`features.videoInViewport`** (collector, `PageFeaturesSchema`) is the new fact behind it:
    `getBoundingClientRect()` on `video, iframe[src*=youtube|vimeo]`, excluding zero-size boxes
    and `display:none`/`visibility:hidden`. It is measured in the same `page.evaluate` as
    `videoDetected`, which runs AFTER `autoScroll()` has scrolled back to the top — hence the
    rect is relative to the initial viewport. Caveat: it is taken at end of capture, so a video
    injected late above the fold counts as in-viewport even if it was not there at first paint.
    The field is **optional** — `undefined` means "not measured" (evidence captured before it
    existed) and controls must treat it as unknown, NOT as `false`, which keeps historical
    verdicts intact. Note that a run stored in DB keeps only 2 000 chars of `rawHtml`
    (`slimEvidence`), so these topic-3 changes cannot be replayed by `rescore` on old runs — a
    fresh capture is required.
- **Manual criterion correction** (2026-08): on a captured page, an operator who re-checked
  a test can flip ONE criterion's verdict (✓ / ✗ / N/A) from the run's per-site page or the
  per-page criteria panel — `POST /runs/:id/pages/:runPageId/criteria/:controlId`
  (`verdict=pass|fail|na|auto`). The route edits the verdict stored in `RunPage.topicsJson`,
  re-scores the page with `engine.rescorePageFromVerdicts` (same rule as `scorePage`, but each
  verdict is read from the stored result instead of the bundle) and rebuilds the site aggregate
  via `web/site-score.ts:rebuildSiteScore` — the helper `runner.settleSite` now also calls, so
  a correction and a capture converge through the same code. It reuses the run's `configJson`,
  like a resume, so a corrected page stays graded by the run's rules.
  **Deliberately not persisted anywhere else**: recapturing the page (or re-running the project)
  recomputes it from the evidence and the correction is gone — it fixes the reading of ONE
  capture, it is not a rule (a rule belongs in Settings' `ControlConfig`, which applies to every
  site of every run). Two guards: the corrected criterion carries `manual: true` plus `auto`
  (the measured verdict, stashed on the first correction) so the UI flags it ✏️ and offers
  « ↺ mesuré » to undo, and a `derivedFromTopics` criterion (`china.basics`) is read-only since
  the engine rewrites it at every re-score. Tests: `tests/manual-verdict.test.ts`.
- **Detection-logic review** (2026-07, 25 findings — see
  `docs/2026-07-02-criteria-logic-review.md` for the full list, dispositions and rationale):
  20 fixes landed across the topic modules and the collector (e.g. `private, max-age>0` no
  longer fails browser-cache; provider counting by registrable domain with GTM+GA grouped;
  @font-face families no longer double-counted with URL stems; slider controls scoped to the
  detected slider markup (`features.sliderHtml`) instead of the whole page; preload controls
  match the preloaded URL to the LCP/poster/slide target; empty-rawHtml captures rejected by
  the sanity gate; CPU throttling ×4 on mobile capture (since 2026-08 off by default and
  env-driven, see **Capture throttling**); HTTP/2 fallback probe for 103s; CDP
  document headers preferred over the Node fetch). 2 findings are deferred pending a scoring
  policy decision — notably "unmeasured ≠ failed" (a third control outcome), which would
  change score semantics for historical runs.
- **Webperf monitoring mode** (2026-07): a Project with `mode=MONITORING` is re-run on a
  fixed frequency (DAILY/WEEKLY) by an in-process scheduler (`web/monitor.ts`, started by
  `web/server.ts`, 60 s tick). Each cycle collects CrUX field p75s (LCP/TTFB/INP/CLS/FCP)
  for every distinct site **origin** and every project **page** URL (persisted as
  `CruxSnapshot` rows; `collector/crux.ts:fetchCruxMetrics` queries by `{origin}` or `{url}`),
  then starts a maturity Run tagged `source="scheduled"`. The scheduler respects the
  one-run-at-a-time constraint (skips the tick and retries; `monitorNextAt` only advances
  when the cycle actually ran). The project detail page shows a latest-CrUX table and
  per-metric trend charts (`web/crux-trend.ts`, pure like `web/trend.ts`) plus a
  "Collecter maintenant" button. Monitoring only runs while `npm run web` is up.
  The web runner also passes `CRUX_API_KEY` (.env) to the collector, so topic 11 (GEO)
  uses field data in UI runs.

## Data model (Prisma / MySQL)

`Site → Page` (inventory, Site has a Category, Page has a PageKind — `CHINA` marks a
China page) · `Project → ProjectPage` (page selection;
Project has `mode` STANDARD/MONITORING + monitor frequency/next-due) · `Run → RunPage`
(per-page capture + slim evidence; Run has `source` manual/scheduled) + `RunSiteScore`
(aggregated per-site, ranked) · `CruxSnapshot` (per-project CrUX p75 samples, scope
ORIGIN or PAGE) · `ControlConfig` (enable/points/naForced, edited in Settings).
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
npm test                                  # vitest (395 tests)

# CLI (no DB, writes out/ reports)
npm run audit -- --browser cloak          # full audit over data/WEBSITES.csv
npm run collect -- https://example.com    # capture one URL → evidence/<host>.json
npm run collect -- <url> cdp              # …with a real Chrome (attach to :9222, else launch)
npm run cloak:check                       # CloakBrowser licence + binary + stealth smoke test
npx tsx src/cli/rescore.ts                # re-score evidence/*.json against current topics

# Spike (not wired into the app — see "Anti-bot" above)
npm run spike:cloudflare -- <url>         # Cloudflare Browser Run CDP feasibility check
```

## Conventions / gotchas

- ESM + Bundler resolution → import without file extensions (`from "../core"`).
- Prisma is **pinned to v6** (v7 dropped `url = env()` in the schema).
- `.env` is gitignored; Prisma CLI auto-loads it, the server loads it via `dotenv` (first import).
- The run executor runs **one run at a time** (in-process); the UI polls status via HTMX.
  Parallelism lives INSIDE a run: `collector/concurrency.ts` groups the run pages by
  **origin** and `runner.ts` captures `CAPTURE_CONCURRENCY` buckets at once (default 2),
  each bucket sequentially. Widening the pool adds brands in flight, never simultaneous
  hits on one WAF. Two ceilings to respect: the CloakBrowser plan (`CLOAK_SESSION_LIMIT`,
  default 5 — a higher CAPTURE_CONCURRENCY warns at run start rather than being clamped,
  so a plan/config mismatch surfaces instead of hiding behind a slow run), and measurement
  fidelity — every extra session shares CPU/bandwidth with the one being timed, so lab
  TTFB/LCP drift upward past 2-3 slots.
- **Capture throttling** (`src/collector/throttling.ts`) — CPU and network throttling are
  both **off by default** and driven from `.env`: `CAPTURE_CPU_THROTTLING` (multiplier, 1 =
  off; 4 = Lighthouse mobile slowdown) and `CAPTURE_NETWORK_PROFILE`
  (`off`|`slow3g`|`slow4g`|`fast4g`, `slow4g` = Lighthouse simulated mobile). Applied over
  CDP right after `Network.enable`, before any navigation. Off by default because a throttle
  moves every timing control (TTFB, LCP, long tasks, geo's 2 s render gate), so it must be a
  declared decision: **a throttled run is comparable with other throttled runs, not with the
  historical unthrottled ones** — including the ×4 mobile CPU slowdown that used to be
  unconditional. Structural controls (formats, lazyload, head order, headers) are unaffected.
  Malformed values degrade to "no throttling" plus a warning rather than failing the capture;
  the resolved setting is logged at run start and by `npm run collect`.
- When adding a topic: create `src/topics/NN-name.ts` exporting a `TopicModule`, register it
  in `src/topics/index.ts`, add per-control tests. Points must sum to 100 (enforced by
  `tests/topics.meta.test.ts`).
- Restart `npm run web` after code changes (tsx does not hot-reload).
