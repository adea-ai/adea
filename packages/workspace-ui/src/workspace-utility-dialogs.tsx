import type { AgentHqApiClient } from '@adea-ai/api-client'
import { settledData, useWorkspaceSearchQuery } from '@adea-ai/data'
import type {
  AgentSummary,
  ArtifactSummary,
  ChannelSummary,
  RoomSummary,
  TaskSummary,
  WorkspaceSearchResult,
} from '@adea-ai/types'
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
} from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { keyedRows } from './keyed-rows'

import { ModalDialog } from './modal-dialog'
import { fuzzySearchMatch, searchKeyboardSelection } from './workspace-model'
import type { PrivateContentResolver } from './platform'

type SearchResult = WorkspaceSearchResult

const searchResultIcon = (kind: SearchResult['kind']) =>
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

export function WorkspaceSearchDialog(props: {
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channels: readonly ChannelSummary[]
  client: AgentHqApiClient
  onClose: () => void
  online: boolean
  onSelect: (result: SearchResult) => void
  open: boolean
  privateContent?: PrivateContentResolver
  rooms: readonly RoomSummary[]
  scopeChannelId?: string
  tasks: readonly TaskSummary[]
  workspaceId: string
}) {
  const [query, setQuery] = createSignal('')
  const [debouncedQuery, setDebouncedQuery] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [localResults, setLocalResults] = createSignal<readonly SearchResult[]>([])
  const [localSearching, setLocalSearching] = createSignal(false)
  const [selected, setSelected] = createSignal<HTMLButtonElement>()

  createEffect(() => {
    const value = query()
    const timeout = window.setTimeout(() => setDebouncedQuery(value.trim()), 180)
    onCleanup(() => window.clearTimeout(timeout))
  })

  const remote = useWorkspaceSearchQuery(
    props.client,
    () => props.workspaceId,
    debouncedQuery,
    () => props.scopeChannelId
  )

  createEffect(() => {
    let active = true
    const workspaceId = props.workspaceId
    const privateContent = props.privateContent
    const scopeChannelId = props.scopeChannelId
    const tasks = props.tasks
    const term = debouncedQuery()
    if (!privateContent?.search || term.length < 2) {
      setLocalResults([])
      setLocalSearching(false)
      return
    }
    setLocalSearching(true)
    void privateContent
      .search({ limit: 20, query: term, workspaceId })
      .then(async (matches) => {
        const resolved = await Promise.all(
          matches.map(async (match): Promise<SearchResult | null> => {
            if (match.messageId) {
              try {
                const { message } = await props.client.getMessage(workspaceId, match.messageId)
                if (scopeChannelId && message.channelId !== scopeChannelId) return null
                return {
                  channelId: message.channelId,
                  id: match.contentId,
                  kind: 'message',
                  label: match.snippet,
                  messageId: message.id,
                  secondary: 'Private message · this device only',
                  ...(message.taskId ? { taskId: message.taskId } : {}),
                  ...(message.threadRootMessageId
                    ? { threadRootMessageId: message.threadRootMessageId }
                    : {}),
                  workspaceId,
                }
              } catch {
                return null
              }
            }
            if (match.taskId) {
              const task = tasks.find(({ id }) => id === match.taskId)
              return task
                ? {
                    id: task.id,
                    kind: 'task',
                    label: task.title,
                    secondary: `${match.snippet} · private task content on this device`,
                    taskId: task.id,
                    workspaceId,
                  }
                : null
            }
            return null
          })
        )
        if (active)
          setLocalResults(resolved.filter((result): result is SearchResult => Boolean(result)))
      })
      .catch(() => {
        if (active) setLocalResults([])
      })
      .finally(() => {
        if (active) setLocalSearching(false)
      })
    onCleanup(() => {
      active = false
    })
  })

  const quickResults = createMemo(() => {
    const all: SearchResult[] = [
      ...props.rooms.map((room) => ({
        id: room.id,
        kind: 'room' as const,
        label: room.name,
        secondary: 'Room',
        workspaceId: props.workspaceId,
      })),
      ...props.channels.map((channel) => ({
        id: channel.id,
        kind: 'channel' as const,
        label: channel.title,
        secondary:
          channel.kind === 'room'
            ? 'Room conversation'
            : channel.kind === 'direct_agent'
              ? 'Direct Agent conversation'
              : 'Group conversation',
        workspaceId: props.workspaceId,
      })),
      ...props.agents.map((agent) => ({
        id: agent.id,
        kind: 'agent' as const,
        label: agent.name,
        secondary: agent.roleSummary ?? 'Agent',
        workspaceId: props.workspaceId,
      })),
      ...props.tasks.map((task) => ({
        id: task.id,
        kind: 'task' as const,
        label: task.title,
        secondary:
          task.objective ??
          (task.objectiveContentRefId
            ? 'Private objective unavailable on this device'
            : 'Objective unavailable'),
        workspaceId: props.workspaceId,
      })),
      ...props.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: 'artifact' as const,
        label: artifact.filename,
        secondary: artifact.mediaType,
        taskId: artifact.taskId,
        workspaceId: props.workspaceId,
      })),
      {
        id: 'mark-all-read',
        kind: 'action' as const,
        label: 'Mark all conversations read',
        secondary: 'Read-state action · Mod+Shift+A',
        workspaceId: props.workspaceId,
      },
      {
        id: 'workspace-settings',
        kind: 'settings' as const,
        label: 'Workspace settings',
        secondary: 'Account, appearance, input, privacy, and capabilities',
        workspaceId: props.workspaceId,
      },
    ]
    return all.slice(0, 30)
  })

  const results = createMemo(() => {
    const debounced = debouncedQuery()
    const paletteMatches = quickResults().filter(
      (result) =>
        !props.scopeChannelId &&
        ['action', 'settings'].includes(result.kind) &&
        fuzzySearchMatch(`${result.label} ${result.secondary}`, debounced)
    )
    if (debounced.length >= 2)
      return [...paletteMatches, ...localResults(), ...(settledData(remote)?.results ?? [])]
    if (props.scopeChannelId) return []
    if (debounced)
      return quickResults().filter((result) =>
        fuzzySearchMatch(`${result.label} ${result.secondary}`, debounced)
      )
    return quickResults()
  })
  // Result sets churn per keystroke; keying rows keeps DOM (and selection
  // scroll position) stable for results that survive the merge.
  const resultRows = keyedRows(results, (result) => `${result.kind}:${result.id}`)

  createEffect(() => {
    void debouncedQuery()
    void props.scopeChannelId
    setSelectedIndex(0)
  })

  createEffect(() => {
    void selectedIndex()
    selected()?.scrollIntoView({ block: 'nearest' })
  })

  const select = (result: SearchResult) => {
    props.onSelect(result)
    props.onClose()
  }

  return (
    <ModalDialog
      open={props.open}
      onClose={props.onClose}
      title={props.scopeChannelId ? 'Search this conversation' : 'Search workspace'}
      description="Search Rooms, conversations, Agents, Tasks, Artifacts, and cloud-safe message text."
    >
      <label class="conventional-search-field">
        <Search aria-hidden="true" />
        <span class="visually-hidden">Search workspace</span>
        <input
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Find a Room, conversation, Agent, or Task"
          autofocus
          aria-controls="workspace-search-results"
          aria-activedescendant={
            results()[selectedIndex()] ? `search-result-${selectedIndex()}` : undefined
          }
          onKeyDown={(event) => {
            const keyboard = searchKeyboardSelection(event.key, selectedIndex(), results().length)
            if (keyboard.action === 'move') {
              event.preventDefault()
              setSelectedIndex(keyboard.index)
            } else if (keyboard.action === 'open' && results()[keyboard.index]) {
              event.preventDefault()
              select(results()[keyboard.index]!)
            }
          }}
        />
      </label>
      <ul
        id="workspace-search-results"
        class="conventional-search-results"
        role="listbox"
        aria-label="Search results"
        aria-live="polite"
      >
        <For each={resultRows()}>
          {(entry, index) => {
            const result = entry.item
            return (
              <li role="presentation">
                <button
                  id={`search-result-${index()}`}
                  ref={index() === selectedIndex() ? setSelected : undefined}
                  type="button"
                  role="option"
                  aria-selected={index() === selectedIndex()}
                  onMouseEnter={() => setSelectedIndex(index())}
                  onClick={() => select(result())}
                >
                  {searchResultIcon(result().kind)}
                  <span>
                    <strong>{result().label}</strong>
                    <small>{result().secondary}</small>
                  </span>
                </button>
              </li>
            )
          }}
        </For>
      </ul>
      <Show when={(remote.isFetching || localSearching()) && debouncedQuery().length >= 2}>
        <p class="conventional-dialog-empty" role="status">
          Searching…
        </p>
      </Show>
      <Show when={settledData(remote)?.privateResultsUnavailable}>
        <p class="conventional-dialog-empty" role="status">
          {props.privateContent?.search
            ? 'Cloud results exclude private bodies; this authorized device was searched separately.'
            : 'Private local content can only be searched on its trusted desktop device.'}
        </p>
      </Show>
      <Show
        when={!props.online && debouncedQuery().length >= 2}
        fallback={
          <Show when={remote.isError}>
            <p class="conventional-dialog-empty" role="alert">
              Search is temporarily unavailable. Your query was not lost.
            </p>
          </Show>
        }
      >
        <p class="conventional-dialog-empty" role="status">
          Offline. Quick navigation remains available; search will retry after reconnecting.
        </p>
      </Show>
      <Show when={!remote.isFetching && !localSearching() && !results().length}>
        <p class="conventional-dialog-empty">No workspace item matches “{query()}”.</p>
      </Show>
      <p class="conventional-search-hint">↑↓ move · Enter open · Esc close</p>
    </ModalDialog>
  )
}

export type { SearchResult }
