import { useState } from 'react'
import type { AgentSummary, RoomSummary, TaskSummary } from '@agent-hq/types'
import { Archive, MessageCircle, Play, Square, X } from 'lucide-react'

import type { PrivateContentResolver } from './platform'
import { TaskObjective } from './private-task-objective'

type Props = Readonly<{
  agents: readonly AgentSummary[]
  busy: boolean
  onArchive: (task: TaskSummary) => Promise<void>
  onAssign: (task: TaskSummary, agentId: string | null) => Promise<void>
  onCancel: (task: TaskSummary) => Promise<void>
  onClose: () => void
  onDependencies: (task: TaskSummary, dependencyIds: readonly string[]) => Promise<void>
  onMoveRoom: (task: TaskSummary, roomId: string | null) => Promise<void>
  onOpenConversation: (task: TaskSummary) => void
  onQueue: (task: TaskSummary) => Promise<void>
  privateContent?: PrivateContentResolver
  rooms: readonly RoomSummary[]
  task: TaskSummary
  tasks: readonly TaskSummary[]
}>

export function TaskDetail(props: Props) {
  const [dependencyIds, setDependencyIds] = useState<readonly string[]>(props.task.dependencyIds)
  const [status, setStatus] = useState<string | null>(null)
  const run = async (action: () => Promise<void>, message: string) => {
    setStatus(null)
    try {
      await action()
      setStatus(message)
    } catch {
      setStatus(
        'This Task changed elsewhere or the request could not be completed. Reload and retry.'
      )
    }
  }
  return (
    <aside className="conventional-detail-panel" aria-labelledby="task-detail-title">
      <header>
        <div>
          <span>Task detail</span>
          <h2 id="task-detail-title">{props.task.title}</h2>
        </div>
        <button type="button" aria-label="Close Task detail" onClick={props.onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <p>
        <TaskObjective privateContent={props.privateContent} task={props.task} />
      </p>
      <label>
        Agent
        <select
          value={props.task.agentId ?? ''}
          disabled={props.busy}
          onChange={(event) =>
            void run(
              () => props.onAssign(props.task, event.target.value || null),
              'Agent assignment updated.'
            )
          }
        >
          <option value="">Unassigned</option>
          {props.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Room
        <select
          value={props.task.roomId ?? ''}
          disabled={props.busy}
          onChange={(event) =>
            void run(
              () => props.onMoveRoom(props.task, event.target.value || null),
              'Room association updated.'
            )
          }
        >
          <option value="">No Room</option>
          {props.rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Dependencies</legend>
        {props.tasks
          .filter(({ id }) => id !== props.task.id)
          .map((task) => (
            <label key={task.id}>
              <input
                type="checkbox"
                checked={dependencyIds.includes(task.id)}
                onChange={(event) =>
                  setDependencyIds((ids) =>
                    event.target.checked ? [...ids, task.id] : ids.filter((id) => id !== task.id)
                  )
                }
              />
              {task.title}
            </label>
          ))}
        <button
          type="button"
          disabled={props.busy}
          onClick={() =>
            void run(() => props.onDependencies(props.task, dependencyIds), 'Dependencies updated.')
          }
        >
          Save dependencies
        </button>
      </fieldset>
      <div className="conventional-detail-panel__actions">
        {props.task.lifecycleState === 'created' ? (
          <button
            type="button"
            onClick={() => void run(() => props.onQueue(props.task), 'Task queued.')}
          >
            <Play aria-hidden="true" />
            Queue
          </button>
        ) : null}
        {props.task.lifecycleState !== 'cancelled' ? (
          <button
            type="button"
            onClick={() => void run(() => props.onCancel(props.task), 'Task cancelled.')}
          >
            <Square aria-hidden="true" />
            Cancel
          </button>
        ) : null}
        <button type="button" onClick={() => props.onOpenConversation(props.task)}>
          <MessageCircle aria-hidden="true" />
          Open conversation
        </button>
        <button
          type="button"
          onClick={() =>
            window.confirm('Archive this Task?') &&
            void run(() => props.onArchive(props.task), 'Task archived.')
          }
        >
          <Archive aria-hidden="true" />
          Archive
        </button>
      </div>
      <div className="conventional-detail-panel__status" aria-live="polite">
        {status}
      </div>
    </aside>
  )
}
