"""Export the Cartoon Characters Blender packs as GLB assets.

Usage:
  blender -b --python scripts/convert-cartoon-characters.py -- SOURCE OUTPUT_DIR

  The complete pack export is retained alongside one playable export from the
  female character mesh. Blender's GLB exporter embeds the source textures;
no geometry simplification, texture resizing, or animation sampling is used.
"""

from pathlib import Path
import sys

import bpy


def arguments() -> tuple[Path, Path]:
    try:
        separator = sys.argv.index("--")
    except ValueError as error:
        raise SystemExit("Expected SOURCE and OUTPUT_DIR after --") from error
    values = sys.argv[separator + 1 :]
    if len(values) != 2:
        raise SystemExit("Usage: blender -b --python scripts/convert-cartoon-characters.py -- SOURCE OUTPUT_DIR")
    return Path(values[0]).resolve(), Path(values[1]).resolve()


def export_selected(
    path: Path,
    objects: list[bpy.types.Object],
    armature: bpy.types.Object,
    export_animations: bool,
) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_animations=export_animations,
        export_skins=True,
        export_morph=True,
        export_lights=False,
        export_cameras=False,
        export_materials="EXPORT",
    )


def main() -> None:
    source, output_dir = arguments()
    output_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=str(source))

    def enable_layer(layer: bpy.types.LayerCollection) -> None:
        layer.exclude = False
        layer.hide_viewport = False
        for child in layer.children:
            enable_layer(child)

    enable_layer(bpy.context.view_layer.layer_collection)

    armature = bpy.data.objects.get("rig")
    if armature is None or armature.type != "ARMATURE":
        armature = next((obj for obj in bpy.data.objects if obj.type == "ARMATURE"), None)
    if armature is None:
        raise SystemExit(f"No armature found in {source}")

    view_layer_objects = set(bpy.context.view_layer.objects)
    meshes = [
        obj
        for obj in bpy.data.objects
        if obj in view_layer_objects
        and obj.type == "MESH"
        and not obj.name.startswith(("WGT-", "WGTS"))
    ]
    variant = source.stem.removeprefix("Cartoon_Characters_3").strip("_").lower() or "standard"
    prefix = f"cartoon-3-{variant}"
    # Keep every visible mesh in the complete library export. Animation baking
    # is intentionally limited to the runtime representative below: the
    # full pack contains dozens of characters sharing one armature and baking
    # every action for that scene is needlessly expensive.
    export_selected(output_dir / f"{prefix}-all.glb", meshes, armature, False)

    # The complete pack contains many control-bone actions that do not belong
    # to a playable mesh and make Blender's animation baking extremely slow.
    # Keep the movement actions used by SceneHost for the runtime representative.
    keep_actions = {"A-pose", "Idle", "Run", "Song Jump", "Walk"}
    for action in list(bpy.data.actions):
        if action.name not in keep_actions:
            bpy.data.actions.remove(action)
    obj = next((candidate for candidate in meshes if candidate.name == "f_1"), None)
    if obj is None:
        raise SystemExit(f"Could not find f_1 runtime representative in {source}")
    export_selected(output_dir / f"{prefix}-runtime.glb", [obj], armature, True)


if __name__ == "__main__":
    main()
