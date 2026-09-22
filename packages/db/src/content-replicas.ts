import type { ContentReplicaSummary, UserPrincipalRef } from '@adea-ai/types'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { contentRefs, contentReplicas, workspaceMemberships } from './schema'

type Database = AgentHqDatabase | AgentHqTransaction
type ContentReplicaRow = typeof contentReplicas.$inferSelect

export type ContentReplicaUpsertInput = Readonly<{
  availability: ContentReplicaSummary['availability']
  ciphertext: string
  digestSha256: string
  keyEpochId?: string
  nonce: string
  replicaKind: ContentReplicaSummary['replicaKind']
  revision: number
  schemaVersion: number
}>

export type ContentReplicaUpsertResult = Readonly<{
  contentReplica: ContentReplicaSummary
  outcome: 'created' | 'duplicate' | 'stale'
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/
const NONCE = /^[A-Za-z0-9_-]{16}$/
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024
const MIN_CIPHERTEXT_BYTES = 16
const BASE64URL = /^[A-Za-z0-9_-]+$/

function decodeCanonicalBase64Url(value: string): Uint8Array | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    let binaryBytes = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binaryBytes += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    const canonical = btoa(binaryBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    return canonical === value ? bytes : null
  } catch {
    return null
  }
}

async function requireMembership(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) throw new Error('Content replica unavailable')
}

function validateInput(input: ContentReplicaUpsertInput) {
  if (
    !DIGEST.test(input.digestSha256) ||
    !NONCE.test(input.nonce) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1 ||
    (input.keyEpochId !== undefined && !UUID.test(input.keyEpochId))
  )
    throw new Error('Content replica metadata invalid')
  const ciphertext = decodeCanonicalBase64Url(input.ciphertext)
  if (
    !ciphertext ||
    ciphertext.byteLength < MIN_CIPHERTEXT_BYTES ||
    ciphertext.byteLength > MAX_CIPHERTEXT_BYTES
  )
    throw new Error('Content replica metadata invalid')
  if (input.replicaKind === 'agent_hq_e2ee_sync' && input.keyEpochId === undefined)
    throw new Error('Content replica metadata invalid')
  if (input.replicaKind !== 'agent_hq_e2ee_sync' && input.keyEpochId !== undefined)
    throw new Error('Content replica metadata invalid')
}

function summarize(row: ContentReplicaRow): ContentReplicaSummary {
  return Object.freeze({
    availability: row.availability,
    ciphertext: row.ciphertext,
    contentRefId: row.contentRefId,
    createdAt: row.createdAt.toISOString(),
    ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {}),
    digestSha256: row.digestSha256,
    id: row.id,
    ...(row.keyEpochId ? { keyEpochId: row.keyEpochId } : {}),
    nonce: row.nonce,
    replicaKind: row.replicaKind,
    revision: row.revision,
    schemaVersion: row.schemaVersion,
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
  })
}

function sameIdentity(row: ContentReplicaRow, input: ContentReplicaUpsertInput) {
  return row.replicaKind === input.replicaKind && row.keyEpochId === (input.keyEpochId ?? null)
}

function samePayload(row: ContentReplicaRow, input: ContentReplicaUpsertInput) {
  return (
    row.availability === input.availability &&
    row.ciphertext === input.ciphertext &&
    row.digestSha256 === input.digestSha256 &&
    row.nonce === input.nonce &&
    row.schemaVersion === input.schemaVersion
  )
}

async function selectRef(database: Database, workspaceId: string, contentRefId: string) {
  const [row] = await database
    .select()
    .from(contentRefs)
    .where(and(eq(contentRefs.workspaceId, workspaceId), eq(contentRefs.id, contentRefId)))
    .limit(1)
    .for('update')
  return row
}

async function selectRevision(
  database: Database,
  workspaceId: string,
  contentRefId: string,
  revision: number
) {
  return database
    .select()
    .from(contentReplicas)
    .where(
      and(
        eq(contentReplicas.workspaceId, workspaceId),
        eq(contentReplicas.contentRefId, contentRefId),
        eq(contentReplicas.revision, revision)
      )
    )
}

