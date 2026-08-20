import {
  ROOM_GALLERY_PLACEABLE_SLOTS,
  type RoomLayoutDocument,
  type RoomPlacement,
} from "@agent-hq/rooms";
import layout from "../assets/rooms.json";

const roomLayout: RoomLayoutDocument = layout;
export const roomPlacements = ROOM_GALLERY_PLACEABLE_SLOTS.flatMap((slot) => {
  const roomId = roomLayout.placements[slot.id];
  return roomId ? [[roomId, [slot.x, 0, slot.z], slot.quaternion, slot.scale] as const] : [];
}) satisfies readonly RoomPlacement[];
