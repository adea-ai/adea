import * as THREE from "three";

export const DEBUG_COMPONENT_PROXY = "__agentHqDebugComponentProxy";

export type DebugComponentProxyMetadata = {
  source?: THREE.Mesh;
  component?: number;
};

/** Editor-created helpers are rendered in the same scene as authored objects. */
export function isSceneEditorObject(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.name.startsWith("scene-editor-")) return true;
    current = current.parent;
  }
  return false;
}

/** Resolve a debug-only component proxy to the stable authored object. */
export function resolveDebugSourceObject(object: THREE.Object3D): THREE.Object3D {
  const metadata = object.userData[DEBUG_COMPONENT_PROXY] as
    DebugComponentProxyMetadata | undefined;
  return metadata?.source ?? object;
}
