import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Optional building catalog; the HQ scenes use their authored foundations. */
export const buildingAssets = [] as const;
export type BuildingId = never;
export type BuildingManifest = (typeof buildingAssets)[number];

export function isBuildingId(_value: string | undefined): _value is BuildingId {
  return false;
}

export type LoadedBuilding = { id: BuildingId; scene: THREE.Object3D };

export async function loadBuilding(_loader: GLTFLoader, _id: BuildingId): Promise<LoadedBuilding> {
  throw new Error("No optional building assets are configured for this application.");
}
