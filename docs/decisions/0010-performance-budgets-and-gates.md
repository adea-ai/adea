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

The M15 snapshot adopted these budgets. Its client bundle measurements remain
the historical baseline in the linked evidence; the active JavaScript limits
were subsequently replaced with the route-aware budgets below. The remaining
performance limits and their lanes are unchanged.

| Budget                                 | Value                                 | Enforced by                                 | Baseline (2026-09-23)   |
| -------------------------------------- | ------------------------------------- | ------------------------------------------- | ----------------------- |
| Client JS bytes                        | ≤ 1,600,000                           | `bun run --cwd apps/web start:check-bundle` | 1,597,600 (**99.85 %**) |
| Client JS files                        | ≤ 72                                  | same                                        | 68                      |
| Dev View lazy entry and renderer       | ≤ 86,016 B                            | `bun scripts/check-dev-view-bundle.mjs`     | 73,030                  |
| Local TTFB (p50, built Worker)         | ≤ 300 ms                              | `bun run test:performance:web`              | 3.3 ms                  |
| LCP (pinned Chromium, loopback)        | ≤ 4,000 ms                            | same                                        | 108 ms                  |
| CLS (same run)                         | ≤ 0.15                                | same                                        | 0                       |
| Worst scripted interaction (INP proxy) | ≤ 500 ms                              | same                                        | 24 ms                   |
| Build tree carries no non-deploy file  | except the plugin's local `.dev.vars` | same                                        | `server/.dev.vars` only |

The original M15 Dev View ratchet covered the lazy entry and its immediately
mounted central renderer together, summing split chunks against 86,016 bytes.
The active pair limit is now 112 KiB raw and 34 KiB gzip; the route-aware gate
also accounts for transitive dependencies and the terminal/editor panes below.

## Active client JavaScript budgets (2026-09-27)

The original aggregate limit conflated initial workspace startup with optional
views and panes. The current built client has 2,111,780 raw bytes across 75
files, while the startup graph is 643,060 bytes. The old 1,623,000-byte total
therefore rejected useful lazy code without protecting startup more precisely.
Keep an aggregate ceiling as a guard against total growth, and separately
measure the static startup graph and each lazy route. View sizes below are
incremental: they exclude chunks already charged to startup. Gzip is summed
from each emitted JavaScript file compressed independently.

| Surface                                                  |   Raw limit | Gzip limit |               Current measurement |
| -------------------------------------------------------- | ----------: | ---------: | --------------------------------: |
| All emitted client JavaScript                            | 2,350,000 B |    700 KiB | 2,111,780 B / 621,605 B; 75 files |
| Workspace startup static graph                           |     720 KiB |    230 KiB |   643,060 B / 204,033 B; 20 files |
| Virtual view incremental route                           |      14 KiB |      6 KiB |                11,793 B / 5,391 B |
| Chat view incremental route                              |     176 KiB |     56 KiB |              155,219 B / 44,738 B |
| App Library incremental route                            |       6 KiB |      3 KiB |                 4,769 B / 2,075 B |
| Dev View shell incremental route                         |     128 KiB |     40 KiB |              103,466 B / 31,580 B |
| Other lazy Dev utility panes, combined                   |     168 KiB |     56 KiB |    133,293 B / 44,110 B; 14 files |
| Dev terminal route, including its static dependencies    |     768 KiB |    192 KiB |             694,364 B / 168,009 B |
| Dev code editor route, including its static dependencies |     512 KiB |    160 KiB |             458,007 B / 138,862 B |
| Dev entry + central layout pair                          |     112 KiB |     34 KiB |              100,091 B / 29,708 B |

The total limits preserve about 11% raw and 15% gzip headroom relative to this baseline. Route limits leave 13–29% raw and 14–48% gzip headroom; the tightest margins are Dev terminal raw and Virtual view gzip.
The route caps leave room for small changes but require a named budget decision
when a surface grows past its own limit. Startup graph attribution follows
static imports from the client bootstrap, workspace mount, and navigation entry.
The view checks follow each route's static imports and exclude startup files.
The aggregate utility-pane budget covers the initial static graphs for Dev's
other lazy panes, excluding startup and the separately budgeted terminal/editor
routes. Their deeper interaction-specific chunks still consume the full-client
aggregate ceiling. The Dev editor route explicitly includes its
`editor-mirror` and `file-stream` children; the terminal route includes its
`terminal-pane` child. Attribution assertions fail when those lazy imports
change. `check-client.mjs` fails closed if expected route roots are missing or
if a route is pulled into the startup graph.

These measurements were taken from the production build of the Adea source at
the time of the rebaseline, now consuming `@adea-ai/ui@0.72.3`. See
[`docs/evidence/client-bundle-budget-rebaseline-2026-09-27.md`](../evidence/client-bundle-budget-rebaseline-2026-09-27.md)
for the build identity, attribution method, and exact output.

## Go/no-go gates

1. **Keep growth attributable.** New startup code consumes startup headroom;
   lazy features consume their owning route's headroom. A limit change needs a
   recorded reason, and aggregate limits remain in place to catch total growth.
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
- The earlier aggregate client limit left only 2,400 bytes of headroom at M15.
  The active route-aware limits preserve that historical record while giving
  startup and lazy features separate, measurable budgets.
- Desktop memory is recorded as idle RSS of the shell's process tree; the
  earlier engine comparison (356 MB with the full Agent Sim scene vs Electron
  1,052 MB) remains the reference for engine choices, and this ADR does not
  re-open it.
