import { hqHomeManifest, hqWorkManifest } from '@agent-hq/hq-scenes'
import { HqRoomScene } from '@agent-hq/hq-scenes/runtime'
import type { AgentHqApiClient } from '@agent-hq/api-client'
import { VirtualRoomControls, type WorkspaceView } from '@agent-hq/workspace-ui'

import { VersionDialog } from './version-dialog'

type DesktopWorkspaceProps = Readonly<{
  client: AgentHqApiClient
  message: string
  onWorkspaceViewChange(view: WorkspaceView): void
  status: string
  scene: 'home' | 'work'
}>

export function DesktopWorkspace({
  client,
  message,
  onWorkspaceViewChange,
  status,
  scene,
}: DesktopWorkspaceProps) {
  const manifest = scene === 'work' ? hqWorkManifest : hqHomeManifest
  const statusLabel =
    status === 'authenticated'
      ? 'Saved'
      : status === 'offline'
        ? 'Offline'
        : status === 'failed'
          ? 'Sign-in issue'
          : status === 'opening' || status === 'waiting'
            ? 'Signing in'
            : 'Online'

  return (
    <main className="workspace-shell workspace-shell--desktop">
      <div className="workspace-scene-viewport">
        <HqRoomScene
          key={scene}
          initialCharacter="cartoon-standard"
          manifest={manifest}
          cameraViewMode="orthographic"
          showAccountDrawer={false}
          cameraTargetId="workspace-camera-slot"
          roomDesignerTargetId="workspace-scene-tools-slot"
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

        <footer className="workspace-statusbar" aria-label="Agent HQ status bar">
          <div
            className="workspace-statusbar__meta"
            role="status"
            aria-live="polite"
            title={message}
          >
            <span
              className={`workspace-status__dot workspace-status__dot--${status}`}
              aria-hidden="true"
            />
            <span>{statusLabel}</span>
            <span className="sr-only">{message}</span>
          </div>
          <VersionDialog />
        </footer>
      </div>
    </main>
  )
}
