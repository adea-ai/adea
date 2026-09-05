'use client'

import { useRef } from 'react'
import { hqHomeManifest, hqWorkManifest } from '@agent-hq/hq-scenes'
import { HqRoomScene } from '@agent-hq/hq-scenes/runtime'
import type { SceneDebugApi } from '@agent-hq/scene-runtime'
import { invalidateAssignedPropsManifest } from '@agent-hq/scene-shell'
import { interiorPropAssets } from '@agent-hq/interior'
import { RoomDesigner, type RoomDesignerProps } from './room-designer'
import {
  hqRoomDesignerBackdropColor,
  hqRoomDesignerBackdropPadding,
  hqRoomDesignerBlockedRects,
  hqRoomDesignerDesignOrthographicHalfHeight,
  hqRoomDesignerDoorwayRects,
  hqRoomDesignerFrontWalkwayBlockedRect,
  hqRoomDesignerGridSize,
  hqRoomDesignerGroundY,
  hqRoomDesignerMapBounds,
  hqRoomDesignerNormalOrthographicHalfHeight,
  hqRoomDesignerPlayerPosition,
  hqRoomDesignerRegions,
  hqRoomDesignerSceneScale,
} from './hq-room-designer-config'

export type RoomDesignerSceneProps = Readonly<{
  initialCharacter: string
  initialScene: 'home' | 'work'
  onClose?: () => void
  saveRef?: RoomDesignerProps['saveRef']
  onDirtyChange?: RoomDesignerProps['onDirtyChange']
}>

/**
 * Dedicated HQ Room Designer scene. It mounts its own HqRoomScene instance so
 * designer camera state, props, and controls cannot leak into normal HQ.
 */
export function RoomDesignerScene({
  initialCharacter,
  initialScene,
  onClose,
  saveRef,
  onDirtyChange,
}: RoomDesignerSceneProps) {
  const debugApiRef = useRef<SceneDebugApi | null>(null)
  const manifest = initialScene === 'work' ? hqWorkManifest : hqHomeManifest
  const blockedRects = [...hqRoomDesignerBlockedRects, hqRoomDesignerFrontWalkwayBlockedRect]

  return (
    <HqRoomScene
      initialCharacter={initialCharacter}
      manifest={manifest}
      cameraViewMode="orthographic"
      showAccountDrawer={false}
      assignedPropsEnabled={false}
      enablePropColliders={false}
      enableCharacterDesigner={false}
      allowCameraViewModeChange={false}
      showOnScreenControls={false}
      enableClickNavigation={false}
      cameraWheelZoomEnabled={false}
      enableSceneEditor={false}
      enableAmbientAnimals={false}
      loadDeferredCharacterDetails={false}
      debugApiRef={debugApiRef}
      sceneOverlay={
        <RoomDesigner
          manifest={manifest}
          debugApiRef={debugApiRef}
          enabled
          sceneScale={hqRoomDesignerSceneScale}
          groundY={hqRoomDesignerGroundY}
          gridSize={hqRoomDesignerGridSize}
          mapBounds={hqRoomDesignerMapBounds}
          regions={hqRoomDesignerRegions}
          blockedRects={blockedRects}
          doorwayRects={hqRoomDesignerDoorwayRects}
          normalOrthographicHalfHeight={hqRoomDesignerNormalOrthographicHalfHeight}
          designOrthographicHalfHeight={hqRoomDesignerDesignOrthographicHalfHeight}
          designBackdropColor={hqRoomDesignerBackdropColor}
          designBackdropPadding={hqRoomDesignerBackdropPadding}
          playerPosition={hqRoomDesignerPlayerPosition}
          onClose={onClose}
          saveRef={saveRef}
          onDirtyChange={onDirtyChange}
          onSaved={
            manifest.assignedPropsManifestUrl
              ? () => invalidateAssignedPropsManifest(manifest.assignedPropsManifestUrl!)
              : undefined
          }
          catalog={interiorPropAssets}
        />
      }
    />
  )
}
