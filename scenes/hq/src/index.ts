import type { SceneManifest } from "@agent-hq/asset-manifests";
import {
  ROOM_GALLERY_FOUNDATION_TOP_Y,
  ROOM_GALLERY_RECTANGLE_SCALE,
  ROOM_GALLERY_SLOTS,
  ROOM_GALLERY_SQUARE_SCALE,
  type RoomPlacement,
} from "@agent-hq/interior";

type HqScene = "home" | "work";

const sceneConfig = {
  home: { label: "Home", floorVersion: 20, foliageVersion: 10 },
  work: { label: "Work", floorVersion: 21, foliageVersion: 11 },
} as const satisfies Record<
  HqScene,
  { label: string; floorVersion: number; foliageVersion: number }
>;

function createHqManifest(scene: HqScene): SceneManifest {
  const { label, floorVersion, foliageVersion } = sceneConfig[scene];
  const sceneId = `hq-${scene}`;
  return {
    id: sceneId,
    label,
    availability: "ready",
    entryAssetUrl: `/assets/worlds/${sceneId}/floor.glb?v=${floorVersion}`,
    collisionAssetUrl: `/assets/worlds/${sceneId}/floor-collision.glb?v=${floorVersion}`,
    foliageManifestUrl: `/assets/worlds/${sceneId}/foliage.json?v=${foliageVersion}`,
    zones: [],
    startPosition: { x: 0, y: ROOM_GALLERY_FOUNDATION_TOP_Y + 135, z: 0, yaw: 0, pitch: -0.12 },
  };
}

export const hqHomeManifest = createHqManifest("home");
export const hqWorkManifest = createHqManifest("work");

const { topRectangleX, topRowZ, sideX, bottomRowZ, sideRowZ, bottomRectangleX, bottomCenterX } =
  ROOM_GALLERY_SLOTS;
const topFacing = [0, 0, 0, 1] as const;
const leftFacing = [0, -Math.SQRT1_2, 0, Math.SQRT1_2] as const;
const rightFacing = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const;
const bottomFacing = [0, 1, 0, 0] as const;

export const hqHomeRoomPlacements = [
  ["bedroom-modern", [-topRectangleX, 0, topRowZ], topFacing, ROOM_GALLERY_RECTANGLE_SCALE],
  ["bedroom-basic", [topRectangleX, 0, topRowZ], topFacing, ROOM_GALLERY_RECTANGLE_SCALE],
  ["basketball-court", [-sideX, 0, sideRowZ], leftFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["home-entrance", [-sideX, 0, -sideRowZ], leftFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["bedroom-cartoon", [sideX, 0, sideRowZ], rightFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["pool", [sideX, 0, -sideRowZ], rightFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["lounge", [-bottomRectangleX, 0, bottomRowZ], bottomFacing, ROOM_GALLERY_RECTANGLE_SCALE],
  ["home-theatre", [bottomCenterX, 0, bottomRowZ], bottomFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["dining", [bottomRectangleX, 0, bottomRowZ], bottomFacing, ROOM_GALLERY_RECTANGLE_SCALE],
] satisfies readonly RoomPlacement[];

export const hqWorkRoomPlacements = [
  ["office", [-topRectangleX, 0, topRowZ], topFacing, ROOM_GALLERY_RECTANGLE_SCALE],
  ["kitchen", [topRectangleX, 0, topRowZ], topFacing, ROOM_GALLERY_RECTANGLE_SCALE],
  ["living-room", [-sideX, 0, sideRowZ], leftFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["bedroom-basic", [-sideX, 0, -sideRowZ], leftFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["tv-room", [sideX, 0, sideRowZ], rightFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["pool", [sideX, 0, -sideRowZ], rightFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["lounge", [-bottomRectangleX, 0, bottomRowZ], bottomFacing, ROOM_GALLERY_RECTANGLE_SCALE],
  ["home-theatre", [bottomCenterX, 0, bottomRowZ], bottomFacing, ROOM_GALLERY_SQUARE_SCALE],
  ["dining", [bottomRectangleX, 0, bottomRowZ], bottomFacing, ROOM_GALLERY_RECTANGLE_SCALE],
] satisfies readonly RoomPlacement[];
