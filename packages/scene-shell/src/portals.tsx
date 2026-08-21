"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SceneDebugApi } from "@agent-hq/scene-runtime";
import { portalNavigationHref, type PortalNavigation } from "./scene-spawn";

export type PortalLink = {
  /** Unique id for debugging. */
  id: string;
  /** Walk-in zone on the ground plane: the player teleports when their x/z
   * position enters the zone. Either `trigger` (circle: center + radius),
   * `area` (one rectangle), or `areas` (multiple rectangles making one zone,
   * such as a perimeter around a building). */
  trigger?: { x: number; z: number; radius: number };
  area?: { xMin: number; xMax: number; zMin: number; zMax: number };
  areas?: readonly { xMin: number; xMax: number; zMin: number; zMax: number }[];
  /** Optional player-center height range. Use this when vertically stacked
   * walkable surfaces share the same x/z footprint. */
  yMin?: number;
  yMax?: number;
  /** Where the player lands, snapped to the ground below. For a round-trip
   * pair this is the connected portal's own trigger center. */
  destination?: { x: number; z: number };
  /** Seed height for the ground probe so cross-level teleports land on the
   * intended floor (e.g. the house interior below the deck). */
  destinationY?: number;
  /** Keep destinationY exact instead of probing for a surface below it. */
  destinationSnapToGround?: boolean;
  /** Yaw (radians) to face the camera after landing so spawns never face a
   * wall. Forward = (sin(yaw), 0, cos(yaw)). */
  destinationYaw?: number;
  /** Yaw (radians) for the character model, independent of the camera. */
  destinationBodyYaw?: number;
  /** Scene zone to load before arriving at the destination. */
  zoneOnEnter?: string;
  /** Scene zone to unload before leaving this portal. */
  zoneOnLeave?: string;
  /** Walk-in portals fire on entry. Interactive portals wait for KeyE while
   * the player is inside the authored trigger. */
  activation?: "walk-in" | "interact";
  /** Navigate to a sibling World or HQ app instead of teleporting in-place. */
  navigation?: PortalNavigation;
  /** Prompt text shown while standing in the trigger. */
  label: string;
};

export type PortalsProps = {
  debugApiRef: React.MutableRefObject<SceneDebugApi | null>;
  links: readonly PortalLink[];
};

const HINT_DISTANCE_MULTIPLIER = 1.5;
const PORTAL_INTERACTION_KEY = "KeyE";
const TAP_MOVE_THRESHOLD_PX = 12;
// After firing a teleport, ignore every trigger briefly so the player landing
// inside a connected portal's own trigger never bounces straight back.
const ARRIVAL_SUPPRESS_MS = 1500;

function areaZones(
  link: PortalLink,
): readonly { xMin: number; xMax: number; zMin: number; zMax: number }[] {
  return link.areas ?? (link.area ? [link.area] : []);
}

function portalDistance(link: PortalLink, x: number, z: number): number {
  if (link.trigger) {
    return Math.hypot(link.trigger.x - x, link.trigger.z - z);
  }
  return areaZones(link).reduce((nearest, area) => {
    const dx = Math.max(area.xMin - x, 0, x - area.xMax);
    const dz = Math.max(area.zMin - z, 0, z - area.zMax);
    return Math.min(nearest, Math.hypot(dx, dz));
  }, Infinity);
}

function inZone(link: PortalLink, x: number, y: number, z: number): boolean {
  if (link.yMin != null && y < link.yMin) return false;
  if (link.yMax != null && y > link.yMax) return false;
  if (link.trigger) {
    return Math.hypot(link.trigger.x - x, link.trigger.z - z) <= link.trigger.radius;
  }
  const areas = areaZones(link);
  if (areas.length) {
    return areas.some(
      (area) => x >= area.xMin && x <= area.xMax && z >= area.zMin && z <= area.zMax,
    );
  }
  return false;
}

function nearZone(link: PortalLink, x: number, y: number, z: number): boolean {
  if (link.yMin != null && y < link.yMin) return false;
  if (link.yMax != null && y > link.yMax) return false;
  if (link.activation === "interact") return inZone(link, x, y, z);
  if (link.trigger) {
    return (
      Math.hypot(link.trigger.x - x, link.trigger.z - z) <=
      link.trigger.radius * HINT_DISTANCE_MULTIPLIER
    );
  }
  const areas = areaZones(link);
  if (areas.length) return true;
  return false;
}

/**
 * Same-scene portals: walking into a trigger zone teleports the player to a
 * destination (e.g. a road tunnel into the garage, a black wall into the
 * house interior). Teleports are edge-triggered: the player must leave a
 * zone before it can fire again, so arriving at a destination that is itself
 * another portal's trigger never bounces the player straight back.
 */
