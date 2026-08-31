'use client'

import dynamic from 'next/dynamic'
import { Profiler, type ProfilerOnRenderCallback, useEffect, useState } from 'react'
import { createApiClient, type AgentHqApiClient } from '@agent-hq/api-client'
import type { HqSceneId } from '@agent-hq/app-core'
import { useAgentListQuery, useWorkspaceBootstrapQuery } from '@agent-hq/data'
import { useWorkspaceStore } from '@agent-hq/state'
import { hqHomeManifest, hqWorkManifest } from '@agent-hq/hq-scenes'
import type { SceneStartPosition } from '@agent-hq/asset-manifests'
import {
  VirtualRoomControls,
  WorkspaceSettingsDialog,
  type WorkspacePlatformServices,
  type WorkspaceView,
} from '@agent-hq/workspace-ui'

const HqRoomScene = dynamic(
  () => import('@agent-hq/hq-scenes/runtime').then((module) => module.HqRoomScene),
  { ssr: false }
)

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

const recordReactCommit: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime
) => {
  const target = window as Window & {
    __AGENT_HQ_REACT_PROFILE__?: Array<{
      id: string
      phase: 'mount' | 'update'
      actualDurationMs: number
      baseDurationMs: number
      startTime: number
      commitTime: number
    }>
  }
  const entries = target.__AGENT_HQ_REACT_PROFILE__ ?? []
  entries.push({
    id,
    phase: phase === 'mount' ? 'mount' : 'update',
    actualDurationMs: actualDuration,
    baseDurationMs: baseDuration,
    startTime,
    commitTime,
  })
  if (entries.length > 100) entries.splice(0, entries.length - 100)
  target.__AGENT_HQ_REACT_PROFILE__ = entries
}

export type WorkspaceShellProps = {
  apiClient?: AgentHqApiClient
  initialScene: HqSceneId
  initialCharacter: string
  startPosition?: SceneStartPosition
  cameraViewMode?: 'perspective' | 'orthographic'
  onWorkspaceViewChange?: (view: WorkspaceView) => void
  workspaceView?: WorkspaceView
  services?: WorkspacePlatformServices
}

export function WorkspaceShell({
  apiClient: providedApiClient,
  initialScene,
  initialCharacter,
  startPosition,
  cameraViewMode: initialCameraViewMode = 'orthographic',
  onWorkspaceViewChange,
  services,
}: WorkspaceShellProps) {
  const selectedScene = useWorkspaceStore((state) => state.selectedScene)
  const setSelectedScene = useWorkspaceStore((state) => state.setSelectedScene)
  const cameraViewMode = useWorkspaceStore((state) => state.cameraViewMode)
  const setCameraViewMode = useWorkspaceStore((state) => state.setCameraViewMode)
  const globalPanel = useWorkspaceStore((state) => state.globalPanel)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const setActiveSurface = useWorkspaceStore((state) => state.setActiveSurface)
  const setGlobalPanel = useWorkspaceStore((state) => state.setGlobalPanel)
  const [storeReady, setStoreReady] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)
  const [fallbackApiClient] = useState(() => createApiClient())
  const apiClient = providedApiClient ?? fallbackApiClient
  const workspaceQuery = useWorkspaceBootstrapQuery(apiClient)
  const activeWorkspace =
    workspaceQuery.data?.workspaces.find(({ id }) => id === selectedWorkspaceId) ??
    workspaceQuery.data?.activeWorkspace
  const agentsQuery = useAgentListQuery(apiClient, activeWorkspace?.id)
  const sceneId = storeReady ? selectedScene : initialScene
  const activeCameraViewMode = storeReady ? cameraViewMode : initialCameraViewMode
  const scene = sceneById[sceneId]
  const principal = workspaceQuery.data?.principal
  const accountAuthenticated = Boolean(principal && !principal.temporary)
  const accountLabel = accountAuthenticated ? (principal?.displayName ?? 'Account') : 'Sign in'
  useEffect(() => {
    setSelectedScene(initialScene)
    setCameraViewMode(initialCameraViewMode)
    setStoreReady(true)
  }, [initialCameraViewMode, initialScene, setCameraViewMode, setSelectedScene])

  useEffect(() => {
    document.title = `Agent HQ | ${scene.label}`
  }, [scene.label])

  const signIn = () => services?.account?.onSignIn()
  const signOut = async () => {
    setAccountBusy(true)
    try {
      await services?.account?.onSignOut()
    } finally {
      setAccountBusy(false)
    }
  }

  return (
    <main className="workspace-shell">
      <div className="workspace-scene-viewport">
        <Profiler id="hq-room-scene" onRender={recordReactCommit}>
          <HqRoomScene
            key={sceneId}
            initialCharacter={initialCharacter}
            manifest={scene.manifest}
            startPosition={startPosition}
            cameraViewMode={activeCameraViewMode}
            onCameraViewModeChange={setCameraViewMode}
            showAccountDrawer={false}
            cameraTargetId="workspace-camera-slot"
            roomDesignerTargetId="workspace-scene-tools-slot"
            sceneEditorTargetId="workspace-scene-tools-slot"
          />
        </Profiler>

        <div className="workspace-ui" aria-label="Agent HQ workspace controls">
          <VirtualRoomControls
            client={apiClient}
            openChat={() => onWorkspaceViewChange?.('chat')}
          />

          <div
            id="workspace-scene-tools-slot"
            className="workspace-scene-tools"
            role="group"
            aria-label="Scene tools"
          />

          <div className="workspace-view-switcher" aria-label="Camera view">
            <div id="workspace-camera-slot" className="workspace-tool-slot" />
          </div>

          <p className="workspace-scene-caption">
            <span className="workspace-scene-caption__dot" aria-hidden="true" />
            {scene.label} scene · Drag to orbit · Zoom controls
          </p>
        </div>
      </div>
      {activeWorkspace ? (
        <WorkspaceSettingsDialog
          accountAuthenticated={accountAuthenticated}
          accountLabel={accountLabel}
          agents={agentsQuery.data ?? []}
          busy={services?.account?.busy ?? accountBusy}
          onClose={() => setGlobalPanel(null)}
          onOpenAgents={() => {
            setActiveSurface('agents')
            setGlobalPanel(null)
            onWorkspaceViewChange?.('chat')
          }}
          onSignIn={signIn}
          onSignOut={() => void signOut()}
          open={globalPanel === 'settings'}
          services={services}
          workspace={activeWorkspace}
        />
      ) : null}
    </main>
  )
}
