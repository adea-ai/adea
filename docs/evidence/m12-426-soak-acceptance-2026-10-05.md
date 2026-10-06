# M12 acceptance soak — 24-hour terminal-sidecar endurance (2026-10-04/05)

Status: **passed** — the acceptance run for #426's "performance budgets and
24-hour soak" box, #396's soak row (remainder #538), #539's durable-store
half, and #541's budgets box.

## Run identity

- Command: `ADEA_DEV_RUNTIME_SOAK_DURATION_MS=86400000 bun run test:soak:dev-runtime`
- Main: `7acdb81a` (closure main; carries #997's stall-aware slow-subscriber
  sentinels, #1006's guest identity, and the dual-clock budget from #1037's
  predecessor state — this run predates the #1037 fix, see "clock divergence")
- Host: shared macOS arm64 dev machine with other agent sessions active
  during the run; the stall-aware waits from #997 make integrity verdicts
  load-independent (a busy host delays markers; silence still fails)
- Detachment: launched with a SIGTERM-ignoring exec wrapper so a session
  restart cannot kill it — the 2026-10-03 first attempt was SIGTERM'd at
  ~14h by exactly that, with zero failures in everything it had run

## Results (27h07m wall / 24.0h lane-monotonic — see clock divergence)

- **Integrity: 20,109 verified assertions, ZERO failures.** 39,587 rounds,
  58,145,302,153 bytes (58.1 GB) through a real detached sidecar + real Bun
  PTY, 1,256,911 frames, live sequence contiguous end to end.
- Slow-subscriber phases: 1,575 fired (one per 25 rounds); each produced
  exactly one resync notice for `soak-slow` and no latch re-notice after the
  clearing ack; both sentinels resolved on stream progress.
- Probes: 4,949 ring-window replay probes (byte-identical), 5,655 resize
  storms (40 resizes each), 7,917 attach/detach churn cycles (20 each),
  durable-head bridge probes byte-compared against the live window.
- Crash/restart: sidecar SIGKILL → restart → adoption → sealed-boundary
  replay byte-verified; post-crash search and post-restart stream ok.
- Resources bounded: RSS max 138.1 MiB; durable storage peaked at the
  256.0 MiB cap (256.1 observed, retention GC churning as designed).
- Budget: `durationBudgetMs` 86,382,408, `budgetHonored: true` (on the
  lane's monotonic clock), driver exit 0.
- Artifacts: `artifacts/dev-runtime/terminal-soak-summary-2026-10-04T19-01-37Z.json`
  (stamped reconstruction — see provenance note inside),
  `artifacts/dev-runtime/{soak,soak-terminal-phase}-summary.json`,
  `artifacts/dev-runtime/soak-console.log` (the run's full ok/fail stream).

## Clock divergence (the #1037 finding)

The artifact recorded `startedAt`→`finishedAt` of **27.07h wall** against
`elapsedMs` **24.0h monotonic** — the lane's `performance.now()` lagged wall
clock by ~3.12h (≈11.5%) over the run, so the monotonic-only budget break
silently overshot the wall-clock day. Integrity was green throughout the
overshoot. A 30-minute control canary bound correctly (30.37 min,
`budgetHonored: true`), isolating the effect to process lifetime. #1037
carries the fix: the budget now binds on whichever clock reaches it first,
both clocks and the divergence land in the artifact, and lane summaries gain
stamped copies so a later verification run cannot clobber an acceptance
record (the live summary was overwritten by post-run canaries before
archiving; the stamped reconstruction above is transcribed from the console
log and the close-out inspection).

## Companion evidence

- 30-minute canary (fresh process): 1,009 rounds, 1.48 GB, 517 assertions,
  0 failures, budget bound correctly.
- Performance lane (`test:performance:dev-runtime`) **first green run** on
  the settled host after fixing its never-green fixture: the 10k-hunk
  fixture derived each path from both loop indices — a bijection onto
  10,000 single-hunk files against which `groups.length === 100` could
  never pass. Fixed to 100 files × 100 hunks; the lane now reports listing
  page p95 0.5ms, cold 100k merge 65ms, 10k-line document 3.4ms, 10k-hunk
  split 2.1ms, RSS 148MB — all far under the 50ms long-task guards (#677's
  settled-machine clause).
- Guest-first identity on the real bundle (#1006/#1005): the installed
  stable app, booted with an isolated data dir and no sign-in, mints the
  device-local identity at
  `dev-runtime/identity/local.json` and composes the full Dev Runtime
  (project-session authority migrated) with zero cloud state;
  `desktop_identity_scope` serves the minted scope. The packaged terminal
  sidecar adoption on a _copied_ bundle timed out on both attempts (the
  bundled entry boots fine manually and publishes its endpoint) — recorded
  as its own follow-up rather than a silent gap.
