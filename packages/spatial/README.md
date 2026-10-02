# @adea-ai/spatial

Scene and asset manifest contracts plus the shell-to-engine spatial protocol
for Adea workspaces. It provides types, mount manifests, URL helpers, and
telemetry validation without a rendering engine, binaries, or secrets.

Consolidates the former `@adea-ai/asset-manifests` and `@adea-ai/spatial-protocol`
packages, which always released together; both are deprecated in favor of this
package.

- `asset-manifests.ts`: typed scene data shapes: `SceneManifest`, `SceneZone`,
  `SceneStartPosition`, assigned-props manifests, static-field asset URLs.
- `manifests.ts`: `hqHomeManifest` / `hqWorkManifest` mount constants (mirrors
  the engine's room layout; the engine is source of truth).
- `engine.ts`: agent-sim engine manifest discovery and validation
  (`parseAgentSimEngineManifest`, official web hosts).
- `scene-spawn.ts`: cross-app spawn encode/parse and portal URL helpers.
- `telemetry.ts`: `ScenePerformanceReport` schema, validation, envelope, and
  navigation instrumentation.
- `data/`: tracked scene manifests (`home/`, `work/`), mirrored from the
  engine's `scenes/sim/assets/`; staged into the web public dir by
  `scripts/sync-assets.mjs`.

The engine manifest validator requires a nonempty version and a same-origin
JavaScript entry URL. Its version is diagnostic; it does not enforce API or
version-range compatibility or verify entry bytes. Tracked scene data is a
public mirror, not proof that every file matches a particular private source
revision or distributed pack. Manifest and payload acceptance need separate
checks against the intended pack.
