"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, X } from "lucide-react";
import { Button, MapSelector, cn, sceneMapOptions, type SceneMapOption } from "@agent-hq/ui";
import type { SceneDebugApi } from "@agent-hq/scene-runtime";

export type TeleportBoothsProps = {
  sceneId: string;
  debugApiRef: React.MutableRefObject<SceneDebugApi | null>;
  character: string;
  mapOptions?: readonly SceneMapOption[];
};

const BOOTH_INTERACTION_DISTANCE = 2;
const BOOTH_INTERACTION_KEY = "KeyE";
const TAP_MOVE_THRESHOLD_PX = 12;

type BoothSpot = {
  x: number;
  z: number;
  floorY: number;
  zoneId?: string;
  forward?: readonly [number, number];
  worldBounds?: readonly [readonly number[], readonly number[]];
};

const SAFE_SPAWN_OFFSETS = [
  [1.8, 0],
  [-1.8, 0],
  [0, 1.8],
  [0, -1.8],
  [2.6, 1.2],
  [2.6, -1.2],
  [-2.6, 1.2],
  [-2.6, -1.2],
  [1.2, 2.6],
  [-1.2, 2.6],
  [1.2, -2.6],
  [-1.2, -2.6],
  [3.6, 0],
  [-3.6, 0],
  [0, 3.6],
  [0, -3.6],
] as const;

function findSafeSpawn(
  api: SceneDebugApi,
  destination: BoothSpot,
  playerHeight: number,
  source?: BoothSpot,
): [number, number, number] | null {
  const directionX = source ? source.x - destination.x : 1;
  const directionZ = source ? source.z - destination.z : 0;
  const directionLength = Math.hypot(directionX, directionZ) || 1;
  const preferred = [
    (directionX / directionLength) * 1.8,
    (directionZ / directionLength) * 1.8,
  ] as const;
  const orientedOffsets = (() => {
    const forward = destination.forward;
    if (!forward) return [] as const;
    const [forwardX, forwardZ] = forward;
    const rightX = forwardZ;
    const rightZ = -forwardX;
    return [
      [forwardX * 1.8, forwardZ * 1.8],
      [-forwardX * 1.8, -forwardZ * 1.8],
      [forwardX * 2.6 + rightX * 1.2, forwardZ * 2.6 + rightZ * 1.2],
      [forwardX * 2.6 - rightX * 1.2, forwardZ * 2.6 - rightZ * 1.2],
      [forwardX * 3.6, forwardZ * 3.6],
      [-forwardX * 3.6, -forwardZ * 3.6],
    ] as const;
  })();
  const offsets = [...orientedOffsets, preferred, ...SAFE_SPAWN_OFFSETS];
  for (const [offsetX, offsetZ] of offsets) {
    const x = destination.x + offsetX;
    const z = destination.z + offsetZ;
    const floorY = api.groundYAt(x, z, destination.floorY) ?? destination.floorY;
    const y = floorY + playerHeight / 2 + 0.08;
    if (api.isSpawnSafe(x, y, z)) return [x, y, z];
  }
  return null;
}

function scanBooths(api: SceneDebugApi): BoothSpot[] {
  const findMesh = api.findMesh as (pattern: string) => Array<{
    worldBounds?: [number[], number[]];
    zoneId?: string;
    worldQuaternion?: number[];
  }>;
  const booths: Array<BoothSpot | null> = [
    ...(findMesh("phone[-_ ]?booth") ?? []),
    ...(findMesh("Warp_Station|phone-booth") ?? []),
  ]
    .map((mesh) => {
      const bounds = mesh.worldBounds;
      if (!bounds || !bounds[0] || !bounds[1]) return null;
      const quaternion = mesh.worldQuaternion;
      const forward =
        quaternion && quaternion.length >= 4
          ? ([
              2 * (quaternion[0] * quaternion[2] + quaternion[3] * quaternion[1]),
              1 - 2 * (quaternion[0] * quaternion[0] + quaternion[1] * quaternion[1]),
            ] as const)
          : undefined;
      const forwardLength = forward ? Math.hypot(forward[0], forward[1]) : 0;
      const normalizedForward =
        forward && forwardLength > 0.1
          ? ([forward[0] / forwardLength, forward[1] / forwardLength] as const)
          : undefined;
      return {
        x: (bounds[0][0] + bounds[1][0]) / 2,
        z: (bounds[0][2] + bounds[1][2]) / 2,
        floorY:
          api.groundYAt(
            (bounds[0][0] + bounds[1][0]) / 2,
            (bounds[0][2] + bounds[1][2]) / 2,
            bounds[0][1],
          ) ?? bounds[0][1],
        zoneId: mesh.zoneId,
        forward: normalizedForward,
        worldBounds: [bounds[0], bounds[1]],
      } satisfies BoothSpot;
    })
    .filter((spot) => spot !== null);
  const validBooths = booths.filter((spot): spot is BoothSpot => spot !== null);
  return validBooths.filter(
    (spot, index) =>
      validBooths.findIndex(
        (candidate) =>
          candidate.zoneId === spot.zoneId &&
          Math.hypot(candidate.x - spot.x, candidate.z - spot.z) < 1,
      ) === index,
  );
}

