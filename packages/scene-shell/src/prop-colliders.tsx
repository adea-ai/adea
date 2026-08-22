"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { SceneDebugApi } from "@agent-hq/scene-runtime";
import type { RoomDesignerAsset } from "./room-designer";
import { loadRoomDesignerDocument } from "./room-designer-document";

export type PropCollidersProps = {
  debugApiRef: MutableRefObject<SceneDebugApi | null>;
  /** Scene identifier — used to build the props.json fetch URL. */
  sceneId: string;
  /** Catalog entries with footprint + defaultScale data. */
  catalog: readonly RoomDesignerAsset[];
  /** Runtime scale applied to the visual scene group. */
  sceneScale: number;
  /** Authored ground Y (floor surface) in HQ units. */
  groundY: number;
  /** Current camera view mode — drives collider strategy. */
  cameraViewMode: "perspective" | "orthographic";
  /** Increments when the scene is recreated (character switch, etc.). */
  sceneVersion?: number;
  /** Increments when the room designer saves a new layout. */
  propsVersion?: number;
};

/** Fixed collision height for top-down box colliders (100cm in authored units). */
const TOP_DOWN_COLLIDER_HEIGHT = 100;
/** Skip colliders for items smaller than this footprint dimension (cm). */
const MIN_FOOTPRINT_FOR_COLLIDER = 20;

type PlacedProp = {
  id: string;
  modelId: string;
  footprint: [number, number];
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
};

function yawFromQuaternion(q: readonly [number, number, number, number]): number {
  const [, y, , w] = q;
  return Math.atan2(2 * w * y, 1 - 2 * y * y);
}

function rotatedFootprintSize(
  footprint: readonly [number, number],
  q: readonly [number, number, number, number],
): [number, number] {
  const yaw = yawFromQuaternion(q);
  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  return [footprint[0] * cos + footprint[1] * sin, footprint[0] * sin + footprint[1] * cos];
}

/** Load and normalize placements from the scene's props.json. */
async function loadPlacements(
  sceneId: string,
  catalogById: ReadonlyMap<string, RoomDesignerAsset>,
  groundY: number,
): Promise<PlacedProp[]> {
  const document = await loadRoomDesignerDocument(sceneId);
  const entries = Object.entries(document.placements ?? {});
  const props: PlacedProp[] = [];
  for (const [modelId, placements] of entries) {
    const asset = catalogById.get(modelId);
    for (const entry of placements) {
      if (!entry.p || !entry.q || !entry.s) continue;
      const ds = asset?.defaultScale ?? 1;
      const s: [number, number, number] = [ds, ds, ds];
      const footprint = entry.footprint ?? asset?.footprint ?? [100, 100];
      // Recompute Y the same way the room designer does.
      let y = groundY;
      if (asset?.placementSurface === "wall") {
        y = groundY + (asset.wallMountHeight ?? 96);
      } else if (asset?.placeableOnTop) {
        // placeableOnTop items sit on a surface — their Y is already in props.json.
        y = entry.p[1] ?? groundY;
      }
      props.push({
        id: entry.id ?? `${modelId}-${props.length}`,
        modelId,
        footprint: [...footprint] as [number, number],
        position: [entry.p[0], y, entry.p[2]],
        quaternion: [...entry.q] as [number, number, number, number],
        scale: s,
      });
    }
  }
  return props;
}

/** Create lightweight box colliders from footprints for top-down mode. */
function createBoxColliders(
  api: SceneDebugApi,
  props: readonly PlacedProp[],
  sceneScale: number,
  groundY: number,
): unknown[] {
  const handles: unknown[] = [];
  for (const prop of props) {
    const [fpW, fpD] = prop.footprint;
    if (fpW < MIN_FOOTPRINT_FOR_COLLIDER && fpD < MIN_FOOTPRINT_FOR_COLLIDER) continue;
    const [rotW, rotD] = rotatedFootprintSize(prop.footprint, prop.quaternion);
    const halfW = (rotW / 2) * sceneScale;
    const halfD = (rotD / 2) * sceneScale;
    const halfH = (TOP_DOWN_COLLIDER_HEIGHT / 2) * sceneScale;
    const cx = prop.position[0] * sceneScale;
    const cy = (groundY + TOP_DOWN_COLLIDER_HEIGHT / 2) * sceneScale;
    const cz = prop.position[2] * sceneScale;
    const handle = api.addBoxCollider([halfW, halfH, halfD], [cx, cy, cz]);
    if (handle) handles.push(handle);
  }
  return handles;
}

/** Create trimesh colliders from the visual props group for perspective mode.
 * HQ props are loaded by the room designer as individual meshes inside a
 * `room-designer-props` group (not the static `props` field). Each prop is
 * a group named `room-prop:<modelId>-<id>` containing one or more child meshes. */
function createTrimeshColliders(api: SceneDebugApi): unknown[] {
  const handles: unknown[] = [];
  const scene = api.scene;
  scene.traverse((object) => {
    if (object.name !== "room-designer-props") return;
    object.updateWorldMatrix(true, true);
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      // Skip small placeableOnTop items (food, utensils, etc.) — they don't
      // need collision and would add unnecessary trimesh complexity.
      const parentName = child.parent?.name ?? "";
      if (
        /food|drink|utensil|paper|book|card|cash|gold|tooth|toy|toothbrush|toothpaste|cutting/i.test(
          parentName,
        )
      )
        return;
      const geometry = child.geometry.clone();
      // Bake the world matrix into the geometry so vertices are in world space.
      geometry.applyMatrix4(child.matrixWorld);
      const handle = api.addTrimeshCollider(geometry);
      if (handle) handles.push(handle);
      geometry.dispose();
    });
  });
  return handles;
}

export function PropColliders({
  debugApiRef,
  sceneId,
  catalog,
  sceneScale,
  groundY,
  cameraViewMode,
  sceneVersion = 0,
  propsVersion = 0,
}: PropCollidersProps) {
  const catalogByIdRef = useRef(new Map(catalog.map((asset) => [asset.id, asset])));
  catalogByIdRef.current = new Map(catalog.map((asset) => [asset.id, asset]));
  const collidersRef = useRef<unknown[]>([]);

  useEffect(() => {
    const api = debugApiRef.current;
    if (!api) return;

    // Remove existing colliders.
    for (const handle of collidersRef.current) {
      api.removePropCollider(handle);
    }
    collidersRef.current = [];

    let cancelled = false;
    void (async () => {
      if (cameraViewMode === "perspective") {
        // Trimesh colliders from the visual props group already in the scene.
        const handles = createTrimeshColliders(api);
        if (!cancelled) collidersRef.current = handles;
      } else {
        // Lightweight box colliders from footprints.
        const props = await loadPlacements(sceneId, catalogByIdRef.current, groundY);
        if (cancelled) return;
        const handles = createBoxColliders(api, props, sceneScale, groundY);
        if (!cancelled) collidersRef.current = handles;
      }
    })();

    return () => {
      cancelled = true;
      const currentApi = debugApiRef.current;
      if (!currentApi) return;
      for (const handle of collidersRef.current) {
        currentApi.removePropCollider(handle);
      }
      collidersRef.current = [];
    };
  }, [debugApiRef, sceneId, sceneScale, groundY, cameraViewMode, sceneVersion, propsVersion]);

  return null;
}
