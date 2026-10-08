import { sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { commandOutbox, taskSubmissions } from './schema'

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function validateScope(workspaceId: string, limit: number) {
  if (!WORKSPACE_ID.test(workspaceId) || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Invalid task submission retention scope or limit')
}

/** A bounded, read-only preview. No ciphertext or private payload crosses this boundary. */
export async function inspectExpiredTaskSubmissionCiphertext(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  limit = 1000
): Promise<number> {
  validateScope(workspaceId, limit)
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`set local statement_timeout = '5s'`)
    await transaction.execute(sql`set local lock_timeout = '1s'`)
    const rows = await transaction.execute(sql`select count(*)::integer as count from (
      select submission.id from ${taskSubmissions} as submission
      join ${commandOutbox} as outbox
        on outbox.id = submission.command_id and outbox.workspace_id = submission.workspace_id
      where submission.workspace_id = ${workspaceId}::uuid
        and submission.ciphertext_purged_at is null
        and submission.expires_at <= statement_timestamp()
        and outbox.command_type = 'task.submit'
      order by submission.expires_at, submission.id limit ${limit}
    ) as eligible`)
    return Number(rows[0]?.count ?? 0)
  })
}

/** Operator-owned bounded cleanup, not acknowledgement, cancellation or execution acceptance. */
export async function purgeExpiredTaskSubmissionCiphertext(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  limit = 1000
): Promise<number> {
  validateScope(workspaceId, limit)
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`set local statement_timeout = '5s'`)
    await transaction.execute(sql`set local lock_timeout = '1s'`)
    const rows = await transaction.execute(sql`with eligible as (
      select submission.id, submission.command_id from ${taskSubmissions} as submission
      join ${commandOutbox} as outbox
        on outbox.id = submission.command_id and outbox.workspace_id = submission.workspace_id
      where submission.workspace_id = ${workspaceId}::uuid
        and submission.ciphertext_purged_at is null
        and submission.expires_at <= statement_timestamp()
        and outbox.command_type = 'task.submit'
      order by submission.expires_at, submission.id limit ${limit}
      for update of submission, outbox skip locked
    ), purged as (
      update ${commandOutbox} as outbox
      set payload = outbox.payload - 'envelope', updated_at = statement_timestamp()
      from eligible where outbox.id = eligible.command_id and outbox.workspace_id = ${workspaceId}::uuid
      returning outbox.id
    ) update ${taskSubmissions} as submission
      set ciphertext_purged_at = statement_timestamp(), updated_at = statement_timestamp()
      from eligible join purged on purged.id = eligible.command_id
      where submission.id = eligible.id and submission.workspace_id = ${workspaceId}::uuid
      returning submission.id`)
    return rows.length
  })
}