/**
 * Telephone-booth fast travel between maps. The scene's existing phone booth
 * meshes (e.g. phone_booth, phone_booth002) are detected at runtime and act
 * as travel points: while the player stands near one an "open the booth"
 * prompt appears; interacting opens a travel menu listing every map with its
 * card image (the same MapSelector the settings drawer uses).
 */
export function TeleportBooths({
  sceneId,
  debugApiRef,
  character,
  mapOptions = sceneMapOptions,
}: TeleportBoothsProps) {
  const [spots, setSpots] = useState<readonly BoothSpot[]>([]);
  const [nearSpot, setNearSpot] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [traveling, setTraveling] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const spotsRef = useRef<readonly BoothSpot[]>([]);
  const nearSpotRef = useRef<number | null>(null);
  const openRef = useRef(false);
  const travelingRef = useRef(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 639px)");
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    spotsRef.current = spots;
  }, [spots]);
  useEffect(() => {
    nearSpotRef.current = nearSpot;
  }, [nearSpot]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    travelingRef.current = traveling;
  }, [traveling]);

  // SceneHost publishes its debug API asynchronously (after the scene GLB
  // finishes loading), so poll for it before starting any scene work.
  const [api, setApi] = useState<SceneDebugApi | null>(null);
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

  // Locate the scene's existing phone booth meshes and use their footprints
  // as travel points. Re-runs only when the API appears, so booths that are
  // part of the main scene are picked up as soon as it loads. If the authored
  // spawn is far from every booth, the player is re-spawned next to the
  // nearest one so the travel point is easy to find.
  useEffect(() => {
    if (!api) return;
    let positionedAtArrival = false;
    let interval: number | null = null;
    const scan = () => {
      const uniqueBooths = scanBooths(api);
      setSpots(uniqueBooths);

      if (positionedAtArrival) return;
      // Cross-app portals provide an authored arrival position. Keep that
      // position intact instead of applying the legacy convenience behavior
      // that moves distant starts beside the nearest phone booth.
      if (new URLSearchParams(window.location.search).has("spawn")) {
        positionedAtArrival = true;
        return;
      }
      const state = api.getState() as { playerPosition?: number[] };
      const pos = state?.playerPosition;
      if (!uniqueBooths.length || !pos) return;
      if (interval !== null) window.clearInterval(interval);
      let nearest = uniqueBooths[0];
      let bestDistance = Infinity;
      for (const spot of uniqueBooths) {
        const distance = Math.hypot(spot.x - pos[0], spot.z - pos[2]);
        if (distance < bestDistance) {
          bestDistance = distance;
          nearest = spot;
        }
      }
      positionedAtArrival = true;
      const playerHeight = (state as { playerHeight?: number }).playerHeight ?? 1.35;
      const spawn = findSafeSpawn(api, nearest, playerHeight, {
        x: pos[0],
        z: pos[2],
        floorY: nearest.floorY,
      });
      if (spawn) api.teleportTo?.(spawn[0], spawn[2], spawn[1], undefined, undefined, false);
    };
    scan();
    interval = window.setInterval(scan, 500);
    return () => {
      if (interval !== null) window.clearInterval(interval);
    };
  }, [api]);

  // Carry the selected character through the teleport so the destination
  // scene spawns the same degen instead of defaulting back to the ape. The
  // character is a prop (known during SSR) so card hrefs never mismatch.
  const hrefFor = useCallback(
    (option: { href: string }) =>
      character
        ? `${option.href}${option.href.includes("?") ? "&" : "?"}character=${encodeURIComponent(character)}`
        : option.href,
    [character],
  );

  // Spin the character (the hoverboard-dismount animation) then navigate.
  const handleNavigate = useCallback(
    (option: { href: string }) => {
      if (travelingRef.current) return;
      const duration = api?.playTeleportSpin?.() ?? 0.6;
      setOpen(false);
      setTraveling(true);
      window.setTimeout(
        () => {
          window.location.href = hrefFor(option);
        },
        (duration + 0.5) * 1000,
      );
    },
    [api, hrefFor],
  );

  const handleSelfTravel = useCallback(
    (spotIndex: number) => {
      const currentSpots = spotsRef.current;
      const destination = currentSpots.find((_, index) => index !== spotIndex) ?? currentSpots[0];
      if (!destination || travelingRef.current) return;
      const duration = api?.playTeleportSpin?.() ?? 0.6;
      setOpen(false);
      setTraveling(true);
      void (async () => {
        if (!api) return;
        const current = currentSpots[spotIndex];
        const state = api.getState() as { playerHeight?: number };
        const playerHeight = state.playerHeight ?? 1.35;
        if (sceneId === "exchange" && current?.zoneId) {
          const targetZone =
            current.zoneId === "exchange-inside" ? "exchange-outside" : "exchange-inside";
          await api.loadZone?.(targetZone);
          const target = scanBooths(api).find((spot) => spot.zoneId === targetZone);
          if (target) {
            const spawn = findSafeSpawn(api, target, playerHeight, current);
            if (spawn) {
              api.teleportTo(spawn[0], spawn[2], spawn[1], undefined, undefined, false);
              await api.unloadZone?.(current.zoneId);
            }
          }
        } else {
          const spawn = findSafeSpawn(api, destination, playerHeight, current);
          if (spawn) api.teleportTo(spawn[0], spawn[2], spawn[1], undefined, undefined, false);
        }
        window.setTimeout(() => setTraveling(false), duration * 1000);
      })();
    },
    [api, sceneId],
  );

  // Proximity + interaction key.
  useEffect(() => {
    if (!api) return;
    let frame = 0;
    let tapStart: { pointerId: number; clientX: number; clientY: number } | null = null;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const state = api.getState() as { playerPosition?: number[] };
      const pos = state?.playerPosition;
      if (!pos || pos.length < 2) return;
      const currentSpots = spotsRef.current;
      let nearest = -1;
      let nearestDistance = BOOTH_INTERACTION_DISTANCE;
      for (let i = 0; i < currentSpots.length; i += 1) {
        const dx = currentSpots[i].x - pos[0];
        const dz = currentSpots[i].z - pos[2];
        const distance = Math.hypot(dx, dz);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = i;
        }
      }
      nearSpotRef.current = nearest;
      setNearSpot(nearest);
    };
    frame = requestAnimationFrame(tick);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== BOOTH_INTERACTION_KEY) return;
      if (travelingRef.current) return;
      if (openRef.current) {
        setOpen(false);
        return;
      }
      if ((nearSpotRef.current ?? -1) >= 0) setOpen(true);
    };
    const onCanvasPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === "mouse") return;
      tapStart = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    };
    const onCanvasPointerUp = (event: PointerEvent) => {
      if (!tapStart || tapStart.pointerId !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - tapStart.clientX, event.clientY - tapStart.clientY);
      tapStart = null;
      if (moved > TAP_MOVE_THRESHOLD_PX || travelingRef.current || openRef.current) return;
      const sceneEditor = new URLSearchParams(window.location.search).get("sceneEditor");
      if (sceneEditor != null && sceneEditor !== "0") return;
      const spotIndex = nearSpotRef.current ?? -1;
      const spot = spotsRef.current[spotIndex];
      if (!spot?.worldBounds) return;
      const hit = api.pick(event.clientX, event.clientY);
      if (!hit) return;
      const point = hit.point.toArray();
      const [[minX, minY, minZ], [maxX, maxY, maxZ]] = spot.worldBounds;
      if (
        point[0] < minX - 0.75 ||
        point[0] > maxX + 0.75 ||
        point[1] < minY - 0.75 ||
        point[1] > maxY + 0.75 ||
        point[2] < minZ - 0.75 ||
        point[2] > maxZ + 0.75
      )
        return;
      event.preventDefault();
      setOpen(true);
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
  }, [api]);

  // Close the menu when the player walks away from the booth.
  useEffect(() => {
    if (!open || (nearSpot ?? -1) >= 0) return;
    const timeout = window.setTimeout(() => setOpen(false), 250);
    return () => window.clearTimeout(timeout);
  }, [open, nearSpot]);

  const near = (nearSpot ?? -1) >= 0;

  return (
    <>
      <div
        className={cn(
          "pointer-events-none fixed inset-x-0 bottom-28 z-40 flex justify-center transition-opacity duration-200",
          near && !open && !traveling ? "opacity-100" : "opacity-0",
        )}
        aria-hidden={!near || open || traveling}
      >
        <button
          type="button"
          className="pointer-events-auto flex select-none items-center gap-2 rounded-full border border-white/15 bg-slate-950/75 px-4 py-2 text-sm text-white shadow-lg backdrop-blur-sm transition active:scale-95"
          onClick={() => {
            if (!traveling) setOpen(true);
          }}
        >
          <Phone className="size-4" aria-hidden="true" />
          {isMobile === true ? (
            <>Tap to open the phone booth</>
          ) : isMobile === false ? (
            <>
              Press <kbd className="rounded bg-white/15 px-1.5 py-0.5 text-xs">E</kbd> or tap to
              open the phone booth
            </>
          ) : null}
        </button>
      </div>

      <div
        className={cn(
          "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 transition-opacity duration-200",
          open || traveling ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-hidden={!open && !traveling}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={traveling ? "Traveling" : "Travel destination"}
          className="flex max-h-[min(44rem,92vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="text-base font-semibold">Phone booth</h2>
              <p className="text-sm text-muted-foreground">
                {traveling ? "Beaming you out…" : "Where do you want to travel?"}
              </p>
            </div>
            {!traveling && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close travel menu"
                onClick={() => setOpen(false)}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <MapSelector
              options={mapOptions}
              currentId={sceneId}
              hrefFor={hrefFor}
              onNavigate={(option) => {
                if (option.id === sceneId) {
                  handleSelfTravel(nearSpot ?? 0);
                } else {
                  handleNavigate(option);
                }
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}
