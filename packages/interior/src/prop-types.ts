import type { Object3D } from "three";

/** Generic prop manifest types shared with the interior catalog. */
export type PropManifest = { id: string; label: string; assetUrl: string };
export type PropId = string;

export type InteriorPropCategory =
  | "food-and-drinks"
  | "bathroom"
  | "architecture"
  | "kitchen"
  | "plants"
  | "wall-decor"
  | "tables"
  | "seating"
  | "bedroom"
  | "storage"
  | "lighting"
  | "electronics"
  | "entertainment"
  | "recreation"
  | "rugs"
  | "retail"
  | "curtains"
  | "fitness"
  | "kids"
  | "wall-art"
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

export type LoadedProp = { id: PropId; scene: Object3D };
