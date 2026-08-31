'use client'

import type { WorkspaceSummary } from '@agent-hq/types'
import { Button } from '@agent-hq/ui/components/ui/button'
import { Separator } from '@agent-hq/ui/components/ui/separator'
import {
  Bell,
  BriefcaseBusiness,
  Home,
  Map,
  MessageSquareText,
  Plug,
  Search,
  UserRound,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { WorkspaceView } from './workspace-view-toggle'

type RailActionProps = Readonly<{
  active?: boolean
  icon: typeof Home
  label: string
  onClick: () => void
}>

function RailAction({ active = false, icon: Icon, label, onClick }: RailActionProps) {
  return (
    <Button
      type="button"
      className="global-rail__button"
      variant={active ? 'secondary' : 'ghost'}
      size="icon-lg"
      aria-label={label}
      aria-pressed={active || undefined}
      title={label}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}

function WorkspaceMark({ workspace }: Readonly<{ workspace?: WorkspaceSummary }>) {
  const Icon = workspace?.scene === 'home' ? Home : BriefcaseBusiness
  return <Icon aria-hidden="true" />
}

export function GlobalWorkspaceRail({
  onOpenNotifications,
  onOpenPlugins,
  onOpenSearch,
  onOpenSettings,
  onWorkspaceChange,
  onViewChange,
  activeWorkspace,
  view,
  workspaces,
}: Readonly<{
  activeWorkspace?: WorkspaceSummary
  onOpenNotifications: () => void
  onOpenPlugins: () => void
  onOpenSearch: () => void
  onOpenSettings: () => void
  onWorkspaceChange: (workspace: WorkspaceSummary) => void
  onViewChange: (view: WorkspaceView) => void
  view: WorkspaceView
  workspaces: readonly WorkspaceSummary[]
}>) {
  const activeWorkspaceLabel = activeWorkspace?.name ?? 'Loading'
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const workspaceMenuId = useId()
  const workspaceMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!workspaceMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWorkspaceMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [workspaceMenuOpen])

  return (
    <nav className="global-rail" aria-label="Global navigation">
      <div className="global-rail__workspace" ref={workspaceMenuRef}>
        <Button
          type="button"
          className="global-rail__workspace-trigger"
          variant="default"
          size="icon-lg"
          aria-controls={workspaceMenuId}
          aria-expanded={workspaceMenuOpen}
          aria-haspopup="menu"
          aria-label={`Switch workspace, current ${activeWorkspaceLabel}`}
          title="Switch workspace"
          onClick={() => setWorkspaceMenuOpen((open) => !open)}
        >
          <WorkspaceMark workspace={activeWorkspace} />
        </Button>
        {workspaceMenuOpen ? (
          <div className="global-rail__workspace-menu" id={workspaceMenuId} role="menu">
            <p className="global-rail__workspace-label">Workspaces</p>
            {workspaces.map((workspace) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={workspace.id === activeWorkspace?.id}
                key={workspace.id}
                onClick={() => {
                  onWorkspaceChange(workspace)
                  setWorkspaceMenuOpen(false)
                }}
              >
                <WorkspaceMark workspace={workspace} />
                <span className="global-rail__workspace-name">{workspace.name}</span>
                <span className="global-rail__workspace-kind">{workspace.scene}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="global-rail__search">
        <RailAction icon={Search} label="Search workspace" onClick={onOpenSearch} />
        <kbd aria-hidden="true">⌘K</kbd>
      </div>

      <Separator className="global-rail__separator" />

      <div className="global-rail__views" role="group" aria-label="Workspace views">
        <RailAction
          active={view === 'virtual'}
          icon={Map}
          label="Virtual view"
          onClick={() => onViewChange('virtual')}
        />
        <RailAction
          active={view === 'chat'}
          icon={MessageSquareText}
          label="Chat view"
          onClick={() => onViewChange('chat')}
        />
        <RailAction icon={Bell} label="Notifications" onClick={onOpenNotifications} />
      </div>

      <div className="global-rail__footer">
        <RailAction icon={Plug} label="Plugins" onClick={onOpenPlugins} />
        <RailAction icon={UserRound} label="User settings" onClick={onOpenSettings} />
      </div>
    </nav>
  )
}
