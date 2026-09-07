'use client'

import { useEffect, useState } from 'react'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import type { HqSceneId } from '@adea-ai/app-core'
import { useWorkspaceStore } from '@adea-ai/state'
import { hqHomeManifest, hqWorkManifest } from '@adea-ai/spatial-protocol'
import type { SceneStartPosition } from '@adea-ai/asset-manifests'
import {
  VirtualRoomControls,
  VirtualUnavailable,
  type WorkspacePlatformServices,
  type WorkspaceView,
} from '@adea-ai/workspace-ui'

const sceneOptions = [
  {
    id: 'home' as const,
    label: 'Home',
    manifest: hqHomeManifest,
  },
  {
    id: 'work' as const,
    label: 'Work',
    manifest: hqWorkManifest,
  },
] as const

const sceneById = Object.fromEntries(sceneOptions.map((option) => [option.id, option])) as Record<
  HqSceneId,
  (typeof sceneOptions)[number]
>

export type WorkspaceShellProps = {
  apiClient?: AgentHqApiClient
  initialScene: HqSceneId
  initialCharacter: string
  startPosition?: SceneStartPosition
  cameraViewMode?: 'perspective' | 'orthographic'
  onWorkspaceViewChange?: (view: WorkspaceView) => void
  onOpenRoomDesigner?: () => void
  workspaceView?: WorkspaceView
  services?: WorkspacePlatformServices
}

export function WorkspaceShell({
  apiClient: providedApiClient,
  initialScene,
  initialCharacter: _initialCharacter,
  startPosition: _startPosition,
  cameraViewMode: initialCameraViewMode = 'orthographic',
  onWorkspaceViewChange,
  onOpenRoomDesigner: _onOpenRoomDesigner,
}: WorkspaceShellProps) {
  const selectedScene = useWorkspaceStore((state) => state.selectedScene)
  const setSelectedScene = useWorkspaceStore((state) => state.setSelectedScene)
  const setCameraViewMode = useWorkspaceStore((state) => state.setCameraViewMode)
  const [storeReady, setStoreReady] = useState(false)
  const [fallbackApiClient] = useState(() => createApiClient())
  const apiClient = providedApiClient ?? fallbackApiClient
  const sceneId = storeReady ? selectedScene : initialScene
  const scene = sceneById[sceneId]
  useEffect(() => {
    setSelectedScene(initialScene)
    setCameraViewMode(initialCameraViewMode)
    setStoreReady(true)
  }, [initialCameraViewMode, initialScene, setCameraViewMode, setSelectedScene])

  useEffect(() => {
    document.title = `Adea | ${scene.label}`
  }, [scene.label])

  return (
    <main className="workspace-shell">
      <div className="workspace-scene-viewport">
        <VirtualUnavailable
          sceneLabel={scene.label}
          onOpenChat={() => onWorkspaceViewChange?.('chat')}
        />

        <div className="workspace-ui" aria-label="Adea workspace controls">
          <VirtualRoomControls
            client={apiClient}
            openChat={() => onWorkspaceViewChange?.('chat')}
          />

          <p className="workspace-scene-caption">
            <span className="workspace-scene-caption__dot" aria-hidden="true" />
            {scene.label} scene · Virtual view lives in Agent Sim
          </p>
        </div>
      </div>
    </main>
  )
}
