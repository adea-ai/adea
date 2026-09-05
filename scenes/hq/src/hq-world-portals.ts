import type { PortalLink } from "@agent-hq/scene-shell";
import { ROOM_GALLERY_BOUNDS, ROOM_GALLERY_RUNTIME_SCALE } from "@agent-hq/interior/room-config";

const GATE_Z = (ROOM_GALLERY_BOUNDS.zMax - 0.2) * ROOM_GALLERY_RUNTIME_SCALE;

/** The centered north gate is shared by the Home and Office HQ layouts. */
export const HQ_WORLD_GATE_TRIGGER = {
  x: 0,
  z: GATE_Z,
  radius: 0.9,
} as const;

/** Arrival just inside the HQ gate, on the central-room floor. */
export const HQ_HOME_GATE_SPAWN = {
  x: 0,
  y: 0.93,
  z: 2.55,
  yaw: 0,
  pitch: -0.12,
  snapToGround: true,
} as const;

export const HQ_OFFICE_GATE_SPAWN = HQ_HOME_GATE_SPAWN;

export function hqWorldPortals(sceneId: "hq-home" | "hq-work"): readonly PortalLink[] {
  const isHome = sceneId === "hq-home";
  return [
    {
      id: `${sceneId}-leave-gate`,
      trigger: HQ_WORLD_GATE_TRIGGER,
      yMin: 0.1,
      yMax: 3,
      navigation: {
        app: "world",
        path: isHome ? "/scenes/isla-azul" : "/scenes/little-tokyo",
        spawn: isHome
          ? {
              x: 43.65,
              y: 7.07,
              z: 63.66,
              yaw: 0,
              pitch: -0.1,
              snapToGround: true,
            }
          : {
              x: -10.44,
              y: 0.88,
              z: 18.07,
              yaw: 0,
              pitch: -0.2,
              snapToGround: false,
            },
      },
      activation: "interact",
      label: `leave ${isHome ? "Home" : "Office"}`,
    },
  ];
}
