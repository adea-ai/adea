import { hqHomeManifest, hqWorkManifest } from '@agent-hq/hq-scenes'
import { HqRoomScene } from '@agent-hq/hq-scenes/runtime'
import { MusicToggle } from '@agent-hq/audio'
import type { AgentHqApiClient } from '@agent-hq/api-client'
import { Button } from '@agent-hq/ui/components/ui/button'
import { WorkspaceBrand } from '@agent-hq/ui/components/workspace-brand'
import {
  VirtualRoomControls,
  WorkspaceViewToggle,
  type WorkspaceView,
} from '@agent-hq/workspace-ui'
import { BriefcaseBusiness, Home } from 'lucide-react'
import { useState } from 'react'

import type { DesktopWorkspaceBootstrap } from './workspace-session'
import { VersionDialog } from './version-dialog'

type DesktopWorkspaceProps = Readonly<{
  authenticated: boolean
  busy: boolean
  client: AgentHqApiClient
  message: string
  onRetry(): void
  onSignIn(): void
  onSignOut(): void
  onWorkspaceViewChange(view: WorkspaceView): void
  status: string
  workspaceView: WorkspaceView
  workspaceState: DesktopWorkspaceBootstrap
}>

export function DesktopWorkspace({
  authenticated,
  busy,
  client,
  message,
  onRetry,
  onSignIn,
  onSignOut,
  onWorkspaceViewChange,
  status,
  workspaceView,
  workspaceState,
}: DesktopWorkspaceProps) {
  const [scene, setScene] = useState<'home' | 'work'>(workspaceState.workspace.scene)
  const manifest = scene === 'work' ? hqWorkManifest : hqHomeManifest
  const accountLabel = authenticated
    ? (workspaceState.accountLabel ?? 'Account')
    : status === 'waiting'
      ? 'Signing in…'
      : 'Sign in'
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
          initialCharacter="cashier"
          manifest={manifest}
          cameraViewMode="orthographic"
          accountTargetId="workspace-account-slot"
          accountLabel={accountLabel}
          accountAuthenticated={authenticated}
          accountBusy={busy}
          accountMusicControl={<MusicToggle />}
          onAccountSignIn={onSignIn}
          onAccountSignOut={onSignOut}
          cameraTargetId="workspace-camera-slot"
          roomDesignerTargetId="workspace-scene-tools-slot"
          sceneEditorTargetId="workspace-scene-tools-slot"
        />

        <div className="workspace-ui" aria-label="Agent HQ workspace controls">
          <header className="workspace-topbar">
            <WorkspaceBrand title={workspaceState.workspace.name} />

            <nav className="workspace-scene-nav" aria-label="HQ spaces">
              {(['home', 'work'] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  className={`workspace-scene-tab${scene === option ? ' workspace-scene-tab--selected' : ''}`}
                  aria-pressed={scene === option}
                  variant={scene === option ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setScene(option)}
                >
                  {option === 'home' ? (
                    <Home size={14} aria-hidden="true" />
                  ) : (
                    <BriefcaseBusiness size={14} aria-hidden="true" />
                  )}
                  {option === 'home' ? 'Home' : 'Work'}
                </Button>
              ))}
            </nav>

            <div className="workspace-topbar__actions">
              <WorkspaceViewToggle onChange={onWorkspaceViewChange} value={workspaceView} />
              <div id="workspace-account-slot" className="workspace-account-slot" />
              {(status === 'offline' || status === 'failed') && (
                <button type="button" onClick={onRetry} disabled={busy}>
                  Try again
                </button>
              )}
            </div>
          </header>

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
