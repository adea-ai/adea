# Characters package

This package owns the Agent HQ character runtime and assets: converted Cartoon
Characters models with embedded animation clips, the complete Cute Characters
library, categorized character parts and wearables, shared animation loading,
and the provider/controller interfaces used by the scene runtime.

The shipped Cartoon Characters 3 asset is the Humanoid rig. The source pack
contains 25 assembled character meshes, not individual wearable objects. Each
character is available separately under `_complete/`, with
the animated model at `runtime.glb`. The original `*-all.glb` libraries and
Standard variant are not shipped. The split exports exclude the two stray
`Cube` meshes present in the original Blender exports. Modular wearables are
organized directly under this assets directory and come from the separate Cute
Characters package.

Regenerate the checked-in Humanoid exports with the Blender conversion script.

Humanoid was selected because its body width is approximately 0.832, matching
the 0.828 width of the Cute character-part bodies. Its head is approximately
3-4% larger than the Cute body head. The Cute wearables still require rig
retargeting before they can animate with the Cartoon Humanoid skeleton.
