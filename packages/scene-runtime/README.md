# Three.js runtime

Owns the renderer, camera, resize handling, render loop, disposal, capability
detection, physics integration, and scene-host contract. It stays scene-agnostic;
app-specific assets and UI belong in their owning packages.

`SceneHost` also emits bounded `agent-hq:scene-performance` reports for local
diagnostics and the optional same-origin telemetry endpoint. Add `?debug` to log
the reports while investigating startup or frame performance.
