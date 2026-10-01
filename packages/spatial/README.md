# @adea-ai/spatial

Scene and asset manifest contracts plus the shell-to-engine spatial protocol
for Adea workspaces. Pure types, mount manifests, URL helpers, and telemetry
schema — no rendering, no binaries, no secrets.

Consolidates the former `@adea-ai/asset-manifests` and `@adea-ai/spatial-protocol`
packages, which always released together; both are deprecated in favor of this
package.

- `asset-manifests.ts` — typed scene data shapes: `SceneManifest`, `SceneZone`,
  `SceneStartPosition`, assigned-props manifests, static-field asset URLs.
- `manifests.ts` — `hqHomeManifest` / `hqWorkManifest` mount constants (mirrors
  the engine's room layout; the engine is source of truth).
- `engine.ts` — agent-sim engine manifest discovery and validation
  (`parseAgentSimEngineManifest`, official web hosts).
- `scene-spawn.ts` — cross-app spawn encode/parse and portal URL helpers.
- `telemetry.ts` — `ScenePerformanceReport` schema, validation, envelope, and
  navigation instrumentation.
- `data/` — tracked scene manifests (`home/`, `work/`), mirrored from the
  engine's `scenes/sim/assets/`; staged into the web public dir by
  `scripts/sync-assets.mjs`.
