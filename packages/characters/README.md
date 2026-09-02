# Characters package

This package owns the Agent HQ character runtime, the canonical configurable
44-bone character rig, its animation library, and its wearable catalog.

## Runtime character system

`configurable` is the only customizable runtime character. The 25 complete
characters in `_complete` are selectable examples. It selects one part per
body, ears, face, hair, clothing, accessory, or costume slot from `characters.glb`. The loader
recenters the authoring-board placements and shows only the parts selected by a
validated `CharacterConfiguration`. `runtime.glb` contains the canonical
Cute runtime character and its 29 animation clips. Walk, run, and swim clips keep their vertical gait motion but
remove horizontal root motion because physics owns locomotion.

The saved presets (`default`, `researcher`, and `builder`) are examples, not
separate rigs. New combinations can be created in the HQ account drawer. The
`_complete` GLBs are reference-only source character exports. They are loaded
only as menu examples, not as configurable wearable parts.

## Asset provenance and regeneration

The checked-in GLBs are browser runtime artifacts. Original BLEND/FBX files are
external authoring inputs and must not be referenced by runtime code or copied
into this package.

Export the canonical character runtime from an external source file with:

```sh
blender -b --python scripts/export-runtime.py -- \
  <authoring/source.blend> \
  /tmp/runtime.raw.glb
cp /tmp/runtime.raw.glb packages/characters/assets/runtime.glb
bun run assets:optimize:runtime
bun run assets:check
```

Prepare the full skinned character library and its placement metadata with:

```sh
bun scripts/prepare-character-library.mjs \
  --input <authoring/characters.glb> \
  --output packages/characters/assets/characters.prepared.glb \
  --parts-root packages/characters/assets \
  --offset-output packages/characters/src/generated-part-offsets.ts
mv packages/characters/assets/characters.prepared.glb packages/characters/assets/characters.glb
bun run assets:optimize:runtime
bun run assets:check
```

The preparation step keeps the 378 named wearable meshes, removes source-board
labels and unused test meshes, moves each board-placed mesh into local part
space, and stores its node translation. This keeps the source wearables aligned
while allowing Meshopt compression. Never commit machine-specific authoring
paths.
