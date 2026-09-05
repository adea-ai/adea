import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { backgroundAssets, fenceAssets, foliageAssets, landscapeAssets } from "./catalog.js";
export { backgroundAssets, fenceAssets, foliageAssets, landscapeAssets } from "./catalog.js";
export { landscapeHorizonBackgrounds } from "./backgrounds.js";

export type FoliageId = (typeof foliageAssets)[number]["id"];
export type FenceId = (typeof fenceAssets)[number]["id"];
export type LandscapeId = (typeof landscapeAssets)[number]["id"];
export type LandscapeManifest = (typeof landscapeAssets)[number];
export type BackgroundId = (typeof backgroundAssets)[number]["id"];
export type BackgroundManifest = (typeof backgroundAssets)[number];

export type LoadedLandscape = {
  id: LandscapeId;
  scene: THREE.Object3D;
};

/** Load one standalone landscape model without loading the rest of the catalog. */
export async function loadLandscape(loader: GLTFLoader, id: LandscapeId): Promise<LoadedLandscape> {
  const manifest = landscapeAssets.find((candidate) => candidate.id === id);
  if (!manifest) throw new Error(`No landscape asset is registered for ${id}`);
  const { scene } = await loader.loadAsync(manifest.assetUrl);
  return { id, scene };
}
