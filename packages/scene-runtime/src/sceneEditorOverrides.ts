import * as THREE from "three";

export type SceneEditorTransform = {
  p: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
};

export type SceneEditorOverride = {
  name?: string;
  deleted?: boolean;
  transform: SceneEditorTransform;
};

export type SceneEditorOverrides = {
  objects?: Record<string, SceneEditorOverride>;
};

function objectPath(root: THREE.Object3D, object: THREE.Object3D): string {
  const parts: string[] = [];
  let current: THREE.Object3D | null = object;
  while (current && current !== root) {
    parts.unshift(current.name || current.type);
    current = current.parent;
  }
  return parts.join(" / ");
}

function normalizedPath(path: string): string {
  return path
    .split(" / ")
    .map((part) => THREE.PropertyBinding.sanitizeNodeName(part))
    .join(" / ");
}

function pathsMatch(savedPath: string, currentPath: string): boolean {
  const saved = normalizedPath(savedPath);
  const current = normalizedPath(currentPath);
  return saved === current || current.endsWith(` / ${saved}`) || saved.endsWith(` / ${current}`);
}

export function applySceneEditorOverrides(
  root: THREE.Object3D,
  overrides: SceneEditorOverrides
): void {
  const entries = Object.entries(overrides.objects ?? {}).filter(
    ([savedPath]) => !savedPath.split(" / ").some((part) => part.startsWith("scene-editor-"))
  );
  root.traverse((object) => {
    const currentPath = objectPath(root, object);
    const pathMatch = entries.find(([savedPath]) => pathsMatch(savedPath, currentPath));
    const nameMatch = entries.find(
      ([, override]) =>
        override.name && normalizedPath(override.name) === normalizedPath(object.name)
    );
    const override = pathMatch?.[1] ?? nameMatch?.[1];
    if (!override) return;
    object.position.fromArray(override.transform.p);
    object.quaternion.fromArray(override.transform.q);
    object.scale.fromArray(override.transform.s);
    // A false deletion override restores the authored default visibility. Do
    // not force visibility for ordinary transform saves, which may belong to
    // a scene-controlled visibility group.
    if (override.deleted === true) object.visible = false;
    object.updateMatrix();
    object.updateMatrixWorld(true);
  });
}
