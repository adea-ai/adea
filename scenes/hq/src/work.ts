import type { SceneManifest } from "@agent-hq/asset-manifests";
import { ROOM_GALLERY_FOUNDATION_TOP_Y } from "@agent-hq/interior";

export const hqWorkManifest: SceneManifest = {
  id: "hq-work",
  label: "Work",
  kind: "world",
  availability: "ready",
  entryAssetUrl: "/assets/worlds/hq-work/floor.glb?v=21",
  collisionAssetUrl: "/assets/worlds/hq-work/floor-collision.glb?v=21",
  foliageManifestUrl: "/assets/worlds/hq-work/foliage.json?v=11",
  // Keep the foundation isolated while its dimensions, openings, and wall
  // shell are being validated against the approved floor plan. Room packages
  // remain authored in work-room-placements.ts and can be reattached afterwards.
  zones: [],
  startPosition: { x: 0, y: ROOM_GALLERY_FOUNDATION_TOP_Y + 135, z: 0, yaw: 0, pitch: -0.12 },
};
