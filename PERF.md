# Performance ledger

Measurements before optimization work, and the disposition of every attempt
(kept and reverted alike). Baselines recorded 2026-09-13 on the reference
macOS ARM64 machine unless noted. Re-measure the same way before claiming a
regression or a win.

## Baselines (2026-09-13)

| Surface | Metric | Baseline | Budget / target |
| --- | --- | --- | --- |
| Desktop warm boot (launcher → loopback server answering) | wall clock | 1.1s (3-run median) | < 5s |
| Desktop static serving (loopback) | GET `/` | 0.86ms, 3.9KB | — |
| Client bundle (desktop SPA) | total JS+CSS | 1.1MB, largest chunk 321KB, entry 77KB gzipped, CSS 22KB gzipped | < 200KB gzipped initial JS |
| Web lane TTFB (adea.dev, Cloudflare) | `time_starttransfer` | 140–170ms | < 200ms p95 |
| Same-origin API proxy overhead | OPTIONS preflight via shell vs direct | none measurable (122ms vs 135ms, network-dominated) | — |
| Hashed static asset caching | headers | (not taken — see ledger) | immutable |
| **Update download** | bytes per release | **117MB** (CEF re-shipped) | minimized |
| **Post-update expansion** | launcher reinstall | **2–4 min** dead launcher | eliminated |

## Ledger

| Idea | Baseline → Result | Verdict | Why |
| --- | --- | --- | --- |
| Slim update archives (app layer only, CEF-hash gated) | 117MB → ~1MB download; 2–4min expansion → none (overlay, no launcher reinstall) | **kept** (#perf/base-optimizations) | The only measured red: update cost dominated every other surface by 3 orders of magnitude. |
| Boot bind-retry (30 × 1s) in the shell | fixed a real post-update relaunch death (EADDRINUSE-style uncaught throw) | **kept** (#401) | Correctness gate for the update path; not a micro-optimization. |
| Cache headers on loopback static assets | not taken | skipped | Serving is already <1ms on loopback; CEF's cache behavior is unmeasurable behind that. No measurable win to keep. |
| `injectBridge` result caching per mtime | not taken | skipped | HTML is 3.9KB and served in <1ms; below noise by construction. |
| Streaming static files instead of `arrayBuffer()` | not taken | skipped | Largest non-update file is <500KB on loopback (<1ms); no user-visible delta possible. |
| Delta/patched updates (binary diff vs full CEF) | not taken | deferred | Slim archives already cut ~99% of transfer; diff tooling adds infra for marginal additional gain. Revisit only if CEF starts changing per release. |

## Rules

- New perf claims need a same-method before/after measurement (this skill's
  workflow: measure → identify → fix → verify → guard).
- `Neutral is a revert`: if a change doesn't beat the baseline beyond noise,
  it does not land.
- The update pipeline's budget: an incremental release should download the
  app layer only (single-digit MB) and apply without a launcher reinstall.
