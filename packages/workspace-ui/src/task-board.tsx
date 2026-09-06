import { useState } from "react";
import type { AgentSummary, RoomSummary, TaskSummary } from "@adea/types";
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
} from "lucide-react";

import { Button } from "@adea/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@adea/ui/components/ui/tooltip";
import { TaskDetail } from "./task-detail";
import type { PrivateContentResolver } from "./platform";
import { TaskObjective } from "./private-task-objective";
import { RoomIcon } from "./room-icon";
import { WorkspaceEmpty } from "./workspace-states";

type Props = Readonly<{
  agents: readonly AgentSummary[];
  busy: boolean;
  onArchive: (task: TaskSummary) => Promise<void>;
  onAssign: (task: TaskSummary, agentId: string | null) => Promise<void>;
  onCancel: (task: TaskSummary) => Promise<void>;
  onComplete: (task: TaskSummary) => Promise<void>;
  onCreate: (
    input: Readonly<{
      kind?: TaskSummary["kind"];
      objective: string;
      priority: TaskSummary["priority"];
      title: string;
    }>
  ) => Promise<void>;
  onDependencies: (task: TaskSummary, dependencyIds: readonly string[]) => Promise<void>;
  onMoveRoom: (task: TaskSummary, roomId: string | null) => Promise<void>;
  onOpenConversation: (task: TaskSummary) => void;
  onQueue: (task: TaskSummary) => Promise<void>;
  onReview: (task: TaskSummary) => Promise<void>;
  onSelect: (taskId: string | null) => void;
  onStart: (task: TaskSummary) => Promise<void>;
  onUpdate: (
    task: TaskSummary,
    update: Readonly<{
      kind?: TaskSummary["kind"];
      objective?: string;
      priority?: TaskSummary["priority"];
      title?: string;
    }>
  ) => Promise<void>;
  privateContent?: PrivateContentResolver;
  rooms: readonly RoomSummary[];
  selectedTaskId: string | null;
  tasks: readonly TaskSummary[];
}>;

const columns = [
  { id: "created" as const, label: "Planned" },
  { id: "queued" as const, label: "Queued" },
  { id: "in_progress" as const, label: "In-Progress" },
  { id: "in_review" as const, label: "In-Review" },
  { id: "completed" as const, label: "Completed" },
  { id: "cancelled" as const, label: "Cancelled" },
];

// Mirrors the server transition map in packages/db/src/tasks.ts. Cards may only
// be dropped on columns the Task can legally transition to.
const validTransitions: Record<
  TaskSummary["lifecycleState"],
  readonly TaskSummary["lifecycleState"][]
> = {
  archived: [],
  cancelled: ["archived"],
  completed: ["archived"],
  created: ["queued", "in_progress", "completed", "cancelled", "archived"],
  in_progress: ["in_review", "completed", "cancelled", "archived"],
  in_review: ["in_progress", "completed", "cancelled", "archived"],
  queued: ["in_progress", "completed", "cancelled", "archived"],
};

const stateLabels: Record<TaskSummary["lifecycleState"], string> = {
  archived: "Archived",
  cancelled: "Cancelled",
  completed: "Completed",
  created: "Planned",
  in_progress: "In-Progress",
  in_review: "In-Review",
  queued: "Queued",
};

const priorityIconFor = {
  high: ArrowUp,
  low: ArrowDown,
  normal: Minus,
  urgent: ChevronsUp,
} as const;

const kindIconFor = {
  bug: Bug,
  chore: Wrench,
  feature: Sparkles,
} as const;

function PriorityTag({ priority }: Readonly<{ priority: TaskSummary["priority"] }>) {
  const Icon = priorityIconFor[priority];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={`conventional-priority conventional-priority--${priority}`}
            aria-label={`Priority: ${priority}`}
          />
        }
      >
        <Icon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{priority}</TooltipContent>
    </Tooltip>
  );
}

