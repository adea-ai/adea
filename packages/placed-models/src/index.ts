import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type PlacedModelPlacement = {
  p: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
};

export type PlacedModelsManifest = {
  version: number;
  scene: string;
  placements: Record<string, PlacedModelPlacement[]>;
};

export function composePlacedModelMatrix(
  placement: PlacedModelPlacement,
  sourceMatrix: THREE.Matrix4,
  target = new THREE.Matrix4(),
): THREE.Matrix4 {
  target.compose(
    new THREE.Vector3(...placement.p),
    new THREE.Quaternion(...placement.q),
    new THREE.Vector3(...placement.s),
  );
  return target.multiply(sourceMatrix);
}

/** Build one InstancedMesh per catalog model from a placement manifest.
 *
 * Each placement records the world transform relative to the model's
 * recentered frame (base at y = 0), so rendering every placement of a model
 * as one `InstancedMesh` reproduces the authored scene with a single draw
 * call per model instead of one per placement.
 *
 * The catalog models are resolved through `resolveModelUrl` and loaded once
 * (shared across scenes via the browser cache); the returned group can be
 * added to a scene and disposed with the scene's other geometry.
 */
export async function loadPlacedField(
  loader: GLTFLoader,
  manifestUrl: string,
  resolveModelUrl: (modelId: string) => string,
  groupName = "placed-field",
  singlePlacementPlain = false,
): Promise<THREE.Group> {
  const response = await fetch(manifestUrl);
  if (!response.ok)
    throw new Error(`Failed to load placed-models manifest: ${manifestUrl} (${response.status})`);
  const manifest = (await response.json()) as PlacedModelsManifest;

  const group = new THREE.Group();
  group.name = groupName;
  const matrix = new THREE.Matrix4();

  const placementEntries = Object.entries(manifest.placements).filter(
    (entry): entry is [string, PlacedModelPlacement[]] => entry[1]?.length > 0,
  );
  // Catalog assets are independent. Start every request together so a field
  // with dozens of distinct props/buildings is bounded by its slowest model,
  // rather than the sum of every network and parse delay.
  const loadedModels = await Promise.all(
    placementEntries.map(async ([modelId, placements]) => ({
      modelId,
      placements,
      model: (await loader.loadAsync(resolveModelUrl(modelId))).scene,
    })),
  );

  for (const { modelId, placements, model } of loadedModels) {
    model.updateMatrixWorld(true);
    // A model may carry several primitives (e.g. a grass patch on a cliff
    // face, or a palm trunk + fronds). Instance each primitive so every
    // placement renders the full model. A single placement is added as a
    // plain mesh (on-demand load, no instancing overhead) — buildings are
    // mostly unique, so instancing is reserved for genuinely repeated blocks.
    const sourceMeshes = collectMeshes(model);
    if (sourceMeshes.length === 0) continue;
    for (const sourceMesh of sourceMeshes) {
      // Placements are already in world space. Preserve the mesh's authored
      // local node transform without reapplying the GLTF scene-root matrix.
      const sourceMatrix = sourceMesh.matrix.clone();
      if (singlePlacementPlain && placements.length === 1) {
        const placed = new THREE.Mesh(sourceMesh.geometry, sourceMesh.material);
        placed.name = modelId;
        const placement = placements[0];
        composePlacedModelMatrix(placement, sourceMatrix, matrix);
        placed.applyMatrix4(matrix);
        placed.matrixAutoUpdate = false;
        group.add(placed);
        continue;
      }
      const instanced = new THREE.InstancedMesh(
        sourceMesh.geometry,
        sourceMesh.material,
        placements.length,
      );
      instanced.name = modelId;
      for (let i = 0; i < placements.length; i += 1) {
        const placement = placements[i];
        composePlacedModelMatrix(placement, sourceMatrix, matrix);
        instanced.setMatrixAt(i, matrix);
      }
      instanced.computeBoundingSphere();
      group.add(instanced);
    }
  }
  return group;
}

export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  return meshes;
}

export type PlacedModelAsset = {
  id: string;
  assetUrl: string;
};

/** Build one InstancedMesh per catalog model from a placement manifest.
 *
 * Catalog-bound variant of `loadPlacedField`: ids are resolved through a
 * catalog of `{id, assetUrl}` assets instead of a resolve callback. A model
 * with a single placement is added as a plain mesh (on-demand load, no
 * instancing overhead); models with several placements render as one
 * `InstancedMesh` per primitive.
 */
export async function loadPlacedFieldFromCatalog(
  loader: GLTFLoader,
  manifestUrl: string,
  catalog: readonly PlacedModelAsset[],
  groupName = "placed-field",
): Promise<THREE.Group> {
  const assetsById = new Map(catalog.map((asset) => [asset.id, asset.assetUrl]));
  return loadPlacedField(
    loader,
    manifestUrl,
    (modelId) => {
      const assetUrl = assetsById.get(modelId);
      if (!assetUrl) throw new Error(`No catalog asset is registered for ${modelId}`);
      return assetUrl;
    },
    groupName,
    true,
  );
}
