import type { AgentSummary, RoomSummary, TaskSummary } from '@adea-ai/types'
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Bug,
  ChevronsUp,
  ListTodo,
  Minus,
  Play,
  Plus,
  Sparkles,
  Wrench,
  X,
} from 'lucide-solid'
import { createMemo, createSignal, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Board, BoardCardBody, BoardCardTitle } from '@adea-ai/ui/components/ui/board'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  Board,
  BoardCardBody,
  BoardCardTitle,
  type BoardColumn,
  type BoardMove,
} from '@adea-ai/ui/components/ui/board'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@adea-ai/ui/components/ui/tooltip'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { keyedRows, type KeyedRow } from './keyed-rows'
import { TaskDetail } from './task-detail'
import type { PrivateContentResolver } from './platform'
import { TaskObjective } from './private-task-objective'
import { RoomIcon } from './room-icon'
import { WorkspaceEmpty } from './workspace-states'

type Props = Readonly<{
  agents: readonly AgentSummary[]
  busy: boolean
  onArchive: (task: TaskSummary) => Promise<void>
  onAssign: (task: TaskSummary, agentId: string | null) => Promise<void>
  onCancel: (task: TaskSummary) => Promise<void>
  onComplete: (task: TaskSummary) => Promise<void>
  onCreate: (
    input: Readonly<{
      kind?: TaskSummary['kind']
      objective: string
      priority: TaskSummary['priority']
      title: string
    }>
  ) => Promise<void>
  onDependencies: (task: TaskSummary, dependencyIds: readonly string[]) => Promise<void>
  onMoveRoom: (task: TaskSummary, roomId: string | null) => Promise<void>
  onOpenConversation: (task: TaskSummary) => void
  onQueue: (task: TaskSummary) => Promise<void>
  onReview: (task: TaskSummary) => Promise<void>
  onSelect: (taskId: string | null) => void
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
  selectedTaskId: string | null
  tasks: readonly TaskSummary[]
}>

const columns = [
  { id: 'created' as const, label: 'Planned' },
  { id: 'queued' as const, label: 'Queued' },
  { id: 'in_progress' as const, label: 'In-Progress' },
  { id: 'in_review' as const, label: 'In-Review' },
  { id: 'completed' as const, label: 'Completed' },
  { id: 'cancelled' as const, label: 'Cancelled' },
]
type TaskState = TaskSummary['lifecycleState']

// Mirrors the server transition map in packages/db/src/tasks.ts. Cards may only
// be dropped on columns the Task can legally transition to.
const validTransitions: Record<
  TaskSummary['lifecycleState'],
  readonly TaskSummary['lifecycleState'][]
> = {
  archived: [],
  cancelled: ['archived'],
  completed: ['archived'],
  created: ['queued', 'in_progress', 'completed', 'cancelled', 'archived'],
  in_progress: ['in_review', 'completed', 'cancelled', 'archived'],
  in_review: ['in_progress', 'completed', 'cancelled', 'archived'],
  queued: ['in_progress', 'completed', 'cancelled', 'archived'],
}

const priorityIconFor = {
  high: ArrowUp,
  low: ArrowDown,
  normal: Minus,
  urgent: ChevronsUp,
} as const

const priorityToneFor = {
  high: 'warning',
  low: 'neutral',
  normal: 'info',
  urgent: 'danger',
} as const

const priorityLabelFor = {
  high: 'High',
  low: 'Low',
  normal: 'Normal',
  urgent: 'Urgent',
} as const

const kindIconFor = { bug: Bug, chore: Wrench, feature: Sparkles } as const

function PriorityTag(props: { priority: TaskSummary['priority'] }) {
  const Icon = priorityIconFor[props.priority]
  return (
    <StatusChip
      tone={priorityToneFor[props.priority]}
      label={`Priority: ${priorityLabelFor[props.priority]}`}
      detail={`${priorityLabelFor[props.priority]} priority`}
      compact
      trailing={<Icon aria-hidden="true" />}
    />
  )
}