export function TaskBoard(props: Props) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropColumnId, setDropColumnId] = useState<string | null>(null);
  const selected = props.tasks.find(({ id }) => id === props.selectedTaskId);
  const agentById = new Map(props.agents.map((agent) => [agent.id, agent]));
  const roomById = new Map(props.rooms.map((room) => [room.id, room]));
  const dropActions = {
    cancelled: props.onCancel,
    completed: props.onComplete,
    in_progress: props.onStart,
    in_review: props.onReview,
    queued: props.onQueue,
  } as const;
  const queueFromCard = async (task: TaskSummary) => {
    setBoardError(null);
    try {
      await props.onQueue(task);
    } catch {
      setBoardError("Task could not be queued. It may have changed elsewhere; reload and retry.");
    }
  };
  const dropOnColumn = async (columnId: TaskSummary["lifecycleState"]) => {
    const task = props.tasks.find(({ id }) => id === dragTaskId);
    setDragTaskId(null);
    setDropColumnId(null);
    if (!task) return;
    const action = (dropActions as Partial<typeof dropActions>)[
      columnId as keyof typeof dropActions
    ];
    if (!action) return;
    setBoardError(null);
    if (!validTransitions[task.lifecycleState].includes(columnId)) {
      setBoardError(
        `Tasks cannot move directly from ${stateLabels[task.lifecycleState]} to ${stateLabels[columnId]}.`
      );
      return;
    }
    try {
      await action(task);
    } catch {
      setBoardError("Task could not be moved. It may have changed elsewhere; reload and retry.");
    }
  };
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
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setError(null);
            try {
              await props.onCreate({
                kind: String(form.get("kind") ?? "feature") as TaskSummary["kind"],
                objective: String(form.get("objective") ?? ""),
                priority: String(form.get("priority") ?? "normal") as TaskSummary["priority"],
                title: String(form.get("title") ?? ""),
              });
              setCreating(false);
            } catch {
              setError("Task could not be created. Check the fields and retry.");
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
          <label>
            Type
            <select name="kind" defaultValue="feature">
              <option value="bug">Bug</option>
              <option value="feature">Feature</option>
              <option value="chore">Chore</option>
            </select>
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" className="conventional-primary-button" disabled={props.busy}>
            {props.busy ? "Creating…" : "Create Task"}
          </button>
        </form>
      ) : null}
      {boardError ? (
        <p role="alert" className="conventional-task-board__error">
          {boardError}
        </p>
      ) : null}
      {props.tasks.length ? (
        <div className="conventional-task-board" aria-label="Task board">
          {columns.map((column) => {
            const tasks = props.tasks.filter(({ lifecycleState }) => lifecycleState === column.id);
            return (
              <section
                key={column.id}
                aria-labelledby={`task-column-${column.id}`}
                onDragOver={(event) => {
                  if (dragTaskId) event.preventDefault();
                }}
                onDragEnter={() => setDropColumnId(column.id)}
                onDragLeave={() =>
                  setDropColumnId((current) => (current === column.id ? null : current))
                }
                onDrop={(event) => {
                  event.preventDefault();
                  void dropOnColumn(column.id);
                }}
              >
                <header>
                  <h2 id={`task-column-${column.id}`}>{column.label}</h2>
                  <span>{tasks.length}</span>
                </header>
                <div
                  className={`conventional-task-column${dropColumnId === column.id ? " conventional-task-column--drop-target" : ""}`}
                >
                  {tasks.map((task) => (
                    <article
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      aria-label={task.title}
                      className={`conventional-task-card${dragTaskId === task.id ? " conventional-task-card--dragging" : ""}`}
                      draggable
                      onClick={() => {
                        setBoardError(null);
                        props.onSelect(task.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setBoardError(null);
                          props.onSelect(task.id);
                        }
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", task.id);
                        event.dataTransfer.effectAllowed = "move";
                        setDragTaskId(task.id);
                      }}
                      onDragEnd={() => {
                        setDragTaskId(null);
                        setDropColumnId(null);
                      }}
                    >
                      <div className="conventional-task-card__header">
                        <span className="conventional-task-card__kind">
                          {(() => {
                            const KindIcon = kindIconFor[task.kind ?? "feature"];
                            return <KindIcon aria-hidden="true" />;
                          })()}
                        </span>
                        <strong>{task.title}</strong>
                        <PriorityTag priority={task.priority} />
                      </div>
                      <p>
                        <TaskObjective privateContent={props.privateContent} task={task} />
                      </p>
                      <footer>
                        <span>
                          <Bot aria-hidden="true" />
                          {task.agentId
                            ? (agentById.get(task.agentId)?.name ?? "Unavailable Agent")
                            : "Unassigned"}
                        </span>
                        <span>
                          {(() => {
                            const room = task.roomId ? roomById.get(task.roomId) : undefined;
                            return room ? <RoomIcon functionKey={room.functionKey} /> : null;
                          })()}
                          {task.roomId
                            ? (roomById.get(task.roomId)?.name ?? "Unavailable Room")
                            : "No Room"}
                        </span>
                        {task.lifecycleState === "created" ? (
                          <Button
                            type="button"
                            variant="success"
                            size="xs"
                            className="conventional-task-card__footer-action"
                            disabled={props.busy}
                            onClick={(event) => {
                              event.stopPropagation();
                              void queueFromCard(task);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <Play aria-hidden="true" />
                            Start
                          </Button>
                        ) : null}
                      </footer>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <WorkspaceEmpty
          title="No Tasks yet"
          detail="Create a durable Task and link its discussion to a Room thread when useful."
        />
      )}
      {selected ? (
        <TaskDetail
          {...props}
          key={selected.id}
          task={selected}
          onClose={() => props.onSelect(null)}
        />
      ) : null}
    </section>
  );
}
