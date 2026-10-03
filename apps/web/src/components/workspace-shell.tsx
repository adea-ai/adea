import { createEffect, createSignal, onMount } from 'solid-js'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import type { HqSceneId } from '@adea-ai/app-core'
import { workspaceStore } from '@adea-ai/state'
import { hqHomeManifest, hqWorkManifest, type SceneStartPosition } from '@adea-ai/spatial'
// Subpath imports keep this chunk's static graph shallow: the package barrel
// re-exports the dialogs and the conventional shell, which would otherwise be
// preloaded with the virtual scene.
import { VirtualRoomControls } from '@adea-ai/workspace-ui/virtual-room-controls'
import { VirtualUnavailable } from '@adea-ai/workspace-ui/virtual-unavailable'
import { VirtualView } from '@adea-ai/workspace-ui/virtual-view'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import type { WorkspaceView } from '@adea-ai/workspace-ui/workspace-view-toggle'

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
  restoreFocusRef?: () => HTMLElement | undefined
  initialScene: HqSceneId
  initialCharacter: string
  startPosition?: SceneStartPosition
  cameraViewMode?: 'perspective' | 'orthographic'
  onWorkspaceViewChange?: (view: WorkspaceView) => void
  onOpenRoomDesigner?: () => void
  workspaceView?: WorkspaceView
  services?: WorkspacePlatformServices
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  const [fallbackApiClient] = createSignal(createApiClient())
  const apiClient = () => props.apiClient ?? fallbackApiClient()
  // The scene is a router fact (`?scene=`, reconciled to the active workspace
  // by WorkspaceNavigation); the shell renders the prop it is handed and never
  // mirrors it into the store.
  const sceneId = () => props.initialScene
  const scene = () => sceneById[sceneId()]

  onMount(() => {
    workspaceStore.getState().setCameraViewMode(props.cameraViewMode ?? 'orthographic')
  })

  createEffect(() => {
    document.title = `Adea | ${scene().label}`
  })

  return (
    <main class="workspace-shell workspace-shell--contextual">
      <VirtualRoomControls
        client={apiClient()}
        restoreFocusRef={props.restoreFocusRef}
        openChat={() => props.onWorkspaceViewChange?.('chat')}
      />
      <div class="workspace-scene-viewport">
        <VirtualView
          fallback={
            <>
              <VirtualUnavailable
                contained
                sceneLabel={scene().label}
                onOpenChat={() => props.onWorkspaceViewChange?.('chat')}
              />

              <div class="workspace-ui" aria-label="Adea workspace controls">
                <p class="workspace-scene-caption">
                  <span class="workspace-scene-caption__dot" aria-hidden="true" />
                  {scene().label} scene · Virtual view lives in Agent Sim
                </p>
              </div>
            </>
          }
        />
      </div>
    </main>
  )
}
