# M12/#539 — packaged usage long-task proof

#539's second thread asks for "the full packaged UI long-task proof and
resource/cleanup soak with bounded history". The scale lane (`scripts/test-dev-runtime-scale.mjs`,
PR #554) measured the budgets on a developer runtime; this record covers the two
halves that were missing: the same pipeline **on the runtime the app ships**,
held under **sustained** load rather than a burst.

## The lane

`apps/desktop/shell/scripts/packaged-usage-long-task.ts`, run by the app's own
bundled Bun:

```sh
/Applications/Adea.app/Contents/MacOS/bun \
  apps/desktop/shell/scripts/packaged-usage-long-task.ts \
  --seconds 120 --artifact artifacts/packaged/usage-long-task.json --require-packaged
```

`--require-packaged` refuses to run under any other runtime, so the packaged
claim cannot be made from a developer's Bun by accident. The load is synthetic
by design — the sampler's `ps` transport is scripted exactly as the scale lane
scripts it — so no real process is spawned and the assertions are about the
pipeline, not this machine's process table.

## What it asserts

| Assertion                                                           | Result (40 pulls, app runtime) |
| ------------------------------------------------------------------- | ------------------------------ |
| Sampling discipline: one `ps` observation per pull                  | 41 = 40 + warm-up              |
| Bounded window: ≤ `SAMPLE_MAX_PIDS` per observation                 | 64 per call, never wider       |
| Rotation covers the inventory                                       | 1,000 of 1,000 PIDs observed   |
| Row projection p95 under the 16 ms UI-task analog                   | **0.80 ms**                    |
| Metric summary p95 under the same budget                            | **0.26 ms**                    |
| 1,000-row projection intact on the last pull                        | 1,000 rows                     |
| Metrics bounded: no owner above `MAX_POINTS_PER_OWNER`              | 2 observed against the 720 cap |
| Sustained load does not drift: last bucket's p95 within the ceiling | still within (see below)       |

An earlier 120-pull run taken while the 24-hour soak was running on the same
machine is retained for contrast: the **UI budgets held** (projection p95
1.12 ms, summary p95 0.15 ms — ~14× under budget) while the host `pull` p95 rose
to 114 ms and one bucket's p50 reached 53 ms. That is the honest division of
labour this lane documents: the projection and summary are the UI's work and
stay flat; the host handler's latency is host work and reflects what else the
machine is doing. The acceptance artifact is therefore taken on a machine that
is not running another lane.

## What this lane does not claim

It does not instrument the packaged window's renderer. Electrobun exposes no CDP
handle for the app's own CEF view (the same constraint `requireCdpLane` records
as a typed `capability_unavailable`), so a renderer-side long-task measurement
inside the packaged window is not available; the UI-task analog is measured
where the same reducer code runs, on the same runtime, as above.

## Bounded history and cleanup

The history caps are asserted where they bind: the scale lane drives the pull
path past `MAX_POINTS_PER_OWNER` (720) and a full `HISTORY_WINDOW_MS` (24 h) jump
so both prunes fire, and the 24-hour soak's own storage phase asserts the durable
store's caps (`capBytesPerSession`, `retainedSegments`, `newestDurableSequence`)
through the same registrar the app uses. Those artifacts live with their lanes
(`artifacts/dev-runtime/terminal-soak-summary.json`, `artifacts/dev-runtime/soak-summary.json`).
