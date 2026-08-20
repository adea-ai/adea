import type { SceneManifest } from "@agent-hq/asset-manifests";
import { ROOM_GALLERY_FOUNDATION_TOP_Y } from "@agent-hq/rooms";
import roomsLayout from "../assets/rooms.json";

export const hqHomeManifest: SceneManifest = {
  id: "hq-home",
  label: "Home",
  kind: "world",
  availability: "ready",
  entryAssetUrl: "/assets/worlds/hq-home/floor.glb?v=26",
  collisionAssetUrl: "/assets/worlds/hq-home/floor-collision.glb?v=25",
  foliageManifestUrl: "/assets/worlds/hq-home/foliage.json?v=10",
  // Keep the foundation isolated while its dimensions, openings, and wall
  // shell are being validated against the approved floor plan. Room packages
  // remain authored in room-placements.ts and can be reattached afterwards.
  zones: [],
  startPosition: { x: 0, y: ROOM_GALLERY_FOUNDATION_TOP_Y + 135, z: 0, yaw: 0, pitch: -0.12 },
};

export { roomsLayout };
