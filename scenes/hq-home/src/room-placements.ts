import {
  ROOM_GALLERY_RECTANGLE_SCALE,
  ROOM_GALLERY_SLOTS,
  ROOM_GALLERY_SQUARE_SCALE,
  type RoomPlacement,
} from "@agent-hq/rooms";

const { topRectangleX, topRowZ, sideX, bottomRowZ, sideRowZ, bottomRectangleX, bottomCenterX } =
  ROOM_GALLERY_SLOTS;
const topFacing = [0, 0, 0, 1] as const;
const leftFacing = [0, -Math.SQRT1_2, 0, Math.SQRT1_2] as const;
const rightFacing = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const;
const bottomFacing = [0, 1, 0, 0] as const;

export const roomPlacements = [
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
