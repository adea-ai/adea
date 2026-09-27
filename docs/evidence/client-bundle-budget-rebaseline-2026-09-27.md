# Client Bundle Budget Rebaseline (2026-09-27)

## Measurement context

This is a production Vite client build from the Adea worktree based on source
revision `ab7dc3d3`, including the app-shell root-font correction and package
pins described in the same change, using `@adea-ai/ui@0.72.3`. It records raw
minified bytes and the sum of each emitted JavaScript file compressed
independently with gzip. Route sizes are incremental over the statically
reachable workspace startup graph. The total counts every emitted JavaScript
file, including optional routes and panes.

The measurement commands were:

```sh
bun run --cwd apps/web build
bun run --cwd apps/web start:check-bundle
node scripts/check-dev-view-bundle.mjs
```

## Results and active limits

| Surface                           | Raw bytes | Gzip bytes | Files | Raw limit | Gzip limit |
| --------------------------------- | --------: | ---------: | ----: | --------: | ---------: |
| All emitted client JavaScript     | 2,111,780 |    621,605 |    75 | 2,350,000 |    716,800 |
| Workspace startup static graph    |   643,060 |    204,033 |    20 |   737,280 |    235,520 |
| Virtual view                      |    11,793 |      5,391 |     5 |    14,336 |      6,144 |
| Chat view                         |   155,219 |     44,738 |     9 |   180,224 |     57,344 |
| App Library                       |     4,769 |      2,075 |     2 |     6,144 |      3,072 |
| Dev View shell                    |   103,466 |     31,580 |     5 |   131,072 |     40,960 |
| Other lazy Dev utility panes      |   133,293 |     44,110 |    14 |   172,032 |     57,344 |
| Dev terminal route                |   694,364 |    168,009 |    10 |   786,432 |    196,608 |
| Dev code editor route             |   458,007 |    138,862 |    10 |   524,288 |    163,840 |
| Dev entry and central layout pair |   100,091 |     29,708 |     2 |   114,688 |     34,816 |

The bundle gate passed all limits. The startup graph contains the client
bootstrap, workspace mount, navigation entry, and their static imports. A route
measurement walks the route's static imports, then excludes files already
charged to startup. Dev terminal and editor measurements start from their route
entry and pane chunks, so they include static dependencies while remaining
lazy. The Dev utility-pane aggregate covers other lazy pane entries and their
static imports; it excludes startup and the separately budgeted terminal and
editor routes. Deeper interaction-specific chunks remain covered by the total
ceiling. The editor measurement explicitly includes its `editor-mirror` and
`file-stream` dynamic children; the terminal route includes its `terminal-pane`
child. The gate fails if these declared dynamic children change. Unrelated Dev
sibling panes are not charged to terminal or editor routes. This is emitted-
output accounting; it does not simulate HTTP cache reuse or combine chunks
into one gzip stream.

The active limits leave about 15% raw and 17% gzip headroom for the Dev
entry/layout pair, and about 11% raw and 15% gzip headroom for the full client,
with separate headroom for each route. They replace the former 1,623,000-byte
all-JavaScript cap, which rejected this 2,111,780-byte build even though its
initial workspace graph is 643,060 bytes and optional route code is loaded only
when opened.

The consumer manifests and `bun.lock` now pin `@adea-ai/ui@0.72.3`. Rerun these
commands and refresh this evidence if emitted sizes change before release; the
final validation must use the exact package version and source head intended for
release.
