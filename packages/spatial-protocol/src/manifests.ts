import type { SceneManifest } from '@adea-ai/asset-manifests'

// Scene ids mirror @adea-ai/app-core's HqSceneId, which remains the canonical
// shell-side scene identity. This package only carries mount constants.
type HqSceneId = 'home' | 'work'

type HqSceneConfig = {
  label: string
  floorVersion: number
  foliageVersion: number
}

const sceneConfig = {
  home: { label: 'Home', floorVersion: 20, foliageVersion: 10 },
  work: { label: 'Work', floorVersion: 21, foliageVersion: 11 },
} as const satisfies Record<HqSceneId, HqSceneConfig>

// Start height mirrors the engine's ROOM_GALLERY_FOUNDATION_TOP_Y (slab base 0
// + height 6) plus the authored 135-unit lift. The engine's room-config is
// the simulation source of truth; this package carries the mount constants
// the shell needs without depending on engine code.
const START_Y = 6 + 135

function createHqManifest(scene: HqSceneId): SceneManifest {
  const { label, floorVersion, foliageVersion } = sceneConfig[scene]
  const sceneId = `hq-${scene}`
  return {
    id: sceneId,
    label,
    availability: 'ready',
    entryAssetUrl: `/assets/worlds/${sceneId}/floor.glb?v=${floorVersion}`,
    collisionAssetUrl: `/assets/worlds/${sceneId}/floor-collision.glb?v=${floorVersion}`,
    foliageManifestUrl: `/assets/worlds/${sceneId}/foliage.json?v=${foliageVersion}`,
    assignedPropsManifestUrl: `/assets/worlds/${sceneId}/props-runtime.json?v=room-layout`,
    zones: [],
    startPosition: { x: 0, y: START_Y, z: 0, yaw: 0, pitch: -0.2 },
  }
}

export const hqHomeManifest = createHqManifest('home')
export const hqWorkManifest = createHqManifest('work')
