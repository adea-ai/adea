import { hqHomeManifest, hqWorkManifest } from '@agent-hq/hq-scenes'
import { configurableCharacterId } from '@agent-hq/characters'
import { HqRoomScene } from '@agent-hq/hq-scenes/runtime'
import type { AgentHqApiClient } from '@agent-hq/api-client'
import { VirtualRoomControls, type WorkspaceView } from '@agent-hq/workspace-ui'

type DesktopWorkspaceProps = Readonly<{
  client: AgentHqApiClient
  onWorkspaceViewChange(view: WorkspaceView): void
  scene: 'home' | 'work'
}>

export function DesktopWorkspace({ client, onWorkspaceViewChange, scene }: DesktopWorkspaceProps) {
  const manifest = scene === 'work' ? hqWorkManifest : hqHomeManifest

  return (
    <main className="workspace-shell">
      <div className="workspace-scene-viewport">
        <HqRoomScene
          key={scene}
          initialCharacter={configurableCharacterId}
          manifest={manifest}
          cameraViewMode="orthographic"
          showAccountDrawer={false}
          cameraTargetId="workspace-camera-slot"
          roomDesignerTargetId="workspace-scene-tools-slot"
          characterDesignerTargetId="workspace-scene-tools-slot"
          sceneEditorTargetId="workspace-scene-tools-slot"
        />

        <div className="workspace-ui" aria-label="Agent HQ workspace controls">
          <VirtualRoomControls client={client} openChat={() => onWorkspaceViewChange('chat')} />

          <div
            id="workspace-scene-tools-slot"
            className="workspace-scene-tools"
            role="group"
            aria-label="Scene tools"
          />
          <div className="workspace-view-switcher" aria-label="Camera view">
            <div id="workspace-camera-slot" className="workspace-tool-slot" />
          </div>
        </div>
      </div>
    </main>
  )
}
