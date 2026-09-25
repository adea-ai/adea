/*
 * Execution-location provenance for a task (#671). The policy layer decides
 * where work runs (`execution-location.ts`) and the retry family records a
 * reroute as a new attempt; this is the read model that lets a task's history
 * answer "where did this run, and on which node" after the fact.
 */
import type { ExecutionLocationKind } from './execution-location'

/** How an attempt came to be: the first one, a sticky retry, or an explicitly
 *  authorized reroute. Mirrors `ExecutionRetryResolution.change`. */
export type ExecutionAttemptChange = 'initial' | 'sticky_retry' | 'authorized_reroute'

export const executionAttemptChanges = [
  'initial',
  'sticky_retry',
  'authorized_reroute',
] as const satisfies readonly ExecutionAttemptChange[]

export type ExecutionAttemptSummary = Readonly<{
  /** 1 for the first attempt; `ExecutionLocationAttempt.attempt` on the wire. */
  attempt: number
  change: ExecutionAttemptChange
  locationKind: ExecutionLocationKind
  /** Absent exactly when no runtime node ran the attempt: the reserved cloud
   *  location, and a task whose execution never left this device. */
  runtimeNodeId?: string
  recordedAt: string
}>

export type TaskExecutionLocation = Readonly<{
  /** The attempt the task is running (or last ran) on. */
  current: ExecutionAttemptSummary
  /** Every recorded attempt, oldest first. */
  attempts: readonly ExecutionAttemptSummary[]
}>