export function canMoveTask(
  task: Pick<TaskSummary, 'lifecycleState'>,
  target: TaskSummary['lifecycleState']
): boolean {
  return validTransitions[task.lifecycleState].includes(target)
}

export function TaskBoard(props: Props) {
  const [creating, setCreating] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [boardError, setBoardError] = createSignal<string | null>(null)
  const selected = createMemo(() => props.tasks.find(({ id }) => id === props.selectedTaskId))
  const agentById = createMemo(() => new Map(props.agents.map((agent) => [agent.id, agent])))
  const roomById = createMemo(() => new Map(props.rooms.map((room) => [room.id, room])))
  const dropActions: Partial<Record<TaskState, (task: TaskSummary) => Promise<void>>> = {
    cancelled: props.onCancel,
    completed: props.onComplete,
    in_progress: props.onStart,
    in_review: props.onReview,
    queued: props.onQueue,
  }
  // Board's <For> sees stable wrappers even when the server returns fresh task
  // objects, so detail triggers and card state survive a workspace refetch.
  const taskRows = keyedRows(
    () => props.tasks,
    (task) => task.id,
    (previous, next) => previous.version === next.version && previous.updatedAt === next.updatedAt
  )
  const boardColumns: BoardColumn[] = columns.map((column) => {
    const count = createMemo(
      () => taskRows().filter((entry) => entry.item().lifecycleState === column.id).length
    )
    return { ...column, meta: <span>{count()}</span> }
  })

  const queueFromCard = async (task: TaskSummary) => {
    setBoardError(null)
    try {
      await props.onQueue(task)
    } catch {
      setBoardError('Task could not be queued. It may have changed elsewhere; reload and retry.')
    }
  }

  const canMoveTask = (entry: KeyedRow<TaskSummary>, from: string, to: string) => {
    const task = entry.item()
    return (
      task.lifecycleState === from &&
      Boolean(dropActions[to as TaskState]) &&
      validTransitions[task.lifecycleState].includes(to as TaskState)
    )
  }

  const moveTask = async ({ itemId, from, to }: BoardMove) => {
    const task = props.tasks.find(({ id }) => id === itemId)
    if (!task) return
    const action = dropActions[to as TaskState]
    // The server owns transition validity; this check prevents stale board
    // state from sending an action that no longer matches the rendered lane.
    if (
      task.lifecycleState !== from ||
      !action ||
      !validTransitions[task.lifecycleState].includes(to as TaskState)
    )
      return
    setBoardError(null)
    try {
      await action(task)
    } catch {
      setBoardError('Task could not be moved. It may have changed elsewhere; reload and retry.')
    }
  }

  return (
    <section class="conventional-tasks" aria-labelledby="task-board-title">
      <header class="conventional-surface-header">
        <div>
          <span>Durable product work</span>
          <h1 id="task-board-title">Tasks</h1>
          <p>Execution status is intentionally separate from these durable planning records.</p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          New Task
          <ListTodo aria-hidden="true" />
        </Button>
      </header>
      <Show when={creating()}>
        <form
          class="conventional-inline-form"
          onSubmit={async (event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            setError(null)
            try {
              await props.onCreate({
                kind: String(form.get('kind') ?? 'feature') as TaskSummary['kind'],
                objective: String(form.get('objective') ?? ''),
                priority: String(form.get('priority') ?? 'normal') as TaskSummary['priority'],
                title: String(form.get('title') ?? ''),
              })
              setCreating(false)
            } catch {
              setError('Task could not be created. Check the fields and retry.')
            }
          }}
        >
          <div class="conventional-inline-form__header">
            <h2>Create Task</h2>
            <ActionButton
              type="button"
              aria-label="Cancel Task creation"
              tooltip="Cancel Task creation"
              variant="ghost"
              size="icon-sm"
              onClick={() => setCreating(false)}
            >
              <X aria-hidden="true" />
            </ActionButton>
          </div>
          <Label>
            Title
            <Input name="title" required maxLength={160} />
          </Label>
          <Label>
            Objective
            <Textarea name="objective" required rows={3} maxLength={2_000} />
          </Label>
          <Label>
            Priority
            <NativeSelect
              name="priority"
              value="normal"
              options={[
                { value: 'low', label: 'Low' },
                { value: 'normal', label: 'Normal' },
                { value: 'high', label: 'High' },
                { value: 'urgent', label: 'Urgent' },
              ]}
            />
          </Label>
          <Label>
            Type
            <NativeSelect
              name="kind"
              value="feature"
              options={[
                { value: 'bug', label: 'Bug' },
                { value: 'feature', label: 'Feature' },
                { value: 'chore', label: 'Chore' },
              ]}
            />
          </Label>
          <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
          <Button type="submit" disabled={props.busy}>
            {props.busy ? 'Creating…' : 'Create Task'}
          </Button>
        </form>
      </Show>
      <Show when={boardError()}>
        {(message) => (
          <p role="alert" class="conventional-task-board__error">
            {message()}
          </p>
        )}
      </Show>
      <Show
        when={props.tasks.length}
        fallback={
          <WorkspaceEmpty
            title="No Tasks yet"
            detail="Create a durable Task and link its discussion to a Room thread when useful."
          />
        }
      >
        <Board
          columns={boardColumns}
          items={taskRows()}
          itemId={(entry) => entry.item().id}
          itemColumn={(entry) => entry.item().lifecycleState}
          canDrop={canMoveTask}
          onMove={(move) => void moveTask(move)}
          label="Task board"
          class="conventional-task-board"
          emptyColumn={() => 'No tasks'}
        >
          {(entry) => {
            const task = entry.item
            return (
              <BoardCardBody>
                <div class="conventional-task-card__header">
                  <span class="conventional-task-card__kind">
                    <Dynamic component={kindIconFor[task().kind ?? 'feature']} aria-hidden="true" />
                  </span>
                  <BoardCardTitle size="sm" class="min-w-0 flex-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="w-full justify-start"
                      onClick={() => {
                        setBoardError(null)
                        props.onSelect(task().id)
                      }}
                    >
                      {task().title}
                    </Button>
                  </BoardCardTitle>
                  <PriorityTag priority={task().priority} />
                </div>
                <p class="conventional-task-card__objective">
                  <TaskObjective privateContent={props.privateContent} task={task()} />
                </p>
                <footer class="conventional-task-card__metadata">
                  <span>
                    <Bot aria-hidden="true" />
                    {task().agentId
                      ? (agentById().get(task().agentId!)?.name ?? 'Unavailable Agent')
                      : 'Unassigned'}
                  </span>
                  <span>
                    <Show when={task().roomId ? roomById().get(task().roomId!) : undefined}>
                      {(room) => <RoomIcon functionKey={room().functionKey} />}
                    </Show>
                    {task().roomId
                      ? (roomById().get(task().roomId!)?.name ?? 'Unavailable Room')
                      : 'No Room'}
                  </span>
                  <Show when={task().lifecycleState === 'created'}>
                    <Button
                      type="button"
                      variant="success"
                      size="xs"
                      class="conventional-task-card__footer-action"
                      disabled={props.busy}
                      onClick={() => void queueFromCard(task())}
                    >
                      <Play aria-hidden="true" />
                      Start
                    </Button>
                  </Show>
                </footer>
              </BoardCardBody>
            )
          }}
        </Board>
      </Show>
      {/* Keyed: the detail panel's entire editor state — title, objective,
          kind, priority, agent, room, dependencies, and the `version` it
          writes back — is initialised from `task` once at setup. An UNKEYED
          Show reuses that instance when `selected()` changes, so selecting a
          different task while the drawer is open left task A's draft in task
          B's panel, and the save would write A's content onto B. Keying
          remounts on task change, which is what the state actually assumes. */}
      <Show when={selected()} keyed>
        {(task) => <TaskDetail {...props} task={task} onClose={() => props.onSelect(null)} />}
      </Show>
    </section>
  )
}
