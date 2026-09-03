'use client'

import { useCallback, useState } from 'react'
import * as THREE from 'three'
import { SceneHost } from '@agent-hq/scene-runtime'
import type { CharacterScale, SceneHostStart } from '@agent-hq/scene-runtime'
import type { CharacterConfiguration } from '@agent-hq/characters'
import { CharacterDesigner, type CharacterDesignerProps } from './character-designer'

const DESIGNER_CHARACTER_SCALE: CharacterScale = {
  height: 1.35,
  radius: 0.24,
  modelScale: 1,
}
const DESIGNER_START_POSITION: SceneHostStart = {
  x: 0,
  y: DESIGNER_CHARACTER_SCALE.height / 2,
  z: 0,
  yaw: 0,
  pitch: 0,
}

const designerEnvironment = {
  background: 0xf7edf3,
  hemisphereLight: {
    skyColor: 0xfff9fc,
    groundColor: 0xcab1c0,
    intensity: 2.1,
  },
  directionalLights: [
    {
      color: 0xfff2f7,
      intensity: 2.8,
      position: [-3, 5, -4] as const,
      target: [0, 1, 0] as const,
    },
    {
      color: 0xffd8e8,
      intensity: 1.1,
      position: [4, 2, 2] as const,
      target: [0, 1, 0] as const,
    },
  ],
} as const

function createStageMaterial(color: number, roughness = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 })
}

export function createDesignerStage(root: THREE.Group): void {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 7), createStageMaterial(0xf3dce8))
  floor.name = 'character-designer-floor'
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.02
  floor.receiveShadow = true
  root.add(floor)

  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(1.35, 1.45, 0.12, 64),
    createStageMaterial(0xffffff, 0.75)
  )
  platform.name = 'character-designer-platform'
  platform.position.y = 0.04
  platform.castShadow = true
  platform.receiveShadow = true
  root.add(platform)

  const platformAccent = new THREE.Mesh(
    new THREE.TorusGeometry(1.08, 0.025, 12, 64),
    createStageMaterial(0xe3a9c6, 0.65)
  )
  platformAccent.name = 'character-designer-platform-accent'
  platformAccent.rotation.x = Math.PI / 2
  platformAccent.position.y = 0.11
  platformAccent.receiveShadow = true
  root.add(platformAccent)
}

export type CharacterDesignerSceneProps = Omit<
  CharacterDesignerProps,
  'enabled' | 'character' | 'characterConfiguration'
> & {
  character: string
  characterConfiguration?: CharacterConfiguration
}

/** Full-screen dress-up room used while editing a character. */
export function CharacterDesignerScene({
  character,
  characterConfiguration,
  ...designerProps
}: CharacterDesignerSceneProps) {
  const [sceneReady, setSceneReady] = useState(false)
  const handleLoadingStart = useCallback(() => setSceneReady(false), [])
  const handleReady = useCallback(() => setSceneReady(true), [])

  return (
    <div className="character-designer-room" aria-busy={!sceneReady}>
      <SceneHost
        label="Character studio"
        viewportMode="container"
        characterId={character}
        characterConfiguration={characterConfiguration}
        physicsEnabled={false}
        ktx2Enabled={false}
        characterPreview
        characterScale={DESIGNER_CHARACTER_SCALE}
        startPosition={DESIGNER_START_POSITION}
        initialCameraViewMode="perspective"
        cameraTargetMode="center"
        perspectiveCameraDistance={2.35}
        movementSpeedFactor={0}
        cameraWheelZoomEnabled
        deferCharacterDetails={false}
        environment={designerEnvironment}
        visualSetup={createDesignerStage}
        onLoadingStart={handleLoadingStart}
        onReady={handleReady}
      />
      {!sceneReady ? (
        <div
          className="pointer-events-none fixed inset-0 z-[105] flex items-center justify-center"
          role="status"
          aria-live="polite"
        >
          <div className="rounded-full border border-[#d9b2c9] bg-white/85 px-4 py-2 text-sm font-medium text-[#5d4654] shadow-lg backdrop-blur-sm">
            Setting up your fitting room…
          </div>
        </div>
      ) : null}
      <CharacterDesigner
        {...designerProps}
        enabled
        character={character}
        characterConfiguration={characterConfiguration}
      />
    </div>
  )
}