export function Portals({ debugApiRef, links }: PortalsProps) {
  const [near, setNear] = useState<PortalLink | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [api, setApi] = useState<SceneDebugApi | null>(null);
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const linksRef = useRef(links);
  const nearRef = useRef<PortalLink | null>(null);
  const insideRef = useRef(new Map<string, boolean>());
  const suppressUntilRef = useRef(0);
  const transitionRef = useRef(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 639px)");
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  const teleport = useCallback(
    async (link: PortalLink) => {
      if (!api || transitionRef.current) return;
      if (Date.now() < suppressUntilRef.current) return;
      transitionRef.current = true;
      suppressUntilRef.current = Date.now() + ARRIVAL_SUPPRESS_MS;
      setTransitioning(true);
      if (link.navigation) {
        window.location.assign(portalNavigationHref(link.navigation));
        return;
      }
      if (!link.destination) {
        console.error(`[Agent HQ] portal ${link.id} has no destination`);
        transitionRef.current = false;
        setTransitioning(false);
        return;
      }
      try {
        if (link.zoneOnEnter) await api.loadZone?.(link.zoneOnEnter);
        if (link.zoneOnLeave) await api.unloadZone?.(link.zoneOnLeave);
      } catch (cause) {
        console.error(`[Agent HQ] portal zone transition failed for ${link.id}`, cause);
        transitionRef.current = false;
        setTransitioning(false);
        return;
      }
      api.teleportTo?.(
        link.destination.x,
        link.destination.z,
        link.destinationY,
        link.destinationYaw,
        link.destinationBodyYaw,
        link.destinationSnapToGround,
      );
      transitionRef.current = false;
      setTransitioning(false);
    },
    [api],
  );

  useEffect(() => {
    linksRef.current = links;
  }, [links]);

  // SceneHost publishes its debug API asynchronously after the scene GLB
  // finishes loading, so poll for it before starting any scene work.
  useEffect(() => {
    let frame = 0;
    const waitForApi = () => {
      frame = requestAnimationFrame(waitForApi);
      const current = debugApiRef.current;
      if (current && current !== api) setApi(current);
    };
    frame = requestAnimationFrame(waitForApi);
    return () => cancelAnimationFrame(frame);
  }, [debugApiRef, api]);

  useEffect(() => {
    if (!api) return;
    let frame = 0;
    let tapStart: { pointerId: number; clientX: number; clientY: number } | null = null;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const state = api.getState() as { playerPosition?: number[] };
      const pos = state?.playerPosition;
      if (!pos || pos.length < 3) return;
      const playerX = pos[0];
      const playerY = pos[1];
      const playerZ = pos[2];

      let nearest: PortalLink | null = null;
      let nearestInside = false;
      let nearestDistance = Infinity;
      for (const link of linksRef.current) {
        const distance = portalDistance(link, playerX, playerZ);
        const inside = inZone(link, playerX, playerY, playerZ);
        const wasInside = insideRef.current.get(link.id) ?? false;
        insideRef.current.set(link.id, inside);
        if (link.activation !== "interact" && inside && !wasInside) {
          // Stepped into the zone: fire the teleport.
          void teleport(link);
          return;
        }
        // Hint: show the portal prompt while standing near (not only inside)
        // the zone so players know walking in teleports them.
        if (nearZone(link, playerX, playerY, playerZ)) {
          if (
            !nearest ||
            (inside && !nearestInside) ||
            (inside === nearestInside && distance < nearestDistance)
          ) {
            nearest = link;
            nearestInside = inside;
            nearestDistance = distance;
          }
        }
      }
      const nextId = nearest?.id ?? null;
      if (nextId !== (nearRef.current?.id ?? null)) {
        nearRef.current = nearest;
        setNear(nearest);
      }
    };
    frame = requestAnimationFrame(tick);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== PORTAL_INTERACTION_KEY || event.repeat) return;
      const link = nearRef.current;
      if (!link || link.activation !== "interact") return;
      void teleport(link);
    };
    const onCanvasPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === "mouse") return;
      tapStart = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    };
    const onCanvasPointerUp = (event: PointerEvent) => {
      if (!tapStart || tapStart.pointerId !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - tapStart.clientX, event.clientY - tapStart.clientY);
      tapStart = null;
      if (moved > TAP_MOVE_THRESHOLD_PX) return;
      const link = nearRef.current;
      if (!link || link.activation !== "interact" || transitionRef.current) return;
      const sceneEditor = new URLSearchParams(window.location.search).get("sceneEditor");
      if (sceneEditor != null && sceneEditor !== "0") return;
      event.preventDefault();
      void teleport(link);
    };
    const canvas = api.renderer.domElement;
    window.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("pointerdown", onCanvasPointerDown);
    canvas.addEventListener("pointerup", onCanvasPointerUp);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("pointerdown", onCanvasPointerDown);
      canvas.removeEventListener("pointerup", onCanvasPointerUp);
    };
  }, [api, teleport]);

  return (
    <>
      {transitioning && (
        <div
          className="pointer-events-auto fixed inset-0 z-[90] flex items-center justify-center bg-black/25"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/85 px-4 py-2 text-sm text-white shadow-xl backdrop-blur-sm">
            <span
              className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
              aria-hidden="true"
            />
            Loading…
          </div>
        </div>
      )}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-28 z-40 flex justify-center"
        aria-hidden={!near || transitioning}
      >
        {near && !transitioning ? (
          near.activation === "interact" ? (
            <button
              type="button"
              className="pointer-events-auto select-none rounded-full border border-white/15 bg-slate-950/75 px-4 py-2 text-sm text-white shadow-lg backdrop-blur-sm transition active:scale-95"
              onClick={() => void teleport(near)}
            >
              {isMobile === true ? (
                <>Tap to {near.label}</>
              ) : isMobile === false ? (
                <>
                  Press <kbd className="rounded bg-white/15 px-1.5 py-0.5 text-xs">E</kbd> or tap to{" "}
                  {near.label}
                </>
              ) : null}
            </button>
          ) : (
            <div className="rounded-full border border-white/15 bg-slate-950/75 px-4 py-2 text-sm text-white shadow-lg backdrop-blur-sm">
              {near.label}
            </div>
          )
        ) : null}
      </div>
    </>
  );
}
