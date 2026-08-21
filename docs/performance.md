# Agent HQ Performance Ledger

This ledger records the local bundle measurements used for the frontend
optimization pass. It intentionally separates build-size evidence from runtime
claims that require a browser trace or production telemetry.

## Current budget

- Initial route JavaScript gzip: under 200 KB.
- Scene runtime: loaded only when the client workspace is ready; it is not part
  of the server-rendered shell path.
- Runtime frame rate, LCP, INP, and memory: require a browser trace and are not
  claimed from build output alone.

## Measurements

The baseline was measured before the optimization pass with the same local
production build command:

| Measure                                |     Baseline |     Current |
| -------------------------------------- | -----------: | ----------: |
| Initial route JavaScript, uncompressed | not isolated |   439,078 B |
| Initial route JavaScript, gzip         | not isolated |   127,904 B |
| Largest static JavaScript chunk        |    739,903 B |   672,905 B |
| All static JavaScript chunks           |  1,347,501 B | 1,369,868 B |

The total static bundle is slightly higher because nuqs is now part of the
application contract. The more relevant route-entry measure remains below the
budget because the Three.js scene is dynamically loaded and the UI imports a
lightweight character catalog rather than the runtime asset loaders.

## Runtime safeguards

- Scene state updates are throttled to at most 10 per second while movement is
  continuous, with lifecycle changes emitted immediately.
- Collision bounds are precomputed once instead of rebuilt during movement.
- Prop model loads share in-flight promises within a scene runtime.
- Character and room-layout loads use versioned staging so stale async work
  cannot overwrite the active scene graph.
- TanStack Query requests receive abort signals and use bounded stale and cache
  windows to avoid duplicate remote work.
