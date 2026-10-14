/*
 * The request-to-effect path of a task completion (#1217). It parses the optional
 * outbound result a completion request carries, then runs the completion through the
 * existing task and publication transactions. The HTTP route only resolves the caller
 * and maps the outcome to a response. The path lives here, next to the transactions it
 * calls, so the real-database integration lane exercises it directly.
 */
import type { TaskSummary, UserPrincipalRef } from '@adea-ai/types'

import type { AgentHqDatabase } from './connection'
import { completeTaskAndPublishOutboundResult } from './job-outbound-result-store'
import { parseOutboundCompletion, summarizePublication } from './task-completion-parse'
import type { TaskCompletionPublication } from './task-completion-parse'
import { completeTask, type TaskCommand } from './tasks'

export type TaskCompletionInput = Readonly<{
  /** The parsed request body. Only `outboundResult` is read here. */
  body: Readonly<Record<string, unknown>>
  command: TaskCommand
  database: AgentHqDatabase
  principal: UserPrincipalRef
  taskId: string
  workspaceId: string
}>

export type TaskCompletionOutcome =
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{
      kind: 'completed'
      outboundPublication?: TaskCompletionPublication
      task: TaskSummary
    }>

/**
 * Completes a task, with its outbound result when the body carries one. An invalid
 * outbound result is refused before the database is touched. A valid one completes and
 * publishes in one transaction, so the outcome reports both or neither.
 */
export async function completeTaskFromRequest(
  input: TaskCompletionInput
): Promise<TaskCompletionOutcome> {
  const { command, database, principal, taskId, workspaceId } = input
  if (input.body.outboundResult === undefined) {
    const task = await completeTask(database, workspaceId, taskId, principal, command)
    return { kind: 'completed', task }
  }
  const completion = parseOutboundCompletion(input.body.outboundResult)
  if (!completion) return { kind: 'invalid' }
  const outcome = await completeTaskAndPublishOutboundResult(
    database,
    workspaceId,
    taskId,
    principal,
    command,
    completion
  )
  return {
    kind: 'completed',
    outboundPublication: summarizePublication(outcome.publication),
    task: outcome.task,
  }
}
