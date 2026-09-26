import type { AgentSummary, RoomSummary, TaskSummary } from '@adea-ai/types'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronsUp,
  MessageCircle,
  Minus,
  Play,
  Plus,
  Send,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-solid'
import { createMemo, createSignal, For, Show } from 'solid-js'

import { Button } from '@adea-ai/ui/components/ui/button'
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '@adea-ai/app-ui/components/ui/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@adea-ai/app-ui/components/ui/dropdown-menu'
import { Separator } from '@adea-ai/app-ui/components/ui/separator'

import type { PrivateContentResolver } from './platform'
import { keyedRows } from './keyed-rows'
import { RoomIcon } from './room-icon'

type Props = Readonly<{
  agents: readonly AgentSummary[]
  busy: boolean
  onArchive: (task: TaskSummary) => Promise<void>
  onAssign: (task: TaskSummary, agentId: string | null) => Promise<void>
  onCancel: (task: TaskSummary) => Promise<void>
  onClose: () => void
  onComplete: (task: TaskSummary) => Promise<void>
  onDependencies: (task: TaskSummary, dependencyIds: readonly string[]) => Promise<void>
  onMoveRoom: (task: TaskSummary, roomId: string | null) => Promise<void>
  onOpenConversation: (task: TaskSummary) => void
  onQueue: (task: TaskSummary) => Promise<void>
  onReview: (task: TaskSummary) => Promise<void>
  onStart: (task: TaskSummary) => Promise<void>
  onUpdate: (
    task: TaskSummary,
    update: Readonly<{
      kind?: TaskSummary['kind']
      objective?: string
      priority?: TaskSummary['priority']
      title?: string
    }>
  ) => Promise<void>
  privateContent?: PrivateContentResolver
  rooms: readonly RoomSummary[]
  task: TaskSummary
  tasks: readonly TaskSummary[]
}>

const kindOptions = [
  { value: 'bug' as const, label: 'Bug', Icon: Bug },
  { value: 'feature' as const, label: 'Feature', Icon: Sparkles },
  { value: 'chore' as const, label: 'Chore', Icon: Wrench },
]

const priorityOptions = [
  { value: 'low' as const, label: 'Low', Icon: ArrowDown },
  { value: 'normal' as const, label: 'Normal', Icon: Minus },
  { value: 'high' as const, label: 'High', Icon: ArrowUp },
  { value: 'urgent' as const, label: 'Urgent', Icon: ChevronsUp },
]

