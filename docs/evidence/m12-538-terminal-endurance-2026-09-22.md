# M12 #538 terminal endurance + pane Playwright evidence — 2026-09-22

This record covers the two open #538 threads worked in the isolated checkout
`feat/m12-538-endurance` (wave 51). It is bounded, honest evidence for the
endurance/robustness and pane-coverage acceptance items; it does not close
#538 and does not claim the packaged 24-hour gate.

## What landed

- `scripts/dev-runtime-terminal-soak.mjs` — new real-sidecar terminal soak
  lane (real detached sidecar process, real unix socket, real Bun PTY):
  continuous producer floods, checkpoint churn, resize storms,
  attach/detach churn, deliberate no-ack slow-subscriber phases, bounded
  durable-bridge and ring replay probes, mid-stream SIGKILL → restart →
  durable replay verification, RSS/durable-bytes sampling, and a
  machine-readable summary at
  `artifacts/dev-runtime/terminal-soak-summary.json`.
- `scripts/test-dev-runtime-soak.mjs` — parameterized durations
  (`ADEA_DEV_RUNTIME_SOAK_DURATION_MS`, unit phase capped at a quarter of the
  budget) and the real-sidecar terminal phase wired in behind
  `ADEA_DEV_RUNTIME_SOAK_SKIP_TERMINAL=1` opt-out.
- `apps/web/e2e/dev-view-terminal-pane.spec.ts` +
  `apps/web/e2e/helpers/dev-terminal-pane-harness*.ts(x)` — Playwright
  coverage of the REAL `TerminalPane` (xterm, search addon, clipboard
  affordance, transport) mounted through the app's own Vite dev server via
  `/@fs/` so vite-plugin-solid compiles it exactly like application code.
- `packages/dev-view/src/terminal/terminal-pane.tsx` — two minimal fixes for
  Playwright-revealed defects (below); no other product file changed.

## Endurance methodology

One producer session (`/bin/sh -i` on a real PTY, prompt and echo disabled so
byte accounting is exact) receives per-round commands that emit 40,000
fixed-width records (`SOAKLINE%06d|0123456789abcdef|` → 34 bytes each after
PTY ONLCR, ≈1.36 MiB) plus a round sentinel. Every round is verified for:

- record count (`40,000`), no duplicate record indexes, no missing index —
  zero lost/duplicated/altered bytes at record granularity;
- byte volume inside a ±128-byte envelope of the expected flood (any sidecar
  byte insertion/duplication would break the envelope);
- live chunk-sequence continuity for the primary subscriber.

Interleaved, every N rounds: checkpoint churn (every 3), 20-cycle
attach/detach churn (every 5), 40-resize resize storms (every 7), ring-window
replay probes byte-compared against a 32 MiB rolling window of the live
stream (every 10), durable-bridge probes from ~6 MiB behind the live edge —
below the 4 MiB ring, so the replay crosses the durable-bridge boundary while
staying under the 8 MiB socket queue bound (every 40) — and a no-ack slow
subscriber driven past the 1 MiB per-subscriber high-water, requiring exactly
one `resync` notice and no re-notice after a clearing ack (every 25).

Samples every 15 s: sidecar RSS (`ps -o rss=`) and the session's durable byte
total (sealed segments). The durable cap asserted is the spec's
256 MiB/session plus 16 MiB in-flight slack; retention GC therefore churns
continuously once cumulative production passes the cap.

The crash phase seals everything (explicit `checkpoint`), captures the sealed
boundary, SIGKILLs the sidecar, boots a fresh sidecar on the same data dir,
adopts it, and verifies through the same checkpoint-sink module a shell-side
re-create opens: the chain from the sealed boundary is contiguous, byte-exact
against the live stream, search still matches pre-crash markers, and the
restarted service admits and streams a fresh terminal. Bytes still in the
open buffer at SIGKILL are the spec's crash window and are reported, never
hidden.

## Sustained run (≥ 2 hours, wall clock)

```text
ADEA_DEV_RUNTIME_TERMINAL_SOAK_ROUNDS=10000
ADEA_DEV_RUNTIME_TERMINAL_SOAK_FLOOD_LINES=80000        # ≈ 2.72 MiB per round
ADEA_DEV_RUNTIME_TERMINAL_SOAK_DURATION_MS=7500000      # 2 h 05 m budget
bun scripts/dev-runtime-terminal-soak.mjs
```

Result: **passed — 4,161 verified assertions, 0 failures** (summary:
`artifacts/dev-runtime/terminal-soak-summary.json`; the artifacts directory is
git-ignored by design, the retained JSON is the durable record).

| Measure               | Result                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wall clock            | 125.2 min (2 h 05 m; stopped by the duration budget at round 8,184 of 10,000)                                                                                                                                                                  |
| Throughput            | 22.39 GiB received across 533,609 chunks from the real PTY, every chunk sequence contiguous for the live subscriber                                                                                                                            |
| Zero lost bytes (E5)  | every one of the 8,184 × 80,000 producer records parsed exactly once with the exact payload; per-round unaccounted bytes ≤ 69 (envelope ±128)                                                                                                  |
| Memory bounds         | sidecar RSS min/median/max 25.8 / 154.8 / 183.0 MiB over 500 samples (fail-fast bound 1.5 GiB never approached); durable session bytes peaked at 256.1 MiB against the 256.0 MiB spec cap — retention GC churned continuously and held the cap |
| Replay/resync anchors | 1,024 replay probes (ring-window and durable-bridge, byte-compared against the live window) and 327 resync notices, all deterministic anchors, exactly one per gap                                                                             |
| Churn                 | 1,169 resize storms (46,760 resizes), 1,636 attach/detach churn phases (32,720 cycles), 327 slow-subscriber no-ack phases with exactly one resync notice each and no re-notice after ack                                                       |
| Crash phase           | sealed boundary → SIGKILL → fresh sidecar adopted → chain from the sealed boundary contiguous and byte-exact vs the live stream, search still matches pre-crash markers, fresh terminal streams through the restarted service                  |

