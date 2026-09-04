import { useState } from 'react'
import type { AgentSummary, RoomSummary, TaskSummary } from '@agent-hq/types'
import { ListTodo, Plus, X } from 'lucide-react'

import { TaskDetail } from './task-detail'
import type { PrivateContentResolver } from './platform'
import { TaskObjective } from './private-task-objective'
import { WorkspaceEmpty } from './workspace-states'

type Props = Readonly<{
  agents: readonly AgentSummary[]
  busy: boolean
  onArchive: (task: TaskSummary) => Promise<void>
  onAssign: (task: TaskSummary, agentId: string | null) => Promise<void>
  onCancel: (task: TaskSummary) => Promise<void>
  onCreate: (
    input: Readonly<{ objective: string; priority: TaskSummary['priority']; title: string }>
  ) => Promise<void>
  onDependencies: (task: TaskSummary, dependencyIds: readonly string[]) => Promise<void>
  onMoveRoom: (task: TaskSummary, roomId: string | null) => Promise<void>
  onOpenConversation: (task: TaskSummary) => void
  onQueue: (task: TaskSummary) => Promise<void>
  onSelect: (taskId: string | null) => void
  privateContent?: PrivateContentResolver
  rooms: readonly RoomSummary[]
  selectedTaskId: string | null
  tasks: readonly TaskSummary[]
}>

const columns = [
  { id: 'created' as const, label: 'Planned' },
  { id: 'queued' as const, label: 'Queued' },
  { id: 'cancelled' as const, label: 'Cancelled' },
]

export function TaskBoard(props: Props) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = props.tasks.find(({ id }) => id === props.selectedTaskId)
  const agentById = new Map(props.agents.map((agent) => [agent.id, agent]))
  const roomById = new Map(props.rooms.map((room) => [room.id, room]))
  return (
    <section className="conventional-tasks" aria-labelledby="task-board-title">
      <header className="conventional-surface-header">
        <div>
          <span>Durable product work</span>
          <h1 id="task-board-title">Tasks</h1>
          <p>Execution status is intentionally separate from these durable planning records.</p>
        </div>
        <button
          type="button"
          className="conventional-primary-button"
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" />
          New Task
          <ListTodo aria-hidden="true" />
        </button>
      </header>
      {creating ? (
        <form
          className="conventional-inline-form"
          onSubmit={async (event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            setError(null)
            try {
              await props.onCreate({
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
          <div className="conventional-inline-form__header">
            <h2>Create Task</h2>
            <button
              type="button"
              aria-label="Cancel Task creation"
              onClick={() => setCreating(false)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <label>
            Title
            <input name="title" required maxLength={160} />
          </label>
          <label>
            Objective
            <textarea name="objective" required rows={3} maxLength={2_000} />
          </label>
          <label>
            Priority
            <select name="priority" defaultValue="normal">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" className="conventional-primary-button" disabled={props.busy}>
            {props.busy ? 'Creating…' : 'Create Task'}
          </button>
        </form>
      ) : null}
      {props.tasks.length ? (
        <div className="conventional-task-board" aria-label="Task board">
          {columns.map((column) => {
            const tasks = props.tasks.filter(({ lifecycleState }) => lifecycleState === column.id)
            return (
              <section key={column.id} aria-labelledby={`task-column-${column.id}`}>
                <header>
                  <h2 id={`task-column-${column.id}`}>{column.label}</h2>
                  <span>{tasks.length}</span>
                </header>
                <div className="conventional-task-column">
                  {tasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      className="conventional-task-card"
                      onClick={() => props.onSelect(task.id)}
                    >
                      <div className="conventional-task-card__header">
                        <strong>{task.title}</strong>
                        <span
                          className={`conventional-priority conventional-priority--${task.priority}`}
                        >
                          {task.priority}
                        </span>
                      </div>
                      <p>
                        <TaskObjective privateContent={props.privateContent} task={task} />
                      </p>
                      <footer>
                        <span>
                          {task.agentId
                            ? (agentById.get(task.agentId)?.name ?? 'Unavailable Agent')
                            : 'Unassigned'}
                        </span>
                        <span>
                          {task.roomId
                            ? (roomById.get(task.roomId)?.name ?? 'Unavailable Room')
                            : 'No Room'}
                        </span>
                      </footer>
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <WorkspaceEmpty
          title="No Tasks yet"
          detail="Create a durable Task and link its discussion to a Room thread when useful."
        />
      )}
      {selected ? (
        <TaskDetail {...props} task={selected} onClose={() => props.onSelect(null)} />
      ) : null}
    </section>
  )
}
