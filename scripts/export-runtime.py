"""Export the canonical character runtime from an external BLEND input.

Usage:
  blender -b --python scripts/export-runtime.py -- \
    <characters.blend> <runtime.raw.glb>

The runtime contains the canonical armature, a generic visible character made
from the source body, ears, and face meshes, and all source actions. The modular
wearable library is kept separately.
Horizontal Root/Hips motion is held at
each clip's first keyed value so physics remains the sole owner of locomotion.
"""

from __future__ import annotations

import sys
from pathlib import Path

import bpy

KEEP_OBJECTS = {
    "Skeleton_01",
    "Test_body_01",
    "Test_Ears_01",
    "Test_Male_Emotion_Usual_01",
}
ROOT_MOTION_PATHS = {
    'pose.bones["Root"].location',
    'pose.bones["Hips"].location',
}


def arguments() -> tuple[Path, Path]:
    usage = (
        "Usage: blender -b --python scripts/export-runtime.py -- "
        "<characters.blend> <runtime.raw.glb>"
    )
    try:
        separator = sys.argv.index("--")
    except ValueError as error:
        raise SystemExit(usage) from error
    values = [Path(value).resolve() for value in sys.argv[separator + 1 :]]
    if len(values) != 2:
        raise SystemExit(usage)
    return values[0], values[1]


def normalize_root_motion() -> int:
    normalized = 0
    for action in bpy.data.actions:
        if not action.name.startswith(("Run_", "Walk_")):
            continue
        first_frame = action.frame_range[0]
        for fcurve in action.fcurves:
            if fcurve.data_path not in ROOT_MOTION_PATHS or fcurve.array_index not in (
                0,
                2,
            ):
                continue
            first_value = fcurve.evaluate(first_frame)
            for keyframe in fcurve.keyframe_points:
                keyframe.co[1] = first_value
                keyframe.handle_left[1] = first_value
                keyframe.handle_right[1] = first_value
            fcurve.update()
            normalized += 1
    return normalized


source, output = arguments()
bpy.ops.wm.open_mainfile(filepath=str(source))

missing = sorted(KEEP_OBJECTS - {object.name for object in bpy.context.scene.objects})
if missing:
    raise RuntimeError(
        f"Runtime source is missing required objects: {', '.join(missing)}"
    )

bpy.ops.object.select_all(action="DESELECT")
for object in bpy.context.scene.objects:
    object.select_set(object.name in KEEP_OBJECTS)

armature = bpy.data.objects["Skeleton_01"]
bpy.context.view_layer.objects.active = armature
normalized = normalize_root_motion()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(output),
    export_format="GLB",
    use_selection=True,
    export_animations=True,
    export_skins=True,
    export_yup=True,
    export_apply=True,
    export_animation_mode="ACTIONS",
)
print(
    f"Exported character runtime with {len(bpy.data.actions)} actions and "
    f"{normalized} normalized horizontal root tracks to {output}"
)
