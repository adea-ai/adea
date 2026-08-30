import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHqApiClient } from '@agent-hq/api-client'
import { useWorkspaceSearchQuery } from '@agent-hq/data'
import type {
  AgentSummary,
  ArtifactSummary,
  ChannelSummary,
  RoomSummary,
  TaskSummary,
  WorkspaceSearchResult,
} from '@agent-hq/types'
import { MusicToggle } from '@agent-hq/audio'
import { ThemeToggle } from '@agent-hq/ui/components/theme-toggle'
import {
  Bot,
  CheckCheck,
  DoorOpen,
  FileText,
  Hash,
  ListTodo,
  MessageSquare,
  Search,
  Settings,
} from 'lucide-react'

import { ModalDialog } from './modal-dialog'
import { fuzzySearchMatch, searchKeyboardSelection } from './workspace-model'

type SearchResult = WorkspaceSearchResult

export function WorkspaceSearchDialog({
  agents,
  artifacts,
  channels,
  client,
  onClose,
  online,
  onSelect,
  open,
  rooms,
  scopeChannelId,
  tasks,
  workspaceId,
}: Readonly<{
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channels: readonly ChannelSummary[]
  client: AgentHqApiClient
  onClose: () => void
  online: boolean
  onSelect: (result: SearchResult) => void
  open: boolean
  rooms: readonly RoomSummary[]
  scopeChannelId?: string
  tasks: readonly TaskSummary[]
  workspaceId: string
}>) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 180)
    return () => window.clearTimeout(timeout)
  }, [query])
  const remote = useWorkspaceSearchQuery(client, workspaceId, debouncedQuery, scopeChannelId)
  const quickResults = useMemo(() => {
    const all: SearchResult[] = [
      ...rooms.map((room) => ({
        id: room.id,
        kind: 'room' as const,
        label: room.name,
        secondary: 'Room',
        workspaceId,
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
        workspaceId,
      })),
      ...agents.map((agent) => ({
        id: agent.id,
        kind: 'agent' as const,
        label: agent.name,
        secondary: agent.roleSummary ?? 'Agent',
        workspaceId,
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
        workspaceId,
      })),
      ...artifacts.map((artifact) => ({
        id: artifact.id,
        kind: 'artifact' as const,
        label: artifact.filename,
        secondary: artifact.mediaType,
        taskId: artifact.taskId,
        workspaceId,
      })),
      {
        id: 'mark-all-read',
        kind: 'action' as const,
        label: 'Mark all conversations read',
        secondary: 'Read-state action · Mod+Shift+A',
        workspaceId,
      },
      {
        id: 'workspace-settings',
        kind: 'settings' as const,
        label: 'Workspace settings',
        secondary: 'Appearance, sound, and account',
        workspaceId,
      },
    ]
    return all.slice(0, 30)
  }, [agents, artifacts, channels, rooms, tasks, workspaceId])
  const paletteMatches = quickResults.filter(
    (result) =>
      !scopeChannelId &&
      ['action', 'settings'].includes(result.kind) &&
      fuzzySearchMatch(`${result.label} ${result.secondary}`, debouncedQuery)
  )
  const results =
    debouncedQuery.length >= 2
      ? [...paletteMatches, ...(remote.data?.results ?? [])]
      : scopeChannelId
        ? []
        : debouncedQuery
          ? quickResults.filter((result) =>
              fuzzySearchMatch(`${result.label} ${result.secondary}`, debouncedQuery)
            )
          : quickResults
  useEffect(() => {
    setSelectedIndex(0)
  }, [debouncedQuery, scopeChannelId])
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])
  const select = (result: SearchResult) => {
    onSelect(result)
    onClose()
  }
  const icon = (kind: SearchResult['kind']) =>
    kind === 'agent' ? (
      <Bot aria-hidden="true" />
    ) : kind === 'room' ? (
      <DoorOpen aria-hidden="true" />
    ) : kind === 'task' ? (
      <ListTodo aria-hidden="true" />
    ) : kind === 'artifact' ? (
      <FileText aria-hidden="true" />
    ) : kind === 'message' ? (
      <MessageSquare aria-hidden="true" />
    ) : kind === 'action' ? (
      <CheckCheck aria-hidden="true" />
    ) : kind === 'settings' ? (
      <Settings aria-hidden="true" />
    ) : (
      <Hash aria-hidden="true" />
    )
  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={scopeChannelId ? 'Search this conversation' : 'Search workspace'}
      description="Search Rooms, conversations, Agents, Tasks, Artifacts, and cloud-safe message text."
    >
      <label className="conventional-search-field">
        <Search aria-hidden="true" />
        <span className="visually-hidden">Search workspace</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a Room, conversation, Agent, or Task"
          autoFocus
          aria-controls="workspace-search-results"
          aria-activedescendant={
            results[selectedIndex] ? `search-result-${selectedIndex}` : undefined
          }
          onKeyDown={(event) => {
            const keyboard = searchKeyboardSelection(event.key, selectedIndex, results.length)
            if (keyboard.action === 'move') {
              event.preventDefault()
              setSelectedIndex(keyboard.index)
            } else if (keyboard.action === 'open' && results[keyboard.index]) {
              event.preventDefault()
              select(results[keyboard.index])
            }
          }}
        />
      </label>
      <ul
        id="workspace-search-results"
        className="conventional-search-results"
        role="listbox"
        aria-label="Search results"
        aria-live="polite"
      >
        {results.map((result, index) => (
          <li key={`${result.kind}:${result.id}`} role="presentation">
            <button
              id={`search-result-${index}`}
              ref={index === selectedIndex ? selectedRef : undefined}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => select(result)}
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
      {remote.isFetching && debouncedQuery.length >= 2 ? (
        <p className="conventional-dialog-empty" role="status">
          Searching…
        </p>
      ) : null}
      {remote.data?.privateResultsUnavailable ? (
        <p className="conventional-dialog-empty" role="status">
          Private local content can only be searched on its trusted desktop device.
        </p>
      ) : null}
      {!online && debouncedQuery.length >= 2 ? (
        <p className="conventional-dialog-empty" role="status">
          Offline. Quick navigation remains available; search will retry after reconnecting.
        </p>
      ) : remote.isError ? (
        <p className="conventional-dialog-empty" role="alert">
          Search is temporarily unavailable. Your query was not lost.
        </p>
      ) : null}
      {!remote.isFetching && !results.length ? (
        <p className="conventional-dialog-empty">No workspace item matches “{query}”.</p>
      ) : null}
      <p className="conventional-search-hint">↑↓ move · Enter open · Esc close</p>
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
