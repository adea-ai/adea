/*
 * Execution-location provenance for a task's history surface (#671). The
 * policy layer (`@adea-ai/types/execution-location`) decides where work runs
 * and the persistence layer keeps one row per attempt
 * (`TaskSummary.execution`); this is the human-readable projection the task
 * panel renders, so "where did this run, and on which node" is answerable
 * after the fact — including when the location was refused, queued, or
 * changed under authorization.
 */
import type {
  ExecutionAttemptChange,
  ExecutionAttemptSummary,
  ExecutionLocationKind,
  TaskExecutionLocation,
} from '@adea-ai/types'

const LOCATION_LABELS: Readonly<Record<ExecutionLocationKind, string>> = {
  local_device: 'This device',
  remote_host: 'Remote host',
  agent_hq_cloud: 'Adea cloud',
}

const CHANGE_LABELS: Readonly<Record<ExecutionAttemptChange, string>> = {
  initial: 'first attempt',
  sticky_retry: 'sticky retry',
  authorized_reroute: 'authorized reroute',
}

export function executionLocationLabel(kind: ExecutionLocationKind): string {
  return LOCATION_LABELS[kind]
}

/** The node id's presentation form: enough to recognize, full id on hover
 *  through the `title` the row carries. */
export function executionNodeLabel(runtimeNodeId: string): string {
  return `node ${runtimeNodeId.slice(0, 8)}…`
}

/**
 * One history line per attempt. The node appears exactly when one ran the
 * attempt — a device-local task never claims a node, and a cloud attempt is
 * nodeless by policy (the read model normalizes a stray stored id, and this
 * projection refuses to invent one).
 */
export function describeExecutionAttempt(attempt: ExecutionAttemptSummary): string {
  const change = CHANGE_LABELS[attempt.change]
  if (attempt.runtimeNodeId !== undefined && attempt.locationKind === 'remote_host')
    return `Attempt ${attempt.attempt} — ${LOCATION_LABELS[attempt.locationKind]}, ${executionNodeLabel(attempt.runtimeNodeId)} (${change})`
  return `Attempt ${attempt.attempt} — ${LOCATION_LABELS[attempt.locationKind]} (${change})`
}

/** The full history, oldest first — the order the persisted attempts carry. */
export function describeExecutionHistory(execution: TaskExecutionLocation): readonly string[] {
  return execution.attempts.map(describeExecutionAttempt)
}
