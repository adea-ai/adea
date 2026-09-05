import { useRef, useState, type CSSProperties } from 'react'
import type { AgentSummary, RoomSummary, TaskSummary } from '@agent-hq/types'
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
} from 'lucide-react'
import { Button } from '@agent-hq/ui/components/ui/button'
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '@agent-hq/ui/components/ui/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@agent-hq/ui/components/ui/dropdown-menu'

import type { PrivateContentResolver } from './platform'
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

export function TaskDetail(props: Props) {
  const [dependencyIds, setDependencyIds] = useState<readonly string[]>(props.task.dependencyIds)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const versionRef = useRef(props.task.version)
  const [title, setTitle] = useState(props.task.title)
  const [objective, setObjective] = useState(props.task.objective ?? '')
  const [kind, setKind] = useState<TaskSummary['kind']>(props.task.kind ?? 'feature')
  const [priority, setPriority] = useState<TaskSummary['priority']>(props.task.priority)
  const [agentId, setAgentId] = useState<string | null>(props.task.agentId ?? null)
  const [roomId, setRoomId] = useState<string | null>(props.task.roomId ?? null)
  const selectedRoom = roomId ? props.rooms.find(({ id }) => id === roomId) : undefined
  const trimmedTitle = title.trim()
  const trimmedObjective = objective.trim()
  const titleChanged = trimmedTitle !== props.task.title
  const objectiveChanged = (trimmedObjective || undefined) !== (props.task.objective ?? undefined)
  const kindChanged = kind !== (props.task.kind ?? 'feature')
  const priorityChanged = priority !== props.task.priority
  const agentChanged = (agentId ?? null) !== (props.task.agentId ?? null)
  const roomChanged = (roomId ?? null) !== (props.task.roomId ?? null)
  const dependenciesChanged =
    JSON.stringify([...dependencyIds].sort()) !==
    JSON.stringify([...props.task.dependencyIds].sort())
  const detailsChanged =
    (titleChanged && trimmedTitle.length > 0 && trimmedTitle.length <= 200) ||
    (objectiveChanged && trimmedObjective.length > 0 && trimmedObjective.length <= 20_000) ||
    kindChanged ||
    priorityChanged
  const dirty = detailsChanged || agentChanged || roomChanged || dependenciesChanged
  const [dependencyQuery, setDependencyQuery] = useState('')
  const dependencyCandidates = props.tasks.filter(
    (task) =>
      task.id !== props.task.id &&
      task.title.toLowerCase().includes(dependencyQuery.trim().toLowerCase())
  )
  const toggleDependency = (taskId: string) =>
    setDependencyIds((ids) =>
      ids.includes(taskId) ? ids.filter((id) => id !== taskId) : [...ids, taskId]
    )
  const run = async (action: () => Promise<void>, message: string) => {
    setStatus(null)
    try {
      await action()
      versionRef.current += 1
      setStatus(message)
    } catch {
      setStatus(
        'This Task changed elsewhere or the request could not be completed. Reload and retry.'
      )
    }
  }
  const runImmediate = (task: TaskSummary, action: (task: TaskSummary) => Promise<void>) =>
    run(() => action({ ...task, version: versionRef.current }), '')
  const handleClose = async () => {
    if (saving) return
    if (!dirty) {
      props.onClose()
      return
    }
    if (titleChanged && trimmedTitle.length === 0) {
      setStatus('Task title cannot be empty.')
      return
    }
    setSaving(true)
    setStatus(null)
    try {
      let current: TaskSummary = { ...props.task, version: versionRef.current }
      const bump = () => {
        versionRef.current += 1
        current = { ...current, version: versionRef.current }
      }
      const update: {
        kind?: TaskSummary['kind']
        objective?: string
        priority?: TaskSummary['priority']
        title?: string
      } = {}
      if (titleChanged && trimmedTitle.length > 0 && trimmedTitle.length <= 200)
        update.title = trimmedTitle
      if (objectiveChanged && trimmedObjective.length > 0 && trimmedObjective.length <= 20_000)
        update.objective = trimmedObjective
      if (kindChanged) update.kind = kind
      if (priorityChanged) update.priority = priority
      if (Object.keys(update).length) {
        await props.onUpdate(current, update)
        bump()
      }
      if (agentChanged) {
        await props.onAssign(current, agentId)
        bump()
      }
      if (roomChanged) {
        await props.onMoveRoom(current, roomId)
        bump()
      }
      if (dependenciesChanged) {
        await props.onDependencies(current, dependencyIds)
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
  const fieldsDisabled = props.busy || saving
  return (
    <Drawer
      open
      swipeDirection="right"
      onOpenChange={(open) => {
        if (!open) void handleClose()
      }}
    >
      <DrawerContent style={{ '--drawer-content-width': 'min(29rem, 94vw)' } as CSSProperties}>
        <div className="conventional-detail-panel">
          <header>
            <div>
              <span>Task detail</span>
              <DrawerTitle className="sr-only">{props.task.title}</DrawerTitle>
            </div>
            <DrawerClose
              className="conventional-detail-panel__close"
              aria-label="Close Task detail"
            >
              <X aria-hidden="true" />
            </DrawerClose>
          </header>
          <label>
            Title
            <input
              value={title}
              maxLength={200}
              disabled={fieldsDisabled}
              onChange={(event) => setTitle(event.target.value)}
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
              value={objective}
              disabled={fieldsDisabled}
              onChange={(event) => setObjective(event.target.value)}
            />
          </label>
          <hr className="conventional-detail-panel__divider" />
          <div className="conventional-detail-panel__grid">
            <div className="conventional-detail-panel__field">
              <span className="conventional-detail-panel__label">Type</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={fieldsDisabled}
                  render={
                    <Button type="button" variant="outline" className="conventional-room-picker" />
                  }
                >
                  {(() => {
                    const KindIcon = kind === 'bug' ? Bug : kind === 'chore' ? Wrench : Sparkles
                    return (
                      <>
                        <KindIcon aria-hidden="true" />
                        <span>
                          {kind === 'bug' ? 'Bug' : kind === 'chore' ? 'Chore' : 'Feature'}
                        </span>
                      </>
                    )
                  })()}
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  {[
                    { value: 'bug' as const, label: 'Bug', Icon: Bug },
                    { value: 'feature' as const, label: 'Feature', Icon: Sparkles },
                    { value: 'chore' as const, label: 'Chore', Icon: Wrench },
                  ].map((option) => (
                    <DropdownMenuItem key={option.value} onClick={() => setKind(option.value)}>
                      <option.Icon aria-hidden="true" />
                      {option.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="conventional-detail-panel__field">
              <span
                className="conventional-detail-panel__label"
                id={`task-detail-priority-label-${props.task.id}`}
              >
                Priority
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={fieldsDisabled}
                  render={
                    <Button type="button" variant="outline" className="conventional-room-picker" />
                  }
                >
                  {(() => {
                    const PriorityIcon =
                      priority === 'low'
                        ? ArrowDown
                        : priority === 'high'
                          ? ArrowUp
                          : priority === 'urgent'
                            ? ChevronsUp
                            : Minus
                    return (
                      <>
                        <PriorityIcon aria-hidden="true" />
                        <span>
                          {priority === 'low'
                            ? 'Low'
                            : priority === 'high'
                              ? 'High'
                              : priority === 'urgent'
                                ? 'Urgent'
                                : 'Normal'}
                        </span>
                      </>
                    )
                  })()}
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  {[
                    { value: 'low' as const, label: 'Low', Icon: ArrowDown },
                    { value: 'normal' as const, label: 'Normal', Icon: Minus },
                    { value: 'high' as const, label: 'High', Icon: ArrowUp },
                    { value: 'urgent' as const, label: 'Urgent', Icon: ChevronsUp },
                  ].map((option) => (
                    <DropdownMenuItem key={option.value} onClick={() => setPriority(option.value)}>
                      <option.Icon aria-hidden="true" />
                      {option.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="conventional-detail-panel__grid">
            <div className="conventional-detail-panel__field">
              <span className="conventional-detail-panel__label">Room</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={fieldsDisabled}
                  render={
                    <Button type="button" variant="outline" className="conventional-room-picker" />
                  }
                >
                  {selectedRoom ? <RoomIcon functionKey={selectedRoom.functionKey} /> : null}
                  <span>{selectedRoom?.name ?? 'No Room'}</span>
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  <DropdownMenuItem onClick={() => setRoomId(null)}>No Room</DropdownMenuItem>
                  {props.rooms.map((room) => (
                    <DropdownMenuItem key={room.id} onClick={() => setRoomId(room.id)}>
                      <RoomIcon functionKey={room.functionKey} />
                      {room.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="conventional-detail-panel__field">
              <span className="conventional-detail-panel__label">Agent</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={fieldsDisabled}
                  render={
                    <Button type="button" variant="outline" className="conventional-room-picker" />
                  }
                >
                  <Bot aria-hidden="true" />
                  <span>
                    {agentId
                      ? (props.agents.find(({ id }) => id === agentId)?.name ?? 'Unavailable Agent')
                      : 'Unassigned'}
                  </span>
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom">
                  <DropdownMenuItem onClick={() => setAgentId(null)}>Unassigned</DropdownMenuItem>
                  {props.agents.map((agent) => (
                    <DropdownMenuItem key={agent.id} onClick={() => setAgentId(agent.id)}>
                      <Bot aria-hidden="true" />
                      {agent.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <hr className="conventional-detail-panel__divider" />
          <fieldset>
            <legend>Dependencies</legend>
            <input
              type="search"
              placeholder="Search tasks…"
              aria-label="Search tasks to link as dependencies"
              value={dependencyQuery}
              disabled={fieldsDisabled}
              onChange={(event) => setDependencyQuery(event.target.value)}
            />
            <ul className="conventional-dependency-results">
              {dependencyCandidates.map((task) => {
                const selectedDependency = dependencyIds.includes(task.id)
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      aria-pressed={selectedDependency}
                      disabled={fieldsDisabled}
                      onClick={() => toggleDependency(task.id)}
                    >
                      {selectedDependency ? (
                        <Check aria-hidden="true" />
                      ) : (
                        <Plus aria-hidden="true" />
                      )}
                      <span>{task.title}</span>
                    </button>
                  </li>
                )
              })}
              {!dependencyCandidates.length ? (
                <li className="conventional-dependency-results__empty">No matching tasks.</li>
              ) : null}
            </ul>
          </fieldset>
          <hr className="conventional-detail-panel__divider" />
          {props.task.lifecycleState === 'in_review' ? (
            <p>Waiting on review. A new comment in the linked conversation reopens the Task.</p>
          ) : null}
          <div className="conventional-detail-panel__actions">
            {props.task.lifecycleState === 'created' ? (
              <button type="button" onClick={() => void runImmediate(props.task, props.onQueue)}>
                <Play aria-hidden="true" />
                Start
              </button>
            ) : null}
            {props.task.lifecycleState === 'queued' ? (
              <button type="button" onClick={() => void runImmediate(props.task, props.onStart)}>
                <Play aria-hidden="true" />
                Begin work
              </button>
            ) : null}
            {props.task.lifecycleState === 'in_progress' ? (
              <button type="button" onClick={() => void runImmediate(props.task, props.onReview)}>
                <Send aria-hidden="true" />
                Submit for review
              </button>
            ) : null}
            {props.task.lifecycleState === 'created' ||
            props.task.lifecycleState === 'queued' ||
            props.task.lifecycleState === 'in_progress' ||
            props.task.lifecycleState === 'in_review' ? (
              <button type="button" onClick={() => void runImmediate(props.task, props.onComplete)}>
                <CheckCircle2 aria-hidden="true" />
                Complete
              </button>
            ) : null}
            {props.task.lifecycleState === 'created' ||
            props.task.lifecycleState === 'queued' ||
            props.task.lifecycleState === 'in_progress' ||
            props.task.lifecycleState === 'in_review' ? (
              <button type="button" onClick={() => void runImmediate(props.task, props.onCancel)}>
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
                void runImmediate(props.task, props.onArchive)
              }
            >
              <Archive aria-hidden="true" />
              Archive
            </button>
          </div>
          <div className="conventional-detail-panel__status" aria-live="polite">
            {status}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
