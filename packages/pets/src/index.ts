// Agent HQ ambient pet system for the Home scene.
//
// The pets pack ships rigged GLBs with embedded run/walk/idle animations.
// This module provides a createAmbientAnimals() factory that loads a set of
// animals, places them in the scene, and wanders them around a bounded area.
// The update(dt) method advances each animal's AnimationMixer and steering;
// dispose() cleans up all resources.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

const assetRoot = '/assets/models/animals'

export type AmbientAnimalId = 'dog' | 'cat'

const animalFiles: Record<AmbientAnimalId, string> = {
  dog: 'Dog_001.glb',
  cat: 'Kitty_001.glb',
}

/** Every pet model currently packaged for Agent HQ. */
export const petAssetCatalog = [
  { id: 'chicken', file: 'Chicken_001.glb', label: 'Chicken' },
  { id: 'deer', file: 'Deer_001.glb', label: 'Deer' },
  { id: 'dog', file: 'Dog_001.glb', label: 'Dog' },
  { id: 'horse', file: 'Horse_001.glb', label: 'Horse' },
  { id: 'cat', file: 'Kitty_001.glb', label: 'Cat' },
  { id: 'penguin', file: 'Pinguin_001.glb', label: 'Penguin' },
  { id: 'tiger', file: 'Tiger_001.glb', label: 'Tiger' },
] as const
export type PetAssetId = (typeof petAssetCatalog)[number]['id']

// Embedded animation names in the pet GLBs follow the pattern
// "<ModelName>_<state>". Map them to the three states we use for wandering.
const animalAnimationNames: Record<AmbientAnimalId, { idle: string; walk: string; run: string }> = {
  dog: { idle: 'Dog_001_idle', walk: 'Dog_001_walk', run: 'Dog_001_run' },
  cat: { idle: 'Kitty_001_idle', walk: 'Kitty_001_walk', run: 'Kitty_001_run' },
}

/** Axis-aligned wall rectangle in world units. Animals are blocked from
 * entering these boxes. Computed by the caller from structural wall segments. */
export type AmbientAnimalWall = Readonly<{
  xMin: number
  xMax: number
  zMin: number
  zMax: number
}>

export type AmbientAnimalConfig = {
  id: AmbientAnimalId
  /** Start position in world units. */
  position: [number, number, number]
  /** Uniform model scale. */
  scale: number
  /** Bounding rectangle (center + half-extents) the animal wanders within. */
  wanderBounds: { centerX: number; centerZ: number; halfWidth: number; halfDepth: number }
  /** Wall collision rectangles. Animals bounce off these instead of passing
   * through. Optional so the system works with or without wall data. */
  walls?: readonly AmbientAnimalWall[]
}

type AnimalState = 'idle' | 'walking'

interface Animal {
  root: THREE.Object3D
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  state: AnimalState
  stateTimer: number
  heading: number
  speed: number
  wanderBounds: AmbientAnimalConfig['wanderBounds']
  walls: readonly AmbientAnimalWall[]
  /** Consecutive frames the animal has been fully blocked — used for
   * stuck detection and recovery. Reset to 0 whenever movement succeeds. */
  stuckFrames: number
}

export interface AmbientAnimals {
  update: (dt: number) => void
  dispose: () => void
  /** Provide a physics-based collision check (returns true if the authored
   *  x/y/z position is blocked by a collider). When set, this replaces the
   *  fallback AABB wall check so animals respect the same colliders as the
   *  player character. */
  setCollisionCheck: (check: ((x: number, y: number, z: number) => boolean) | null) => void
}

/** Returns true if the point (x, z) is inside any wall AABB expanded by
 * the given margin. Used for per-axis collision response so animals slide
 * along walls instead of clipping through them. */
function hitsWall(
  x: number,
  z: number,
  walls: readonly AmbientAnimalWall[],
  margin: number
): boolean {
  for (const w of walls) {
    if (x > w.xMin - margin && x < w.xMax + margin && z > w.zMin - margin && z < w.zMax + margin) {
      return true
    }
  }
  return false
}

