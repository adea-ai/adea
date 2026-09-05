import * as THREE from "three";

export interface DisposedObjectResources {
  geometries: number;
  materials: number;
  textures: number;
}

/** Dispose each GPU resource owned by an object tree exactly once. */
export function disposeObjectResources(root: THREE.Object3D): DisposedObjectResources {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
  return { geometries: geometries.size, materials: materials.size, textures: textures.size };
}
