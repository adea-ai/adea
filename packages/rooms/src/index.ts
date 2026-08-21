import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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
  ROOM_GALLERY_WALL_SEGMENTS,
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
  ["office", "Office", 1],
  ["bedroom-modern", "Bedroom Modern", 1],
  ["basketball-court", "Basketball Court", 1],
  ["bedroom-cartoon", "Bedroom Cartoon", 1],
  ["home-entrance", "Home Entrance", 1],
  ["gaming-room", "Gaming Room", 5],
  ["home-theatre", "Home Theatre", 1],
  ["living-room", "Living Room", 1],
  ["pool", "Pool", 6],
  ["bedroom-basic", "Bedroom Basic", 1],
  ["dining", "Dining", 1],
  ["kitchen", "Kitchen", 1],
  ["lounge", "Lounge", 1],
  ["tv-room", "TV Room", 1],
] as const satisfies readonly (readonly [string, string, number])[];

export const roomAssets = roomDefinitions.map(([id, label, version]) => ({
  id,
  label,
  kind: "room" as const,
  assetUrl: `${roomsAssetRoot}/${id}/visual.glb?v=${version}`,
})) as readonly {
  id: string;
  label: string;
  kind: "room";
  assetUrl: string;
}[];

export type RoomId = (typeof roomAssets)[number]["id"];

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
