import type { AgentHqApiClient } from '@adea-ai/api-client'
import { settledData, useWorkspaceSearchQuery } from '@adea-ai/data'
import type {
  AgentSummary,
  ArtifactSummary,
  ChannelSummary,
  ProjectSummary,
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
  Settings,
} from 'lucide-solid'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { keyedRows } from './keyed-rows'

import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { fuzzySearchMatch } from './workspace-model'
import type { PrivateContentResolver } from './platform'
import {
  Command,
  CommandHint,
  CommandInput,
  CommandItem,
  CommandList,
  CommandStatus,
} from '@adea-ai/ui/components/ui/command'

type SearchResult = WorkspaceSearchResult

const searchResultIcon = (kind: SearchResult['kind']) =>
  kind === 'agent' ? (
    <Bot aria-hidden="true" />
  ) : kind === 'project' ? (
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

/**
 * cmdk resolves `aria-activedescendant` through an `encodeURIComponent()`d
 * `data-value` selector while items register their value raw, so the key has
 * to survive `encodeURIComponent` unchanged or the combobox loses its active
 * option for any result whose id contains a reserved character.
 */
const searchResultKey = (result: SearchResult) =>
  encodeURIComponent(`${result.kind}:${result.id}`).replaceAll('%', '_')

export function WorkspaceSearchDialog(props: {
  agents: readonly AgentSummary[]
  artifacts: readonly ArtifactSummary[]
  channels: readonly ChannelSummary[]
  client: AgentHqApiClient
  /** Fires on hover/focus of a result — prefetch its destination. */
  onChannelIntent?: (channelId: string) => void
  onClose: () => void
  online: boolean
  onSelect: (result: SearchResult) => void
  open: boolean
  privateContent?: PrivateContentResolver
  projects: readonly ProjectSummary[]
  scopeChannelId?: string
  tasks: readonly TaskSummary[]
  workspaceId: string
}) {
  const [query, setQuery] = createSignal('')
  const [debouncedQuery, setDebouncedQuery] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [localResults, setLocalResults] = createSignal<readonly SearchResult[]>([])
  const [localSearching, setLocalSearching] = createSignal(false)
  let lastChannelIntent: string | undefined

  function prefetchChannel(channelId: string): void {
    if (lastChannelIntent === channelId) return
    lastChannelIntent = channelId
    props.onChannelIntent?.(channelId)
  }

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
      ...props.projects.map((project) => ({
        id: project.id,
        kind: 'project' as const,
        label: project.name,
        secondary: 'Project',
        workspaceId: props.workspaceId,
      })),
      ...props.channels.map((channel) => ({
        id: channel.id,
        kind: 'channel' as const,
        label: channel.title,
        secondary:
          channel.kind === 'project'
            ? 'Project conversation'
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
  const resultRows = keyedRows(results, searchResultKey)

  createEffect(() => {
    void debouncedQuery()
    void props.scopeChannelId
    setSelectedIndex(0)
  })

  const select = (result: SearchResult) => {
    props.onSelect(result)
    props.onClose()
  }

  return (
    <ModalDialog
      modal={false}
      class="max-h-full overflow-y-auto"
      open={props.open}
      onClose={props.onClose}
      title={props.scopeChannelId ? 'Search this conversation' : 'Search workspace'}
      description="Search Projects, conversations, Agents, Tasks, Artifacts, and cloud-safe message text."
    >
      {/* The host owns ranking across quick destinations, local private hits,
          and remote hits; cmdk only owns selection and keyboard behavior. */}
      <Command
        class="h-auto"
        label="Search workspace"
        shouldFilter={false}
        vimBindings={false}
        value={resultRows()[selectedIndex()]?.key ?? ''}
        onValueChange={(value) => {
          const index = resultRows().findIndex((entry) => entry.key === value)
          if (index < 0) return
          setSelectedIndex(index)
          const result = resultRows()[index]?.item()
          if (result?.kind === 'channel') prefetchChannel(result.id)
        }}
      >
        <CommandInput
          value={query()}
          onValueChange={setQuery}
          placeholder="Find a Project, conversation, Agent, or Task"
          autofocus
        />
        <CommandList class="max-h-72" label="Search results" aria-live="polite">
          <For each={resultRows()}>
            {(entry) => {
              const result = entry.item
              const channelId = () => {
                const item = result()
                return item.kind === 'channel' ? item.id : undefined
              }
              return (
                <CommandItem
                  value={entry.key}
                  onSelect={() => select(result())}
                  onPointerEnter={() => {
                    const id = channelId()
                    if (id) prefetchChannel(id)
                  }}
                  onPointerLeave={() => {
                    const id = channelId()
                    if (id && lastChannelIntent === id) lastChannelIntent = undefined
                  }}
                >
                  {searchResultIcon(result().kind)}
                  <span>
                    <strong class="font-semibold">{result().label}</strong>{' '}
                    <small class="text-xs text-muted-foreground">{result().secondary}</small>
                  </span>
                </CommandItem>
              )
            }}
          </For>
        </CommandList>
      </Command>
      <Show when={(remote.isFetching || localSearching()) && debouncedQuery().length >= 2}>
        <CommandStatus role="status">Searching…</CommandStatus>
      </Show>
      <Show when={settledData(remote)?.privateResultsUnavailable}>
        <CommandStatus role="status">
          {props.privateContent?.search
            ? 'Cloud results exclude private bodies; this authorized device was searched separately.'
            : 'Private local content can only be searched on its trusted desktop device.'}
        </CommandStatus>
      </Show>
      <Show
        when={!props.online && debouncedQuery().length >= 2}
        fallback={
          <Show when={remote.isError}>
            <CommandStatus role="alert">
              Search is temporarily unavailable. Your query was not lost.
            </CommandStatus>
          </Show>
        }
      >
        <CommandStatus role="status">
          Offline. Quick navigation remains available; search will retry after reconnecting.
        </CommandStatus>
      </Show>
      <Show when={!remote.isFetching && !localSearching() && !results().length}>
        <CommandStatus>No workspace item matches “{query()}”.</CommandStatus>
      </Show>
      <CommandHint>↑↓ move · Enter open · Esc close</CommandHint>
    </ModalDialog>
  )
}

export type { SearchResult }
