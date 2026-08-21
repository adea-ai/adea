import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Generic prop manifest types shared with the models room catalog. */
export type PropManifest = { id: string; label: string; assetUrl: string };
export type PropId = string;

export const propAssets: readonly PropManifest[] = [];

export type InteriorPropCategory =
  | "drinks"
  | "food"
  | "plants"
  | "wall-decor"
  | "tables"
  | "seating"
  | "bedroom"
  | "storage"
  | "lighting"
  | "electronics"
  | "casino"
  | "other";

export type InteriorPropConfig = {
  category: InteriorPropCategory;
  defaultScale: number;
  footprint: readonly [number, number];
  placementSurface?: "floor" | "wall";
  wallMountHeight?: number;
  footprintShape?: "rectangle" | "circle";
  floorLift?: number;
  allowItemsOnTop?: boolean;
  canOverlapFurniture?: boolean;
  blocksRugOverlap?: boolean;
  surfaceHeight?: number;
  placeableOnTop?: boolean;
  frontYaw: number;
};

export type InteriorPropAsset = PropManifest & InteriorPropConfig;
export const interiorPropAssets: readonly InteriorPropAsset[] = [];

export type LoadedProp = { id: PropId; scene: THREE.Object3D };

export async function loadProp(loader: GLTFLoader, id: PropId): Promise<LoadedProp> {
  const manifest = propAssets.find((candidate) => candidate.id === id);
  if (!manifest) throw new Error(`No optional prop asset is registered for ${id}`);
  const { scene } = await loader.loadAsync(manifest.assetUrl);
  return { id, scene };
}
