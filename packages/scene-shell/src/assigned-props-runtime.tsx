"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { SceneDebugApi } from "@agent-hq/scene-runtime";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { loadAssignedPropsManifest } from "./assigned-props-document";

const modelCache = new Map<string, Promise<THREE.Object3D>>();
const modelLoader = new GLTFLoader();
modelLoader.setMeshoptDecoder(MeshoptDecoder);

function modelFor(assetUrl: string): Promise<THREE.Object3D> {
  const cached = modelCache.get(assetUrl);
  if (cached) return cached;
  const loaded = modelLoader
    .loadAsync(assetUrl)
    .then(({ scene }: { scene: THREE.Object3D }) => scene);
  modelCache.set(assetUrl, loaded);
  return loaded;
}

const yieldToBrowser = () =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

function finiteTuple<T extends readonly number[]>(value: unknown, length: number): T | null {
  return Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? (value as unknown as T)
    : null;
}

/**
 * Renders only the props already assigned to a workspace scene. The editor,
 * catalog, and authoring document stay outside the normal HQ scene path.
 */
export function AssignedPropsRuntime({
  debugApiRef,
  manifestUrl,
  sceneScale,
  sceneVersion = 0,
}: {
  debugApiRef: MutableRefObject<SceneDebugApi | null>;
  manifestUrl?: string;
  sceneScale: number;
  sceneVersion?: number;
}) {
  const groupRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    const api = debugApiRef.current;
    if (!api || !manifestUrl) return;

    const group = new THREE.Group();
    group.name = "workspace-assigned-props";
    api.scene.add(group);
    groupRef.current = group;
    let cancelled = false;

    const rebuild = async () => {
      try {
        const manifest = await loadAssignedPropsManifest(manifestUrl);
        const entries = Object.entries(manifest.placements ?? {});
        for (const [modelId, placements] of entries) {
          const asset = manifest.assets?.[modelId];
          if (!asset) continue;
          const source = await modelFor(asset.assetUrl);
          for (const [index, entry] of placements.entries()) {
            if (cancelled) return;
            const position = finiteTuple<[number, number, number]>(entry.p, 3);
            const quaternion = finiteTuple<[number, number, number, number]>(entry.q, 4);
            if (!position || !quaternion) continue;
            await yieldToBrowser();
            if (cancelled) return;

            const object = source.clone(true);
            const id = entry.id || `${modelId}-${index}`;
            object.name = `workspace-prop:${id}`;
            const floorY = position[1] * sceneScale;
            object.position.set(position[0] * sceneScale, floorY, position[2] * sceneScale);
            object.quaternion.set(...quaternion);
            const scale = finiteTuple<[number, number, number]>(entry.s, 3) ?? [
              asset.defaultScale,
              asset.defaultScale,
              asset.defaultScale,
            ];
            object.scale.set(...scale);
            object.updateMatrixWorld(true);
            if (asset.placementSurface !== "wall") {
              const bounds = new THREE.Box3().setFromObject(object);
              object.position.y +=
                floorY +
                (asset.floorLift ?? 0) * sceneScale -
                (bounds.isEmpty() ? 0 : bounds.min.y);
            }
            object.userData.assignedPropPlacementId = id;
            object.userData.assignedPropModelId = modelId;
            group.add(object);
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("[HQ] Could not load assigned room props.", error);
        }
      }
    };

    void rebuild();
    return () => {
      cancelled = true;
      if (groupRef.current === group) groupRef.current = null;
      if (group.parent) group.parent.remove(group);
    };
  }, [debugApiRef, manifestUrl, sceneScale, sceneVersion]);

  return null;
}
