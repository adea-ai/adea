import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { RoomFootprintCategory } from "./gallery-config";
export {
  ROOM_GALLERY_AUTHORED_UNIT_SCALE,
  ROOM_GALLERY_BOUNDS,
  ROOM_GALLERY_BUILDING_BOUNDS,
  ROOM_GALLERY_FOUNDATION_PIECES,
  ROOM_GALLERY_ENVIRONMENT_SCALE,
  ROOM_GALLERY_DOORWAYS,
  ROOM_GALLERY_DOORWAY_CLEARANCE_DEPTH,
  ROOM_GALLERY_DOORWAY_WIDTH,
  ROOM_GALLERY_OUTSIDE_DOORWAY_WIDTH,
  ROOM_GALLERY_HUB,
  ROOM_GALLERY_HORIZONTAL_SCALE,
  ROOM_GALLERY_CENTRAL_ROOM_SIZE,
  ROOM_GALLERY_EXTERIOR_WALL_THICKNESS,
  ROOM_GALLERY_FOUNDATION_SLAB_BASE_Y,
  ROOM_GALLERY_FOUNDATION_SLAB_HEIGHT,
  ROOM_GALLERY_FOUNDATION_TOP_Y,
  ROOM_GALLERY_MAIN_ENTRY_WALL_SHIFT,
  ROOM_GALLERY_PATHWAY_SIDE_WALL_EXTENSION,
  ROOM_GALLERY_INTERIOR_WALL_THICKNESS,
  ROOM_GALLERY_MERGED_ROOM_SIZE,
  ROOM_GALLERY_RECTANGLE_SCALE,
  ROOM_GALLERY_RUNTIME_SCALE,
  ROOM_GALLERY_SQUARE_SCALE,
  ROOM_GALLERY_SQUARE_SIZE,
  ROOM_GALLERY_SLOTS,
  ROOM_GALLERY_PLACEABLE_SLOTS,
  ROOM_GALLERY_WALL_SEGMENTS,
  ROOM_GALLERY_WALL_HEIGHT,
  ROOM_WALL_COLORS,
  ROOM_WALL_COLOR_DEFAULT,
  type RoomFootprintCategory,
  type RoomGalleryPlaceableSlot,
  type RoomGallerySlotKind,
  type RoomPlacement,
  type RoomGalleryDoorway,
  type RoomGalleryWallSegment,
} from "./gallery-config";

export const roomsAssetRoot = "/assets/rooms/models";

/** Horizontal dimensions shared by every normalized room model. */
export const ROOM_FOOTPRINT = { width: 10, length: 10 } as const;
/** Center-to-center spacing leaves a one-meter service gap between rooms. */
export const ROOM_CELL_SPACING = 11;

const roomDefinitions = [
  ["office", "Office", 6, "6x3"],
  ["bedroom-modern", "Bedroom Modern", 6, "6x3"],
  ["basketball-court", "Basketball Court", 6, "3x3"],
  ["bedroom-cartoon", "Bedroom Cartoon", 6, "3x3"],
  ["home-entrance", "Home Entrance", 6, "3x3"],
  ["gaming-room", "Gaming Room", 10, "3x3"],
  ["home-theatre", "Home Theatre", 6, "3x3"],
  ["living-room", "Living Room", 6, "3x3"],
  ["pool", "Pool", 11, "3x3"],
  ["bedroom-basic", "Bedroom Basic", 6, "6x3"],
  ["dining", "Dining", 6, "6x3"],
  ["kitchen", "Kitchen", 6, "6x3"],
  ["lounge", "Lounge", 6, "6x3"],
  ["tv-room", "TV Room", 6, "3x3"],
] as const satisfies readonly (readonly [string, string, number, RoomFootprintCategory])[];

export const roomTemplates = roomDefinitions.map(([id, label, version, category]) => ({
  id,
  label,
  category,
  visualUrl: `${roomsAssetRoot}/${id}/visual.glb?v=${version}`,
  collisionUrl: `${roomsAssetRoot}/${id}/collision.glb?v=${version}`,
})) as readonly {
  id: string;
  label: string;
  category: RoomFootprintCategory;
  visualUrl: string;
  collisionUrl: string;
}[];

export type RoomId = (typeof roomTemplates)[number]["id"];

export type RoomLayoutDocument = {
  version: number;
  scene: string;
  placements: Partial<Record<string, RoomId>>;
};

export const roomAssets = roomTemplates.map(({ id, label, visualUrl }) => ({
  id,
  label,
  kind: "room" as const,
  assetUrl: visualUrl,
})) as readonly {
  id: string;
  label: string;
  kind: "room";
  assetUrl: string;
}[];

export type RoomModelKind = "room";

export type RoomModelManifest = {
  id: string;
  label: string;
  kind: RoomModelKind;
  assetUrl: string;
};

export type LoadedRoomModel = {
  manifest: RoomModelManifest;
  scene: THREE.Object3D;
};

export function roomModelUrl(kind: RoomModelKind, modelId: string): string {
  return `${roomsAssetRoot}/${modelId}/visual.glb`;
}

export async function loadRoomModel(
  loader: GLTFLoader,
  manifest: RoomModelManifest,
): Promise<LoadedRoomModel> {
  const { scene } = await loader.loadAsync(manifest.assetUrl);
  return { manifest, scene };
}

export type LoadedRoom = {
  id: RoomId;
  scene: THREE.Object3D;
};

export async function loadRoom(loader: GLTFLoader, id: RoomId): Promise<LoadedRoom> {
  const manifest = roomAssets.find((candidate) => candidate.id === id);
  if (!manifest) throw new Error(`No room is registered for ${id}`);
  const { scene } = await loader.loadAsync(manifest.assetUrl);
  return { id, scene };
}