export function TaskDetail(props: Props) {
  const [dependencyIds, setDependencyIds] = createSignal<readonly string[]>(
    props.task.dependencyIds
  )
  const [status, setStatus] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  let version = props.task.version
  const [title, setTitle] = createSignal(props.task.title)
  const [objective, setObjective] = createSignal(props.task.objective ?? '')
  const [kind, setKind] = createSignal<TaskSummary['kind']>(props.task.kind ?? 'feature')
  const [priority, setPriority] = createSignal<TaskSummary['priority']>(props.task.priority)
  const [agentId, setAgentId] = createSignal<string | null>(props.task.agentId ?? null)
  const [roomId, setRoomId] = createSignal<string | null>(props.task.roomId ?? null)
  const selectedRoom = createMemo(() =>
    roomId() ? props.rooms.find(({ id }) => id === roomId()) : undefined
  )
  const trimmedTitle = () => title().trim()
  const trimmedObjective = () => objective().trim()
  const titleChanged = () => trimmedTitle() !== props.task.title
  const objectiveChanged = () =>
    (trimmedObjective() || undefined) !== (props.task.objective ?? undefined)
  const kindChanged = () => kind() !== (props.task.kind ?? 'feature')
  const priorityChanged = () => priority() !== props.task.priority
  const agentChanged = () => (agentId() ?? null) !== (props.task.agentId ?? null)
  const roomChanged = () => (roomId() ?? null) !== (props.task.roomId ?? null)
  const dependenciesChanged = () =>
    JSON.stringify([...dependencyIds()].toSorted()) !==
    JSON.stringify([...props.task.dependencyIds].toSorted())
  const detailsChanged = () =>
    (titleChanged() && trimmedTitle().length > 0 && trimmedTitle().length <= 200) ||
    (objectiveChanged() && trimmedObjective().length > 0 && trimmedObjective().length <= 20_000) ||
    kindChanged() ||
    priorityChanged()
  const dirty = () => detailsChanged() || agentChanged() || roomChanged() || dependenciesChanged()
  const [dependencyQuery, setDependencyQuery] = createSignal('')
  const dependencyCandidates = createMemo(() =>
    props.tasks.filter(
      (task) =>
        task.id !== props.task.id &&
        task.title.toLowerCase().includes(dependencyQuery().trim().toLowerCase())
    )
  )
  // Refetches hand these lists fresh object identities; keying by id keeps the
  // open dropdown's rows (and their hover/focus) stable.
  const roomRows = keyedRows(
    () => props.rooms,
    (room) => room.id
  )
  const agentRows = keyedRows(
    () => props.agents,
    (agent) => agent.id
  )
  const dependencyRows = keyedRows(dependencyCandidates, (task) => task.id)
  const toggleDependency = (taskId: string) =>
    setDependencyIds((ids) =>
      ids.includes(taskId) ? ids.filter((id) => id !== taskId) : [...ids, taskId]
    )
  const run = async (action: () => Promise<void>, message: string) => {
    setStatus(null)
    try {
      await action()
      version += 1
      setStatus(message)
    } catch {
      setStatus(
        'This Task changed elsewhere or the request could not be completed. Reload and retry.'
      )
    }
  }
  const runImmediate = (task: TaskSummary, action: (task: TaskSummary) => Promise<void>) =>
    run(() => action({ ...task, version }), '')
  const handleClose = async () => {
    if (saving()) return
    if (!dirty()) {
      props.onClose()
      return
    }
    if (titleChanged() && trimmedTitle().length === 0) {
      setStatus('Task title cannot be empty.')
      return
    }
    setSaving(true)
    setStatus(null)
    try {
      let current: TaskSummary = { ...props.task, version }
      const bump = () => {
        version += 1
        current = { ...current, version }
      }
      const update: {
        kind?: TaskSummary['kind']
        objective?: string
        priority?: TaskSummary['priority']
        title?: string
      } = {}
      if (titleChanged() && trimmedTitle().length > 0 && trimmedTitle().length <= 200)
        update.title = trimmedTitle()
      if (
        objectiveChanged() &&
        trimmedObjective().length > 0 &&
        trimmedObjective().length <= 20_000
      )
        update.objective = trimmedObjective()
      if (kindChanged()) update.kind = kind()
      if (priorityChanged()) update.priority = priority()
      if (Object.keys(update).length) {
        await props.onUpdate(current, update)
        bump()
      }
      if (agentChanged()) {
        await props.onAssign(current, agentId())
        bump()
      }
      if (roomChanged()) {
        await props.onMoveRoom(current, roomId())
        bump()
      }
      if (dependenciesChanged()) {
        await props.onDependencies(current, dependencyIds())
        bump()
      }
      props.onClose()
    } catch {
      setStatus(
        'This Task changed elsewhere or the request could not be completed. Reload and retry.'
      )
      setSaving(false)
    }
  }
  const fieldsDisabled = () => props.busy || saving()
  const selectableState = () =>
    props.task.lifecycleState === 'created' ||
    props.task.lifecycleState === 'queued' ||
    props.task.lifecycleState === 'in_progress' ||
    props.task.lifecycleState === 'in_review'

  return (
    <Drawer
      open
      swipeDirection="right"
      onOpenChange={(open) => {
        if (!open) void handleClose()
      }}
    >
      <DrawerContent style={{ '--drawer-content-width': 'min(29rem, 94vw)' }}>
        <div class="conventional-detail-panel">
          <header>
            <div>
              <span>Task detail</span>
              <DrawerTitle class="sr-only">{props.task.title}</DrawerTitle>
            </div>
            <DrawerClose class="conventional-detail-panel__close" aria-label="Close Task detail">
              <X aria-hidden="true" />
            </DrawerClose>
          </header>
          <label>
            Title
            <input
              value={title()}
              maxLength={200}
              disabled={fieldsDisabled()}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            Description
            <textarea
              rows={4}
              maxLength={20000}
              placeholder={
                props.task.objectiveContentRefId && !props.task.objective
                  ? 'Replace linked content with plain text…'
                  : undefined
              }
              value={objective()}
              disabled={fieldsDisabled()}
              onInput={(event) => setObjective(event.currentTarget.value)}
            />
          </label>
          <Separator class="conventional-detail-panel__divider" />
          <div class="conventional-detail-panel__grid">
            <div class="conventional-detail-panel__field">
              <span class="conventional-detail-panel__label">Type</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  as={Button}
                  variant="outline"
                  disabled={fieldsDisabled()}
                  class="conventional-room-picker"
                >
                  <Show when={kind() === 'bug'} fallback={<KindIconFallback kind={kind()} />}>
                    <Bug aria-hidden="true" />
                  </Show>
                  <span>{kind() === 'bug' ? 'Bug' : kind() === 'chore' ? 'Chore' : 'Feature'}</span>
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  <For each={kindOptions}>
                    {(option) => (
                      <DropdownMenuItem onSelect={() => setKind(option.value)}>
                        <option.Icon aria-hidden="true" />
                        {option.label}
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div class="conventional-detail-panel__field">
              <span
                class="conventional-detail-panel__label"
                id={`task-detail-priority-label-${props.task.id}`}
              >
                Priority
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={fieldsDisabled()}
                  as={Button}
                  variant="outline"
                  class="conventional-room-picker"
                >
                  <PriorityIcon priority={priority()} />
                  <span>
                    {priority() === 'low'
                      ? 'Low'
                      : priority() === 'high'
                        ? 'High'
                        : priority() === 'urgent'
                          ? 'Urgent'
                          : 'Normal'}
                  </span>
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  <For each={priorityOptions}>
                    {(option) => (
                      <DropdownMenuItem onSelect={() => setPriority(option.value)}>
                        <option.Icon aria-hidden="true" />
                        {option.label}
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div class="conventional-detail-panel__grid">
            <div class="conventional-detail-panel__field">
              <span class="conventional-detail-panel__label">Room</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={fieldsDisabled()}
                  as={Button}
                  variant="outline"
                  class="conventional-room-picker"
                >
                  <Show when={selectedRoom()}>
                    {(room) => <RoomIcon functionKey={room().functionKey} />}
                  </Show>
                  <span>{selectedRoom()?.name ?? 'No Room'}</span>
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  <DropdownMenuItem onSelect={() => setRoomId(null)}>No Room</DropdownMenuItem>
                  <For each={roomRows()}>
                    {(entry) => (
                      <DropdownMenuItem onSelect={() => setRoomId(entry.item().id)}>
                        <RoomIcon functionKey={entry.item().functionKey} />
                        {entry.item().name}
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div class="conventional-detail-panel__field">
              <span class="conventional-detail-panel__label">Agent</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={fieldsDisabled()}
                  as={Button}
                  variant="outline"
                  class="conventional-room-picker"
                >
                  <Bot aria-hidden="true" />
                  <span>
                    {agentId()
                      ? (props.agents.find(({ id }) => id === agentId())?.name ??
                        'Unavailable Agent')
                      : 'Unassigned'}
                  </span>
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  <DropdownMenuItem onSelect={() => setAgentId(null)}>Unassigned</DropdownMenuItem>
                  <For each={agentRows()}>
                    {(entry) => (
                      <DropdownMenuItem onSelect={() => setAgentId(entry.item().id)}>
                        <Bot aria-hidden="true" />
                        {entry.item().name}
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <Separator class="conventional-detail-panel__divider" />
          <fieldset>
            <legend>Dependencies</legend>
            <input
              type="search"
              placeholder="Search tasks…"
              aria-label="Search tasks to link as dependencies"
              value={dependencyQuery()}
              disabled={fieldsDisabled()}
              onInput={(event) => setDependencyQuery(event.currentTarget.value)}
            />
            <ul class="conventional-dependency-results">
              <For each={dependencyRows()}>
                {(entry) => {
                  const selectedDependency = () => dependencyIds().includes(entry.item().id)
                  return (
                    <li>
                      <button
                        type="button"
                        aria-pressed={selectedDependency()}
                        disabled={fieldsDisabled()}
                        onClick={() => toggleDependency(entry.item().id)}
                      >
                        <Show when={selectedDependency()} fallback={<Plus aria-hidden="true" />}>
                          <Check aria-hidden="true" />
                        </Show>
                        <span>{entry.item().title}</span>
                      </button>
                    </li>
                  )
                }}
              </For>
              <Show when={!dependencyCandidates().length}>
                <li class="conventional-dependency-results__empty">No matching tasks.</li>
              </Show>
            </ul>
          </fieldset>
          <Separator class="conventional-detail-panel__divider" />
          <Show when={props.task.lifecycleState === 'in_review'}>
            <p>Waiting on review. A new comment in the linked conversation reopens the Task.</p>
          </Show>
          <div class="conventional-detail-panel__actions">
            <Show when={props.task.lifecycleState === 'created'}>
              <button type="button" onClick={() => void runImmediate(props.task, props.onQueue)}>
                <Play aria-hidden="true" />
                Start
              </button>
            </Show>
            <Show when={props.task.lifecycleState === 'queued'}>
              <button type="button" onClick={() => void runImmediate(props.task, props.onStart)}>
                <Play aria-hidden="true" />
                Begin work
              </button>
            </Show>
            <Show when={props.task.lifecycleState === 'in_progress'}>
              <button type="button" onClick={() => void runImmediate(props.task, props.onReview)}>
                <Send aria-hidden="true" />
                Submit for review
              </button>
            </Show>
            <Show when={selectableState()}>
              <button type="button" onClick={() => void runImmediate(props.task, props.onComplete)}>
                <CheckCircle2 aria-hidden="true" />
                Complete
              </button>
            </Show>
            <Show when={selectableState()}>
              <button type="button" onClick={() => void runImmediate(props.task, props.onCancel)}>
                <Square aria-hidden="true" />
                Cancel
              </button>
            </Show>
            <button type="button" onClick={() => props.onOpenConversation(props.task)}>
              <MessageCircle aria-hidden="true" />
              Open conversation
            </button>
            <button
              type="button"
              onClick={() =>
                window.confirm('Archive this Task?') &&
                void runImmediate(props.task, props.onArchive)
              }
            >
              <Archive aria-hidden="true" />
              Archive
            </button>
          </div>
          <div class="conventional-detail-panel__status" aria-live="polite">
            {status()}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function KindIconFallback(props: { kind: TaskSummary['kind'] }) {
  return (
    <Show when={props.kind === 'chore'} fallback={<Sparkles aria-hidden="true" />}>
      <Wrench aria-hidden="true" />
    </Show>
  )
}

function PriorityIcon(props: { priority: TaskSummary['priority'] }) {
  return (
    <Show
      when={props.priority === 'low'}
      fallback={
        <Show
          when={props.priority === 'high'}
          fallback={
            <Show when={props.priority === 'urgent'} fallback={<Minus aria-hidden="true" />}>
              <ChevronsUp aria-hidden="true" />
            </Show>
          }
        >
          <ArrowUp aria-hidden="true" />
        </Show>
      }
    >
      <ArrowDown aria-hidden="true" />
    </Show>
  )
}
