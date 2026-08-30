import { useMemo, useState } from 'react'
import type { AgentSummary, ChannelSummary, RoomSummary, TaskSummary } from '@agent-hq/types'
import { MusicToggle } from '@agent-hq/audio'
import { ThemeToggle } from '@agent-hq/ui/components/theme-toggle'
import { Bot, DoorOpen, Hash, ListTodo, Search } from 'lucide-react'

import { ModalDialog } from './modal-dialog'

type SearchResult = Readonly<{
  id: string
  kind: 'agent' | 'channel' | 'room' | 'task'
  label: string
  secondary: string
}>

export function WorkspaceSearchDialog({
  agents,
  channels,
  onClose,
  onSelect,
  open,
  rooms,
  tasks,
}: Readonly<{
  agents: readonly AgentSummary[]
  channels: readonly ChannelSummary[]
  onClose: () => void
  onSelect: (result: SearchResult) => void
  open: boolean
  rooms: readonly RoomSummary[]
  tasks: readonly TaskSummary[]
}>) {
  const [query, setQuery] = useState('')
  const results = useMemo(() => {
    const all: SearchResult[] = [
      ...rooms.map((room) => ({
        id: room.id,
        kind: 'room' as const,
        label: room.name,
        secondary: 'Room',
      })),
      ...channels.map((channel) => ({
        id: channel.id,
        kind: 'channel' as const,
        label: channel.title,
        secondary:
          channel.kind === 'room'
            ? 'Room conversation'
            : channel.kind === 'direct_agent'
              ? 'Direct Agent conversation'
              : 'Group conversation',
      })),
      ...agents.map((agent) => ({
        id: agent.id,
        kind: 'agent' as const,
        label: agent.name,
        secondary: agent.roleSummary ?? 'Agent',
      })),
      ...tasks.map((task) => ({
        id: task.id,
        kind: 'task' as const,
        label: task.title,
        secondary:
          task.objective ??
          (task.objectiveContentRefId
            ? 'Private objective unavailable on this device'
            : 'Objective unavailable'),
      })),
    ]
    const normalized = query.trim().toLocaleLowerCase()
    return (
      normalized
        ? all.filter((result) =>
            `${result.label} ${result.secondary}`.toLocaleLowerCase().includes(normalized)
          )
        : all
    ).slice(0, 30)
  }, [agents, channels, query, rooms, tasks])
  const icon = (kind: SearchResult['kind']) =>
    kind === 'agent' ? (
      <Bot aria-hidden="true" />
    ) : kind === 'room' ? (
      <DoorOpen aria-hidden="true" />
    ) : kind === 'task' ? (
      <ListTodo aria-hidden="true" />
    ) : (
      <Hash aria-hidden="true" />
    )
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Search loaded workspace"
      description="M2.8 adds durable workspace-wide search. This finds currently loaded Rooms, conversations, Agents, and Tasks."
    >
      <label className="conventional-search-field">
        <Search aria-hidden="true" />
        <span className="visually-hidden">Search workspace</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a Room, conversation, Agent, or Task"
          autoFocus
        />
      </label>
      <ul className="conventional-search-results" aria-live="polite">
        {results.map((result) => (
          <li key={`${result.kind}:${result.id}`}>
            <button
              type="button"
              onClick={() => {
                onSelect(result)
                onClose()
              }}
            >
              {icon(result.kind)}
              <span>
                <strong>{result.label}</strong>
                <small>{result.secondary}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!results.length ? (
        <p className="conventional-dialog-empty">No loaded workspace item matches “{query}”.</p>
      ) : null}
    </ModalDialog>
  )
}

export function WorkspaceSettingsDialog({
  accountAuthenticated,
  accountLabel,
  busy,
  onClose,
  onSignIn,
  onSignOut,
  open,
}: Readonly<{
  accountAuthenticated: boolean
  accountLabel: string
  busy: boolean
  onClose: () => void
  onSignIn: () => void
  onSignOut: () => void
  open: boolean
}>) {
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Workspace settings"
      description="Appearance, sound, account, and the retained spatial preview."
    >
      <div className="conventional-settings-list">
        <section>
          <div>
            <h3>Appearance</h3>
            <p>Use the system theme or choose light/dark mode.</p>
          </div>
          <ThemeToggle />
        </section>
        <section>
          <div>
            <h3>Sound</h3>
            <p>Control the optional workspace soundtrack.</p>
          </div>
          <MusicToggle />
        </section>
        <section>
          <div>
            <h3>Account</h3>
            <p>
              {accountAuthenticated
                ? `${accountLabel} · workspace saved`
                : 'Guest workspace · sign in anytime'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={accountAuthenticated ? onSignOut : onSignIn}
          >
            {accountAuthenticated ? 'Sign out' : 'Sign in'}
          </button>
        </section>
        <section>
          <div>
            <h3>Spatial preview</h3>
            <p>
              The existing Three.js workspace remains available without defining M2 product state.
            </p>
          </div>
          <a href="/?view=spatial">Open preview</a>
        </section>
      </div>
    </ModalDialog>
  )
}

export type { SearchResult }
