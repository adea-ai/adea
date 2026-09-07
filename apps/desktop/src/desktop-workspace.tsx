import type { AgentHqApiClient } from '@adea-ai/api-client'
import { VirtualRoomControls, VirtualUnavailable, type WorkspaceView } from '@adea-ai/workspace-ui'
import { Suspense } from 'react'

function SceneLoading() {
  return (
    <main className="workspace-shell conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

type DesktopWorkspaceProps = Readonly<{
  client: AgentHqApiClient
  onWorkspaceViewChange(view: WorkspaceView): void
  scene: 'home' | 'work'
}>

export function DesktopWorkspace({ client, onWorkspaceViewChange, scene }: DesktopWorkspaceProps) {
  const searchParams =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  const characterDesigner =
    searchParams !== null &&
    searchParams.get('characterDesigner') !== null &&
    searchParams.get('characterDesigner') !== '0'
  const roomDesignerEnabled =
    searchParams !== null &&
    searchParams.get('roomDesigner') !== null &&
    searchParams.get('roomDesigner') !== '0'

  if (characterDesigner) {
    return (
      <Suspense fallback={<SceneLoading />}>
        <VirtualUnavailable sceneLabel="Character designer" />
      </Suspense>
    )
  }

  return (
    <main className="workspace-shell">
      <div className="workspace-scene-viewport">
        <Suspense fallback={<SceneLoading />}>
          <VirtualUnavailable
            sceneLabel={
              roomDesignerEnabled
                ? `${scene === 'work' ? 'Work' : 'Home'} room designer`
                : scene === 'work'
                  ? 'Work'
                  : 'Home'
            }
          />
        </Suspense>
        {!roomDesignerEnabled ? (
          <div className="workspace-ui" aria-label="Adea workspace controls">
            <VirtualRoomControls client={client} openChat={() => onWorkspaceViewChange('chat')} />
          </div>
        ) : null}
      </div>
    </main>
  )
}
