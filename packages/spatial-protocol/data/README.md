# Scene manifest data

Tracked placement manifests for the HQ home/work scenes. These files mirror
`agent-sim`'s `scenes/hq/assets/{home,work}/` — the engine is the source of
truth; changes land here via the cutover sync and must be re-mirrored when
the engine edits them.

`scripts/sync-assets.mjs` stages these into `apps/web/public/assets/worlds/`
so the shell (and the future entitlement-gated engine remote) resolves
same-origin manifest URLs from the protocol's `hqHomeManifest` /
`hqWorkManifest`. Runtime models, textures, and audio are never staged here.
