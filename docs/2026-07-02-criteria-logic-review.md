# Criteria & Detection-Logic Review — 2026-07-02

Expert review of the 12 topic modules (`src/topics/*`) against the evaluation
framework in `../CLAUDE.md`, including how each criterion is *found in the
evidence* (`src/collector/*`, `src/core/schema.ts`). 25 findings, ordered by
impact. Each finding carries a **disposition**: `FIX` (code fix applied on this
branch), `DOC` (documented limitation / description honesty fix), or
`DEFER` (needs a product/scoring-policy decision — not auto-fixed).

## Summary

| # | Severity | Area | Finding | Disposition |
|---|----------|------|---------|-------------|
| 1 | High | collector/sanity | Silent raw-HTML fetch failure (`rawHtml=""`) is scored instead of rejected; `tp.deferasync` even passes vacuously | FIX |
| 2 | High | ttfb.browsercache | `Cache-Control: private, max-age>0` fails the control although the browser caches it — contradicts criterion & own evidence text | FIX |
| 3 | High | tp.limit | GA4 (`googletagmanager.com` + `google-analytics.com`) counted as 2 providers in one category → systematic false fail; providers counted per hostname, not per registrable domain | FIX |
| 4 | High | fonts.max2 | @font-face family names unioned with URL stems → every font double-counted → systematic false fail | FIX |
| 5 | High | css.order | Sites with fully-inlined CSS (no `<link rel=stylesheet>`) fail the 25-pt control — punishes best practice | FIX |
| 6 | High | slider.* | Controls score page-wide images, not the slider (≈60 free pts when a slider exists); `[class*='slider']` gate over-triggers | FIX |
| 7 | High | cp.limitresources | Sums ALL stylesheet/script requests incl. consent-triggered and interaction-phase — not "critical" resources | FIX |
| 8 | High | collector probes | 103 Early Hints probed over HTTP/1.1 (many CDNs emit 103 only on H2/H3) → false negatives; raw fetch never advertises `zstd` so `cdn.zstd` main-HTML branch is dead code | FIX (zstd advertise where decodable; H2 103 fallback probe) |
| 9 | High | images.lcppreload / video.preloadposter / slider.preloadnext | Preload controls don't match the preloaded URL to the target (LCP image / poster / slide) — one generic preload validates 3 topics | FIX |
| 10 | Medium | collector | No CPU throttling on mobile capture → `js.splittasks` (no long tasks) and `geo.display2s` optimistically pass | FIX (CDP `Emulation.setCPUThrottlingRate(4)` for mobile) |
| 11 | Medium | ttfb.bfcache | Unload handlers grepped in HTML only; they live in external bundles → systematic false pass | DOC (low-confidence flag; real fix = back-nav probe, deferred) |
| 12 | Medium | fonts.fallback | Collector only parses `size-adjust` (not `ascent-override`/`descent-override`) from CSS; `local(...)` fallback half of the criterion unimplemented → 20-pt control near-impossible | FIX |
| 13 | Medium | fonts.subsetting | `/(…|ext)\b/` has no left boundary — `next.woff2`, `text…` false-positive | FIX |
| 14 | Medium | tp.deferasync | Criterion says "on critical path" but control scans all of rawHtml — sync 3P script at end of body fails it | FIX (scope to `<head>`) |
| 15 | Medium | interaction phase | Time-window attribution: timer-fired requests during the 1.8 s window credited as "event-based loading" (tp/js.eventbased, slider.delaynext, video.playerjs) | DOC (causal double-capture too expensive; heuristic documented) |
| 16 | Medium | collector | Header-based controls (topics 5/8/10) score the Node fetch response (iPhone-Safari UA, HTTP/1.1), not the browser's | FIX (prefer CDP document response headers, Node fetch as fallback + 103 source) |
| 17 | Medium | ttfb.cdncache | Control stricter than written criterion (only s-maxage/hit/age; criterion allows `max-age>0`) | FIX (accept non-private max-age>0 as weak signal, evidence notes it) |
| 18 | Low | engine policy | Measurement failure (null CLS/coverage/LCP element) scores as fail — capture faults penalize the site | DEFER (needs per-control "unmeasured" outcome in engine + UI) |
| 19 | Low | images.lazyload | 30 pts for a single `loading=lazy`; JS lazyload (`data-src`) accepted by slider topic but not here | FIX (accept data-src pattern; keep ≥1 threshold, documented) |
| 20 | Low | bytes accounting | `encodedBytes=0` for cached responses → `images.compressed` vacuous pass, `geo.weight1mb` undercount; page weight also measured after full scroll | FIX (skip 0-byte cached entries in compressed check; DOC for page weight) |
| 21 | Low | images.modernformat | SVGs and tracking pixels count against the >50 % webp/avif ratio; criterion says "content pictures" | FIX (exclude `image/svg+xml` and ≤1 KB images) |
| 22 | Low | Link header parsing | `split(",")` breaks on URLs containing commas (images/css/criticalpath) | FIX |
| 23 | Low | china.nogfwcritical | Misses GFW hosts via CSS `@import`/`url()` in head styles and via Link preload header | FIX |
| 24 | Low | cdn.alpn | 5 near-free points (ALPN always negotiated on modern TLS) — faithful to criterion as written | DOC |
| 25 | Low | js.defer | `async` counted as satisfying "use defer" — defensible but deviates from criterion wording | DOC (description states the accepted equivalents) |

