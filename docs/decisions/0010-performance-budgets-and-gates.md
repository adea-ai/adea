# Performance Budgets and Go/No-Go Gates

- Status: Accepted (2026-09-23).
- Date: 2026-09-23
- Tracks: #301 (this decision, milestone M15). Measurements and their raw
  artifact are recorded in
  [`docs/evidence/m15-301-perf-baseline-2026-09-23.md`](../evidence/m15-301-perf-baseline-2026-09-23.md).
- Scope: budgets and go/no-go gates for the web app on Cloudflare Workers and
  for the desktop shell artifacts, taken **before** further stack migrations.
  The Dev Runtime budgets (chat/dev graph purity, terminal input-to-paint,
  1,000-row virtualization) stay in
  [`docs/specs/dev-runtime.md`](../specs/dev-runtime.md); this page covers the
  web/desktop surface those budgets do not.

## Context

M15 asks for clean-main baselines and decision gates. The comparison points it
records come from the retired Next.js/OpenNext host and the retired Tauri shell:
18.55 s cold build, 0.07 s warm build, 109 ms local TTFB, 519 KB desktop main
chunk. Three of those four are not comparable today by construction:

- the 0.07 s point was an **incremental** rebuild; the current Vite build has no
  incremental cache, so a rebuild is a full rebuild (≈7 s) and that is the unit
  of cost CI pays;
- the desktop "main chunk" measured a web bundle a Tauri webview loaded; the
  Electrobun shell ships a payload archive (373 MB unpacked .app, 177.9 MB dmg)
  and its own process tree (383 MB RSS idle), so artifact size and idle RSS are
  the comparable numbers;
- TTFB is now served by a Worker built by Vite, measured on loopback.

## Decision

Adopt these budgets. Each is enforced by a named lane; the lane is the
authority and this table records the number it enforces.

| Budget                                 | Value                                 | Enforced by                                 | Baseline (2026-09-23)   |
| -------------------------------------- | ------------------------------------- | ------------------------------------------- | ----------------------- |
| Client JS bytes                        | ≤ 1,600,000                           | `bun run --cwd apps/web start:check-bundle` | 1,597,600 (**99.85 %**) |
| Client JS files                        | ≤ 72                                  | same                                        | 68                      |
| Dev View lazy chunk                    | ≤ 86,016 B                            | `bun scripts/check-dev-view-bundle.mjs`     | 73,030                  |
| Local TTFB (p50, built Worker)         | ≤ 300 ms                              | `bun run test:performance:web`              | 3.3 ms                  |
| LCP (pinned Chromium, loopback)        | ≤ 4,000 ms                            | same                                        | 108 ms                  |
| CLS (same run)                         | ≤ 0.15                                | same                                        | 0                       |
| Worst scripted interaction (INP proxy) | ≤ 500 ms                              | same                                        | 24 ms                   |
| Build tree carries no non-deploy file  | except the plugin's local `.dev.vars` | same                                        | `server/.dev.vars` only |

## Go/no-go gates

1. **Client JS is at the wall.** At 99.85 % of its byte budget, any further
   client-JS addition is a _decision_, not a change: raise the budget with a
   recorded reason, or split/remove code. No silent growth.
2. **A full rebuild is the cost unit.** Because no incremental cache exists,
   build-time regressions are measured against cold/rebuild, never against a
   cache-hit figure. A lane that reports a sub-second "build" is measuring a
   cache hit, not a build.
3. **Lab numbers are not field numbers.** LCP/CLS/interaction here are
   loopback, unthrottled, cold-cache, single-run lab measurements. A gate that
   needs to hold for users needs field data (RUM) or a throttled profile; that
   is recorded as a gap, not assumed.
4. **Deploy artifacts exclude caches and local secrets.** `dist` carries the
   Vite dep cache and the Cloudflare Vite plugin's local `.dev.vars` copy;
   neither counts toward deploy bytes, and the hygiene gate fails if any other
   non-deploy file appears in the tree.

## Consequences

- Further migrations must present their own before/after against these numbers,
  not against the retired host's.
- The web budgets are tighter than they look: 2,400 bytes of client JS headroom
  is roughly one small module, so the next feature that lands in the eager
  shell needs a budget decision in the same change.
- Desktop memory is recorded as idle RSS of the shell's process tree; the
  earlier engine comparison (356 MB with the full Agent Sim scene vs Electron
  1,052 MB) remains the reference for engine choices, and this ADR does not
  re-open it.