async function selectLatestIdentity(
  database: Database,
  workspaceId: string,
  contentRefId: string,
  input: ContentReplicaUpsertInput
) {
  return database
    .select()
    .from(contentReplicas)
    .where(
      and(
        eq(contentReplicas.workspaceId, workspaceId),
        eq(contentReplicas.contentRefId, contentRefId),
        eq(contentReplicas.replicaKind, input.replicaKind),
        input.keyEpochId
          ? eq(contentReplicas.keyEpochId, input.keyEpochId)
          : isNull(contentReplicas.keyEpochId)
      )
    )
    .orderBy(desc(contentReplicas.revision))
    .limit(1)
}

/**
 * Store one encrypted physical revision. Replays are safe: an identical
 * physical payload returns `duplicate`, an older revision returns `stale`,
 * and any digest or ciphertext reuse conflict fails closed.
 */
export async function upsertContentReplica(
  database: AgentHqDatabase,
  workspaceId: string,
  contentRefId: string,
  principal: UserPrincipalRef,
  input: ContentReplicaUpsertInput
): Promise<ContentReplicaUpsertResult> {
  validateInput(input)
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    if (!UUID.test(contentRefId)) throw new Error('Content replica unavailable')
    const contentRef = await selectRef(transaction, workspaceId, contentRefId)
    if (!contentRef || contentRef.synchronizationPolicy !== 'agent_hq_e2ee_sync')
      throw new Error('Content replica unavailable')

    const revisionRows = await selectRevision(
      transaction,
      workspaceId,
      contentRefId,
      input.revision
    )
    if (revisionRows.some((row) => row.digestSha256 !== input.digestSha256))
      throw new Error('Content replica digest conflict')

    const exact = revisionRows.find((row) => sameIdentity(row, input))
    if (exact) {
      if (!samePayload(exact, input)) throw new Error('Content replica digest conflict')
      const [current] = await selectLatestIdentity(transaction, workspaceId, contentRefId, input)
      if (current && current.revision > input.revision)
        return { contentReplica: summarize(current), outcome: 'stale' }
      return { contentReplica: summarize(exact), outcome: 'duplicate' }
    }

    const [current] = await selectLatestIdentity(transaction, workspaceId, contentRefId, input)
    if (current && current.revision > input.revision)
      return { contentReplica: summarize(current), outcome: 'stale' }

    const [inserted] = await transaction
      .insert(contentReplicas)
      .values({
        availability: input.availability,
        ciphertext: input.ciphertext,
        contentRefId,
        digestSha256: input.digestSha256,
        ...(input.keyEpochId ? { keyEpochId: input.keyEpochId } : {}),
        nonce: input.nonce,
        replicaKind: input.replicaKind,
        revision: input.revision,
        schemaVersion: input.schemaVersion,
        workspaceId,
        ...(input.availability === 'deleted' ? { deletedAt: new Date() } : {}),
      })
      .onConflictDoNothing()
      .returning()
    if (!inserted) {
      const replayRows = await selectRevision(
        transaction,
        workspaceId,
        contentRefId,
        input.revision
      )
      const replay = replayRows.find((row) => sameIdentity(row, input))
      if (replay && samePayload(replay, input))
        return { contentReplica: summarize(replay), outcome: 'duplicate' }
      throw new Error('Content replica digest conflict')
    }
    return { contentReplica: summarize(inserted), outcome: 'created' }
  })
}

export async function listContentReplicasForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  contentRefId: string,
  principal: UserPrincipalRef
): Promise<ContentReplicaSummary[]> {
  if (!UUID.test(contentRefId)) throw new Error('Content replica unavailable')
  await requireMembership(database, workspaceId, principal)
  const [contentRef] = await database
    .select({ synchronizationPolicy: contentRefs.synchronizationPolicy })
    .from(contentRefs)
    .where(and(eq(contentRefs.workspaceId, workspaceId), eq(contentRefs.id, contentRefId)))
    .limit(1)
  if (!contentRef || contentRef.synchronizationPolicy !== 'agent_hq_e2ee_sync')
    throw new Error('Content replica unavailable')
  const rows = await database
    .select()
    .from(contentReplicas)
    .where(
      and(
        eq(contentReplicas.workspaceId, workspaceId),
        eq(contentReplicas.contentRefId, contentRefId)
      )
    )
    .orderBy(asc(contentReplicas.revision), asc(contentReplicas.createdAt))
  return rows.map(summarize)
}