## Details

### 1. Empty rawHtml is scored (collector/index.ts:499, sanity.ts)
The Node raw-HTML fetch failure path continues with `rawHtml=""`,
`mainResponseHeaders={}`. `assessCaptureHealth` doesn't catch it (no 4xx doc,
no title, `imgTagCount=0`). Every rawHtml/header-based control scores garbage;
`tp.deferasync` passes vacuously ("no third-party scripts"). The Node fetch is
exactly the vanilla-client shape Akamai blocks, so this happens on the sites
this tool targets. **Fix:** sanity gate rejects empty/near-empty rawHtml and
empty main response headers.

### 2. `private` + `max-age>0` (ttfbcache.ts:104)
`private` forbids shared caches only; the browser caches normally. The
criterion is "Browser cache for HTML pages (max-age>0)". `private, max-age=N`
is in fact the *correct* pattern for HTML. **Fix:** stop failing on `private`.

### 3. tp.limit provider counting (thirdparties.ts:26,209)
GTM + GA hostnames share the `analytics-tagmgr` category and are counted as
two providers; regional shards (`region1.google-analytics.com`) inflate
further. **Fix:** count providers by registrable domain and group Google's
analytics stack (GTM+GA) as a single provider.

### 4. fonts.max2 double-counting (fonts.ts:160-167)
Family names from @font-face ("Louis Vuitton Web") and URL stems
(`louisvuittonweb-regular`) are unioned; the same font counts twice whenever
both sources exist (the normal case). `fontStem` also strips only one trailing
token (`foo-bold-italic` → `foo-bold`). **Fix:** prefer @font-face families
when captured; fall back to stems only when no declarations exist; strip
repeated trailing weight/style tokens.

### 5. css.order fails inlined-CSS sites (css.ts:74)
No `<link rel=stylesheet>` → automatic fail, although fully-inlined critical
CSS is the strongest form of "CSS at top of head". **Fix:** pass when no
external stylesheet exists in `<head>` (evidence explains why), keep the order
check otherwise.

### 6. Slider topic scores the whole page (slider.ts, collector/index.ts:920)
`firstimgnojs` (30), `lazyloadrest` (20), `preloadnext` (10) pass from any
image on the page. The collector detects a slider element but discards its
markup. **Fix:** capture the detected slider container's `<img>`/`<source>`
markup into the evidence bundle (new optional `features.sliderHtml`, zod-
defaulted for old evidence) and scope the three controls to it; tighten the
detection gate (require multiple slide children, exclude `input[type=range]`
style matches).

### 7. cp.limitresources counts non-critical resources (criticalpath.ts:122)
Includes consent-triggered tag payloads and interaction-phase scripts.
**Fix:** exclude `phase === "interaction"` requests and third-party
scripts that were loaded async (approximation documented in the control
description); threshold unchanged.

### 8. Protocol gaps in probes (collector/index.ts:219,224)
(a) 103s are only observable over the HTTP/1.1 Node request; many CDNs send
103 only on H2/H3. **Fix:** add a best-effort `node:http2` probe that listens
for 1xx `headers` events and ORs into `earlyHints`. (b) The raw fetch never
sends `zstd` in `accept-encoding`, so `cdn.zstd`'s main-HTML branch can never
fire. **Fix:** advertise zstd when the running Node's `zlib` can decompress it
(feature-detect), otherwise leave as-is; the control keeps the browser-side
branch either way.

### 9. Preload URL matching (images.ts:106, video.ts:84, slider.ts:140)
`images.lcppreload` passes on any `<link rel=preload as=image
fetchpriority=high>`; the LCP URL is available at `perf.lcpElement.src`.
Same for the video poster and slider slides. **Fix:** when the target URL is
known, require the preload href to match it (loose match: same pathname or
same final URL segment, to tolerate CDN prefixes); fall back to the old
behavior with a "weak match" note when the target URL is unknown.

### 10–17, 19–23. See summary table; each fix keeps the control pure, updates
its `description` to match the new logic, and lands with per-control tests.

### 18. "Unmeasured ≠ failed" (DEFER)
Null CLS / null coverage / missing LCP element currently score 0 for the site,
conflating capture faults with site faults. The clean fix is a third control
outcome ("unmeasured", excluded from the topic max like N/A), which touches
`core/types`, the engine aggregation, persistence, and the UI. Recommended,
but it changes score semantics for every historical run — needs an explicit
decision before implementing.

### 15. Interaction-phase causality (DOC)
Anything fired during the 1.8 s synthetic-interaction window (auto-rotating
carousels, `setTimeout` beacons) is credited as event-based loading. A causal
design needs a second control capture with no events dispatched — doubling
capture time per page. Documented as a known heuristic in the four affected
control descriptions.

## What is notably right (unchanged)

Head-order charset-1024-byte rule; tldts-based first/third-party split;
external-CSS fetching for @font-face; 103 capture approach; phase-tagged
requests; slimmed evidence persistence; honest "inferred — cannot verify"
evidence on `cdn.region`/`china.cdnchinapop`.
