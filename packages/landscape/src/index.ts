import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Agent HQ scenes use this small shared foliage set. The source models live in
// the models package so the scene asset boundary stays explicit.
const assetRoot = "/assets/models/foliage";

export const foliageAssets = [
  {
    id: "deco-fern-large",
    label: "Deco Fern Large",
    assetUrl: `${assetRoot}/shrubs/deco-fern-large.glb`,
  },
  {
    id: "spider-plant-bush-large",
    label: "Spider Plant Bush Large",
    assetUrl: `${assetRoot}/shrubs/spider-plant-bush-large.glb`,
  },
  {
    id: "cherryblossom-potted-01",
    label: "Cherry Blossom Potted 01",
    assetUrl: `${assetRoot}/trees/cherryblossom-potted-01.glb`,
  },
  {
    id: "cherryblossom-potted-02",
    label: "Cherry Blossom Potted 02",
    assetUrl: `${assetRoot}/trees/cherryblossom-potted-02.glb`,
  },
  {
    id: "mansion-tree-2",
    label: "Mansion Tree 2",
    assetUrl: `${assetRoot}/trees/mansion-tree-2.glb`,
  },
] as const;

export const landscapeAssets = foliageAssets;

export type FoliageId = (typeof foliageAssets)[number]["id"];
export type LandscapeId = (typeof landscapeAssets)[number]["id"];
export type LandscapeManifest = (typeof landscapeAssets)[number];

export type LoadedLandscape = {
  id: LandscapeId;
  scene: THREE.Object3D;
};

/** Load one standalone foliage model without loading the rest of the catalog. */
export async function loadLandscape(loader: GLTFLoader, id: LandscapeId): Promise<LoadedLandscape> {
  const manifest = landscapeAssets.find((candidate) => candidate.id === id);
  if (!manifest) throw new Error(`No foliage asset is registered for ${id}`);
  const { scene } = await loader.loadAsync(manifest.assetUrl);
  return { id, scene };
}
