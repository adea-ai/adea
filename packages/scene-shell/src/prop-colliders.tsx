'use client'

import { useEffect, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { AssignedPropsManifest } from '@agent-hq/asset-manifests'
import type { SceneDebugApi } from '@agent-hq/scene-runtime'
import { loadAssignedPropsManifest } from './assigned-props-document'

export type PropCollidersProps = {
  debugApiRef: MutableRefObject<SceneDebugApi | null>
  /** Runtime-only manifest for props assigned to the scene. */
  manifestUrl?: string
  /** Runtime scale applied to the visual scene group. */
  sceneScale: number
  /** Authored ground Y (floor surface) in HQ units. */
  groundY: number
  /** Current camera view mode — drives collider strategy. */
  cameraViewMode: 'perspective' | 'orthographic'
  /** Increments when the scene is recreated (character switch, etc.). */
  sceneVersion?: number
  /** Increments when the room designer saves a new layout. */
  propsVersion?: number
}

/** Fixed collision height for top-down box colliders (100cm in authored units). */
const TOP_DOWN_COLLIDER_HEIGHT = 100
/** Skip colliders for items smaller than this footprint dimension (cm). */
const MIN_FOOTPRINT_FOR_COLLIDER = 20

type PlacedProp = {
  id: string
  modelId: string
  footprint: [number, number]
  position: [number, number, number]
  quaternion: [number, number, number, number]
}

function yawFromQuaternion(q: readonly [number, number, number, number]): number {
  const [, y, , w] = q
  return Math.atan2(2 * w * y, 1 - 2 * y * y)
}

function rotatedFootprintSize(
  footprint: readonly [number, number],
  q: readonly [number, number, number, number]
): [number, number] {
  const yaw = yawFromQuaternion(q)
  const cos = Math.abs(Math.cos(yaw))
  const sin = Math.abs(Math.sin(yaw))
  return [footprint[0] * cos + footprint[1] * sin, footprint[0] * sin + footprint[1] * cos]
}

function validFootprint(value: unknown): [number, number] | null {
  return Array.isArray(value) &&
    value.length === 2 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? [value[0], value[1]]
    : null
}

function validTuple<T extends number[]>(value: unknown, length: number): T | null {
  return Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? (value as T)
    : null
}

/** Load and normalize placements from the scene's assigned-props manifest. */
async function loadPlacements(manifestUrl: string, groundY: number): Promise<PlacedProp[]> {
  const document: AssignedPropsManifest = await loadAssignedPropsManifest(manifestUrl)
  const props: PlacedProp[] = []
  for (const [modelId, placements] of Object.entries(document.placements ?? {})) {
    const asset = document.assets?.[modelId]
    for (const entry of placements) {
      const position = validTuple<[number, number, number]>(entry.p, 3)
      const quaternion = validTuple<[number, number, number, number]>(entry.q, 4)
      if (!position || !quaternion) continue
      const footprint = validFootprint(entry.footprint ?? asset?.footprint) ?? [100, 100]
      let y = position[1] ?? groundY
      if (asset?.placementSurface === 'wall') {
        y = groundY + (asset.wallMountHeight ?? 96)
      }
      props.push({
        id: entry.id ?? `${modelId}-${props.length}`,
        modelId,
        footprint,
        position: [position[0], y, position[2]],
        quaternion,
      })
    }
  }
  return props
}

/** Create lightweight box colliders from footprints for top-down mode. */
function createBoxColliders(
  api: SceneDebugApi,
  props: readonly PlacedProp[],
  sceneScale: number,
  groundY: number
): unknown[] {
  const handles: unknown[] = []
  for (const prop of props) {
    const [fpW, fpD] = prop.footprint
    if (fpW < MIN_FOOTPRINT_FOR_COLLIDER && fpD < MIN_FOOTPRINT_FOR_COLLIDER) continue
    const [rotW, rotD] = rotatedFootprintSize(prop.footprint, prop.quaternion)
    const halfW = (rotW / 2) * sceneScale
    const halfD = (rotD / 2) * sceneScale
    const halfH = (TOP_DOWN_COLLIDER_HEIGHT / 2) * sceneScale
    const cx = prop.position[0] * sceneScale
    const cy = (groundY + TOP_DOWN_COLLIDER_HEIGHT / 2) * sceneScale
    const cz = prop.position[2] * sceneScale
    const handle = api.addBoxCollider([halfW, halfH, halfD], [cx, cy, cz])
    if (handle) handles.push(handle)
  }
  return handles
}

/** Create trimesh colliders from either the runtime or editor prop group. */
function createTrimeshColliders(api: SceneDebugApi): unknown[] {
  const handles: unknown[] = []
  const scene = api.scene
  scene.traverse((object) => {
    if (object.name !== 'workspace-assigned-props' && object.name !== 'room-designer-props') return
    object.updateWorldMatrix(true, true)
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      // Small placeableOnTop items (food, utensils, etc.) don't need collision.
      const parentName = child.parent?.name ?? ''
      if (
        /food|drink|utensil|paper|book|card|cash|gold|tooth|toy|toothbrush|toothpaste|cutting/i.test(
          parentName
        )
      )
        return
      const geometry = child.geometry.clone()
      geometry.applyMatrix4(child.matrixWorld)
      const handle = api.addTrimeshCollider(geometry)
      if (handle) handles.push(handle)
      geometry.dispose()
    })
  })
  return handles
}

export function PropColliders({
  debugApiRef,
  manifestUrl,
  sceneScale,
  groundY,
  cameraViewMode,
  sceneVersion = 0,
  propsVersion = 0,
}: PropCollidersProps) {
  const collidersRef = useRef<unknown[]>([])

  useEffect(() => {
    const api = debugApiRef.current
    if (!api || !manifestUrl) return

    for (const handle of collidersRef.current) {
      api.removePropCollider(handle)
    }
    collidersRef.current = []

    let cancelled = false
    void (async () => {
      if (cameraViewMode === 'perspective') {
        const handles = createTrimeshColliders(api)
        if (!cancelled) collidersRef.current = handles
      } else {
        const props = await loadPlacements(manifestUrl, groundY)
        if (cancelled) return
        const handles = createBoxColliders(api, props, sceneScale, groundY)
        if (!cancelled) collidersRef.current = handles
      }
    })()

    return () => {
      cancelled = true
      const currentApi = debugApiRef.current
      if (!currentApi) return
      for (const handle of collidersRef.current) {
        currentApi.removePropCollider(handle)
      }
      collidersRef.current = []
    }
  }, [cameraViewMode, debugApiRef, groundY, manifestUrl, sceneScale, sceneVersion, propsVersion])

  return null
}