export async function createAmbientAnimals(
  parent: THREE.Object3D,
  configs: readonly AmbientAnimalConfig[]
): Promise<AmbientAnimals> {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)

  const animals: Animal[] = []

  // Optional physics-based collision check. When set (by the caller after the
  // scene's physics world is ready), this replaces the AABB wall fallback so
  // animals respect the same colliders as the player character.
  let collisionCheck: ((x: number, y: number, z: number) => boolean) | null = null

  for (const config of configs) {
    const url = `${assetRoot}/${animalFiles[config.id]}`
    const gltf = await loader.loadAsync(url)
    const scene = gltf.scene

    // Configure the model.
    scene.scale.setScalar(config.scale)
    scene.position.set(...config.position)
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true
        obj.receiveShadow = true
      }
    })

    parent.add(scene)

    // Set up the animation mixer with the embedded clips.
    const mixer = new THREE.AnimationMixer(scene)
    const animNames = animalAnimationNames[config.id]
    const actions = new Map<string, THREE.AnimationAction>()
    for (const clip of gltf.animations) {
      if (clip.name === animNames.idle) {
        actions.set('idle', mixer.clipAction(clip))
      } else if (clip.name === animNames.walk) {
        actions.set('walk', mixer.clipAction(clip))
      } else if (clip.name === animNames.run) {
        actions.set('run', mixer.clipAction(clip))
      }
    }

    // Start idle.
    const idleAction = actions.get('idle')
    if (idleAction) idleAction.play()

    animals.push({
      root: scene,
      mixer,
      actions,
      state: 'idle',
      stateTimer: 2 + Math.random() * 3,
      heading: Math.random() * Math.PI * 2,
      speed: 0,
      wanderBounds: config.wanderBounds,
      walls: config.walls ?? [],
      stuckFrames: 0,
    })
  }

  function update(dt: number): void {
    for (const animal of animals) {
      animal.mixer.update(dt)
      animal.stateTimer -= dt

      if (animal.stateTimer <= 0) {
        if (animal.state === 'idle') {
          // Switch to walking.
          animal.state = 'walking'
          animal.stateTimer = 4 + Math.random() * 6
          animal.heading = Math.random() * Math.PI * 2
          animal.speed = 30 + Math.random() * 20
          const walk = animal.actions.get('walk')
          if (walk) {
            animal.actions.get('idle')?.fadeOut(0.3)
            walk.reset().fadeIn(0.3).play()
          }
        } else {
          // Switch to idle.
          animal.state = 'idle'
          animal.stateTimer = 2 + Math.random() * 4
          animal.speed = 0
          const idle = animal.actions.get('idle')
          if (idle) {
            animal.actions.get('walk')?.fadeOut(0.3)
            idle.reset().fadeIn(0.3).play()
          }
        }
      }

      if (animal.state === 'walking' && animal.speed > 0) {
        const margin = 24 // animal body radius in authored units
        const walls = animal.walls
        const py = animal.root.position.y

        // Use the physics-based collision check when available (same colliders
        // as the player); fall back to the AABB wall check otherwise.
        const blocked = (x: number, z: number): boolean => {
          if (collisionCheck) return collisionCheck(x, py, z)
          return hitsWall(x, z, walls, margin)
        }

        // Probe whether a step along a heading is clear. Probe slightly
        // further than one frame's movement so we detect walls early and
        // turn before actually hitting them.
        const stepClear = (heading: number): boolean => {
          const dist = animal.speed * dt + 12 // look-ahead in authored units
          const sx = Math.sin(heading) * dist
          const sz = Math.cos(heading) * dist
          return !blocked(animal.root.position.x + sx, animal.root.position.z + sz)
        }

        // If stuck for a few frames, try a range of rotations to find a
        // clear direction. Probe at 30° increments, then fall back to a
        // random heading if nothing is clear. The low threshold (3 frames)
        // prevents visible twitching against walls.
        if (animal.stuckFrames > 3) {
          const probes = [
            Math.PI / 6,
            -Math.PI / 6,
            Math.PI / 4,
            -Math.PI / 4,
            Math.PI / 2,
            -Math.PI / 2,
            (3 * Math.PI) / 4,
            -(3 * Math.PI) / 4,
            Math.PI,
          ]
          let found = false
          for (const delta of probes) {
            const candidate = animal.heading + delta
            if (stepClear(candidate)) {
              animal.heading = candidate
              found = true
              break
            }
          }
          if (!found) {
            // Truly cornered — pick a random heading and reset stuck counter
            // so the animal doesn't spam probes every frame.
            animal.heading = Math.random() * Math.PI * 2
            animal.stuckFrames = 0
          } else {
            animal.stuckFrames = 0
          }
        }

        // Move forward along heading, checking wall collisions per-axis so
        // the animal slides along walls instead of passing through them.
        const stepX = Math.sin(animal.heading) * animal.speed * dt
        const stepZ = Math.cos(animal.heading) * animal.speed * dt

        // Try X movement.
        const nextX = animal.root.position.x + stepX
        let xBlocked = false
        if (blocked(nextX, animal.root.position.z)) {
          xBlocked = true
        } else {
          animal.root.position.x = nextX
        }

        // Try Z movement.
        const nextZ = animal.root.position.z + stepZ
        let zBlocked = false
        if (blocked(animal.root.position.x, nextZ)) {
          zBlocked = true
        } else {
          animal.root.position.z = nextZ
        }

        // Track stuck state. When blocked on both axes, increment the stuck
        // counter so the probe logic above can find a clear direction on a
        // subsequent frame. When blocked on only one axis, the animal slides
        // along the other — no heading change needed (this prevents the
        // oscillation that per-axis reflection caused).
        if (xBlocked && zBlocked) {
          animal.stuckFrames++
        } else {
          animal.stuckFrames = 0
          // When blocked on a single axis, nudge the heading slightly toward
          // the open axis so the animal gradually turns away from the wall
          // instead of grinding along it indefinitely.
          if (xBlocked && !zBlocked) {
            animal.heading += Math.sin(animal.heading) > 0 ? -0.15 : 0.15
          } else if (zBlocked && !xBlocked) {
            animal.heading += Math.cos(animal.heading) > 0 ? -0.15 : 0.15
          }
        }

        // Keep within wander bounds; turn around if hitting an edge.
        const { centerX, centerZ, halfWidth, halfDepth } = animal.wanderBounds
        const px = animal.root.position.x
        const pz = animal.root.position.z
        if (px < centerX - halfWidth || px > centerX + halfWidth) {
          animal.heading = Math.PI - animal.heading
          animal.root.position.x = THREE.MathUtils.clamp(
            px,
            centerX - halfWidth,
            centerX + halfWidth
          )
          animal.stuckFrames = 0
        }
        if (pz < centerZ - halfDepth || pz > centerZ + halfDepth) {
          animal.heading = -animal.heading
          animal.root.position.z = THREE.MathUtils.clamp(
            pz,
            centerZ - halfDepth,
            centerZ + halfDepth
          )
          animal.stuckFrames = 0
        }

        // Occasionally adjust heading slightly for natural wandering.
        if (Math.random() < 0.02) {
          animal.heading += (Math.random() - 0.5) * 0.8
        }

        // Face the walking direction.
        animal.root.rotation.y = animal.heading
      }
    }
  }

  function dispose(): void {
    for (const animal of animals) {
      animal.mixer.stopAllAction()
      animal.root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return
        obj.geometry.dispose()
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const material of materials) {
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) value.dispose()
          }
          material.dispose()
        }
      })
      animal.root.parent?.remove(animal.root)
    }
    animals.length = 0
  }

  return {
    update,
    dispose,
    setCollisionCheck: (check: ((x: number, y: number, z: number) => boolean) | null) => {
      collisionCheck = check
    },
  }
}
