import type { TaskSummary } from '@adea-ai/types'
import type { BoardColumn } from '@adea-ai/ui/components/ui/board'
import {
  ArrowDown,
  ArrowUp,
  Bug,
  ChevronsUp,
  Minus,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-solid'

export type TaskState = TaskSummary['lifecycleState']

/**
 * The board's lanes, in lifecycle order. Each lane takes a chart hue so lanes
 * read apart at a glance, while the lane's name always says what it is; the
 * colour never carries the meaning on its own.
 */
export const taskLanes = [
  // New tasks land in Planned, so it stays open even when empty.
  { id: 'created', label: 'Planned', tone: 'neutral', collapsible: false },
  { id: 'queued', label: 'Queued', tone: 'chart-2' },
  { id: 'in_progress', label: 'In progress', tone: 'chart-1' },
  { id: 'in_review', label: 'In review', tone: 'chart-5' },
  { id: 'completed', label: 'Completed', tone: 'chart-4' },
  { id: 'cancelled', label: 'Cancelled', tone: 'chart-6' },
] as const satisfies readonly (BoardColumn & { id: TaskState })[]

export const laneFor = (state: TaskState) => taskLanes.find((lane) => lane.id === state)

// Mirrors the server transition map in packages/db/src/tasks.ts. Cards may only
// be dropped on columns the Task can legally transition to.
export const validTransitions: Record<TaskState, readonly TaskState[]> = {
  archived: [],
  cancelled: ['archived'],
  completed: ['archived'],
  created: ['queued', 'in_progress', 'completed', 'cancelled', 'archived'],
  in_progress: ['in_review', 'completed', 'cancelled', 'archived'],
  in_review: ['in_progress', 'completed', 'cancelled', 'archived'],
  queued: ['in_progress', 'completed', 'cancelled', 'archived'],
}

type Option<Value> = Readonly<{ value: Value; label: string; Icon: LucideIcon }>

export const kindOptions: readonly Option<TaskSummary['kind']>[] = [
  { value: 'feature', label: 'Feature', Icon: Sparkles },
  { value: 'bug', label: 'Bug', Icon: Bug },
  { value: 'chore', label: 'Chore', Icon: Wrench },
]

/**
 * Priority is shown as a glyph *and* a word on a tinted badge: urgent and high
 * take the destructive and warning tints, so the two that need attention stand
 * out, and the word means the tint is never the only signal.
 */
export const priorityOptions: readonly (Option<TaskSummary['priority']> & {
  badge: 'destructive' | 'warning' | 'secondary' | 'outline'
})[] = [
  { value: 'urgent', label: 'Urgent', Icon: ChevronsUp, badge: 'destructive' },
  { value: 'high', label: 'High', Icon: ArrowUp, badge: 'warning' },
  { value: 'normal', label: 'Normal', Icon: Minus, badge: 'secondary' },
  { value: 'low', label: 'Low', Icon: ArrowDown, badge: 'outline' },
]

export const kindOption = (kind: TaskSummary['kind'] | undefined) =>
  kindOptions.find((option) => option.value === (kind ?? 'feature')) ?? kindOptions[0]!

export const priorityOption = (priority: TaskSummary['priority']) =>
  priorityOptions.find((option) => option.value === priority) ?? priorityOptions[2]!