## Accelerated verification runs (same lane, smaller budgets)

Before the sustained run, the same lane passed with: 2 rounds × 2,000 lines
(covers crash/restart plus full-history durable replay, 136,106 bytes
byte-exact after the crash), 26 rounds × 40,000 lines (341 s, 38 MiB), and
12/45-round configurations (198–278 s) covering all interleaved phases; a
96.8-minute run (10,000 × 40,000-line rounds, 14.69 GiB, 342,500 chunks,
5,085 verified assertions, RSS median 164 MiB / max 168 MiB, durable
256.1 MiB held) passed as well. The integrated driver
(`bun run test:soak:dev-runtime`) also passed, exercising the
terminal-channel unit rounds and the real-sidecar phase together.

## Playwright coverage (real terminal pane)

`bunx playwright test --config=playwright.config.ts
apps/web/e2e/dev-view-terminal-pane.spec.ts` — 6 tests:

1. attach: `data-attach-from`, truthful DOM fallback renderer
   (`data-renderer="dom"` under `--disable-webgl` — the pane's real
   webglInitFailed → DOM path), attach-time replay line rendered by xterm,
   authenticated shell-integration and cwd affordances;
2. output rendering: streamed data frames render through the real renderer
   (`xterm-rows` text);
3. input: compose-editor Enter produces a terminal `input` frame with the
   exact bytes (`echo $((40+2))\n`) and the echo renders;
4. search (the #396 search bar): Cmd/Ctrl+F opens, live count
   (`N of 3 matches`), Next/Previous enabled and exercised, close button and
   Escape both close;
5. selection + copy affordance: Copy disabled without a selection, enabled by
   a double-click selection, copy flows through the permissioned seam
   (`copyText`), button flips to `Copied`;
6. reconnect after a sidecar restart: socket close → transport
   reconnecting → open with a bumped generation, post-restart output renders,
   and post-restart input rides the new socket (`inputsByGeneration["2"]`).

Every test polices console/page errors (vite's blocked HMR websocket is
excluded by name — environmental, not a product surface).

Consecutive-run evidence: ten full-lane green runs in total, including six
consecutive after the final edits, all while the sustained soak loaded the
machine. The lane renders its own intercepted page and is a separate file, so
the conventional-workspace visual lane is untouched: that lane was run against
this branch and its only failures reproduce identically with this branch's
product changes stashed (headless/SwiftShader screenshot variance; the lane
is defined to run headed with hardware GL on darwin).

## Playwright-revealed product defects

Fixed minimally in this branch (fix + test in the same commit):

- The pane's `ResizeObserver` was never `.observe()`d, so `fit.fit()`/refit
  and `props.resize` could never fire. Fixed by observing the surface in
  `onMount`; the resize test pins it.
- The search `createEffect` re-ran `findNext` on every `search()` signal
  change, including its own results events: stepping was fought by the
  effect's re-find, and rapid stepping ended in
  `Maximum call stack size exceeded`. The effect now re-finds only when
  open/query/caseSensitive change.

Filed, still open:

- #593 — durable-bridge replay larger than the 8 MiB sidecar socket queue
  bound fails the connection; re-attach re-requests the same oversized bridge
  (non-converging loop). Found by the soak; bounded probes route around it.
- #594 — the live search count does not track the active match while
  decorations are enabled (ordinal stuck at the anchor).
- #595 — `terminal.onData` is never wired (typed keys never reach
  `props.write`; raw mode is local-echo only) and
  `@xterm/xterm/css/xterm.css` is never imported anywhere.

## What a full 24-hour packaged run would still add

- The packaged Bun runtime and bundled sidecar identity chain (this lane runs
  the source entry on the repo-pinned Bun), plus packaged supervision,
  update, display-loss (WebGL context loss at the packaged GPU layer), and
  daemon-version-mismatch recovery — all outside a source checkout.
- 24-hour-horizon effects this 2-hour bound cannot see: slow file-descriptor
  or handle accumulation across OS-level churn, disk pressure from the 2 GiB
  workspace budget interacting with OS caches, timezone/heartbeat edge
  effects, memory fragmentation beyond the RSS sampling resolution, and
  multi-day retention pruning cycles.
- Many-session scale (the soak exercises one long-lived producer plus bounded
  churn; a 24-hour multi-session soak would add dozens of concurrent
  sessions crossing the 2 GiB workspace budget).
- The visual/accessibility baseline review and input-to-paint p95 ≤ 16 ms
  measurement remain packaged-lane items per the M12 plan.

## Remaining gates

- #538's packaged 24-hour soak and packaged visual/accessibility evidence
  remain open (this lane is the bounded, honest precursor).
- `apps/desktop/tests/packaged-terminal-replay.test.ts` and the packaged
  smokes were not run here (they require the Electrobun bundle from
  `bun run test:packaged`; they skip loudly without it).
- The pre-existing failure of `apps/web/e2e/dev-view-terminal.spec.ts` in
  this environment is unrelated to this branch: `/api/workspaces/bootstrap`
  returns 500 because the checkout's `apps/web/.env.local` Neon credentials
  fail authentication (`password authentication failed for user
'neondb_owner'`); the fixture terminal never finishes bootstrapping. The
  same failure reproduces with this branch's product changes stashed, and CI
  provides its own database.
