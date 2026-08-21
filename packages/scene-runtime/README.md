# Three.js runtime package

## Migration plan

Keep renderer, camera, resize, render-loop, disposal, capability detection, and common
scene-host contracts here. This package must stay world-agnostic and must not import
Party Cove, Isla Azul, or any mini-game assets.

Future work should add WebGL/WebGPU selection only behind a stable runtime interface and
measure startup and frame costs before introducing engine-wide abstractions.

## Scene performance telemetry

`SceneHost` emits two versioned `agent-hq:scene-performance` browser events per
mount: a load report after the first rendered frame and a runtime report after
five seconds. Reports include navigation-to-frame/playable milestones,
visual/field/physics timings, transferred and cache-served asset bytes, FPS and
game-loop work percentiles, callback-cadence FPS, long tasks, renderer
resource/draw statistics, and the detected device/GPU tier.

The latest 30 reports are available at `window.__AGENT_HQ_SCENE_PERF__` for local
diagnostics. Add `?debug` to log JSON reports. Production builds default to the
same-origin `/api/telemetry/scene-performance` endpoint, which validates
bounded reports and writes privacy-minimal `[scene-telemetry]` structured log
envelopes. Set `NEXT_PUBLIC_SCENE_TELEMETRY_ENDPOINT` to override that
destination. Delivery uses `sendBeacon` with a keepalive fetch fallback.

Export the structured logs as NDJSON and generate an SLO table with:

```sh
bun run telemetry:summary logs.ndjson --json artifacts/scene-slo.json --markdown artifacts/scene-slo.md
```

The default configuration waits for 100 load and runtime samples in each
release/scene/device-tier group before reporting pass or breach. Consumers can
also subscribe without a vendor dependency:

```ts
window.addEventListener("agent-hq:scene-performance", (event) => {
  const report = (event as CustomEvent).detail;
  // Forward to the project's analytics provider.
});
```
