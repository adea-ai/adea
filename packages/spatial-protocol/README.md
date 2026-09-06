# @adea-ai/spatial-protocol

Shell↔engine contract for the spatial view. Pure types, mount manifests, URL
helpers, and telemetry schema — no rendering, no binaries, no secrets.

- `manifests.ts` — `hqHomeManifest` / `hqWorkManifest` mount constants (mirrors
  the engine's room layout; the engine is source of truth).
- `scene-spawn.ts` — cross-app spawn encode/parse and portal URL helpers.
- `telemetry.ts` — `ScenePerformanceReport` schema, validation, envelope, and
  navigation instrumentation.
- `data/` — tracked scene manifests (`home/`, `work/`), mirrored from the
  engine's `scenes/sim/assets/`; staged into the web public dir by
  `scripts/sync-assets.mjs`.
