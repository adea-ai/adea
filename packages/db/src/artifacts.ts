import { createHash } from 'node:crypto'

import type {
  ArtifactLocation,
  ArtifactSummary,
  PrincipalRef,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { agents, artifacts, tasks, workspaceEvents, workspaceMemberships } from './schema'
import type { JsonObject } from './schema'

type Database = AgentHqDatabase | AgentHqTransaction
type ArtifactRow = typeof artifacts.$inferSelect
type ArtifactAvailability = ArtifactRow['availability']
type ArtifactRetentionPolicy = ArtifactRow['retentionPolicy']
type ArtifactSensitivity = ArtifactRow['sensitivity']

export type ArtifactCreateInput = Readonly<{
  agentId?: string
  availability?: ArtifactAvailability
  checksumSha256: string
  executionRef?: string
  filename: string
  location: ArtifactLocation
  mediaType: string
  provenance?: Readonly<Record<string, unknown>>
  retentionPolicy?: ArtifactRetentionPolicy
  sensitivity?: ArtifactSensitivity
  sizeBytes: number
  sourceArtifactRef: string
  sourcePrincipal: PrincipalRef
  taskId?: string
}>

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    )
  return value
}

function hashPayload(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

const SECRET_KEY =
  /(?:authorization|cookie|credential|password|private.?key|secret|token|api.?key|access.?key)/i
const SECRET_VALUE =
  /(?:authorization|credential|password|secret|token|api[_-]?key|(?:aws[_-]?)?access[_-]?key(?:[_-]?id)?)\s*[=:]/i

function isUnsafeOpaqueReference(value: string): boolean {
  return (
    value.includes('\\') ||
    value.includes('://') ||
    value.includes('?') ||
    value.includes('#') ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /%(?:2f|5c)/i.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    }) ||
    SECRET_VALUE.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  )
}

function isSafeProvenance(value: unknown): boolean {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true
  if (typeof value === 'string')
    return !(
      value.startsWith('/') ||
      value.startsWith('~') ||
      /^[a-zA-Z]:[\\/]/.test(value) ||
      SECRET_VALUE.test(value)
    )
  if (Array.isArray(value)) return value.every(isSafeProvenance)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).every(
    ([key, entry]) => !SECRET_KEY.test(key) && isSafeProvenance(entry)
  )
}

function principalId(principal: PrincipalRef): string {
  switch (principal.kind) {
    case 'user':
      return principal.userId
    case 'service':
      return principal.serviceId
    case 'runtime_node':
      return principal.runtimeNodeId
    case 'agent':
      return principal.agentId
    case 'worker':
      return principal.workerId
    case 'system':
      return principal.systemId
  }
}

function principalRef(kind: ArtifactRow['ownerPrincipalKind'], id: string): PrincipalRef {
  switch (kind) {
    case 'user':
      return Object.freeze({ kind, userId: id })
    case 'service':
      return Object.freeze({ kind, serviceId: id })
    case 'runtime_node':
      return Object.freeze({ kind, runtimeNodeId: id })
    case 'agent':
      return Object.freeze({ agentId: id, kind })
    case 'worker':
      return Object.freeze({ kind, workerId: id })
    case 'system':
      return Object.freeze({ kind, systemId: id })
  }
}

function summary(row: ArtifactRow): ArtifactSummary {
  const active = row.deletionState === 'active'
  return Object.freeze({
    ...(row.agentId ? { agentId: row.agentId } : {}),
    availability: row.availability,
    checksumSha256: row.checksumSha256,
    createdAt: row.createdAt.toISOString(),
    ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {}),
    deletionState: row.deletionState,
    ...(row.executionRef ? { executionRef: row.executionRef } : {}),
    filename: row.filename,
    id: row.id,
    location: Object.freeze({
      ...(row.externalHarnessId ? { externalHarnessId: row.externalHarnessId } : {}),
      ...(active ? { reference: row.locationRef } : {}),
      ...(row.runtimeNodeId ? { runtimeNodeId: row.runtimeNodeId } : {}),
      type: row.locationType,
    }),
    mediaType: row.mediaType,
    owner: principalRef(row.ownerPrincipalKind, row.ownerPrincipalId),
    provenance: Object.freeze({ ...(row.provenance as JsonObject) }),
    retentionPolicy: row.retentionPolicy,
    sensitivity: row.sensitivity,
    sizeBytes: row.sizeBytes,
    sourceArtifactRef: row.sourceArtifactRef,
    sourcePrincipal: principalRef(row.sourcePrincipalKind, row.sourcePrincipalId),
    ...(row.taskId ? { taskId: row.taskId } : {}),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    workspaceId: row.workspaceId,
  })
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
  if (!membership) throw new Error('Artifact unavailable')
}

async function requireSourcePrincipal(
  database: Database,
  workspaceId: string,
  principal: PrincipalRef
) {
  const id = principalId(principal).trim()
  if (!id || isUnsafeOpaqueReference(id)) throw new Error('Artifact source principal invalid')
  if (principal.kind === 'user') {
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
    if (!membership) throw new Error('Artifact source principal unavailable')
  }
  if (principal.kind === 'agent') {
    const [agent] = await database
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, principal.agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, 'active')
        )
      )
      .limit(1)
    if (!agent) throw new Error('Artifact source principal unavailable')
  }
}

async function requireAssociations(
  database: Database,
  workspaceId: string,
  input: Pick<ArtifactCreateInput, 'agentId' | 'taskId'>
) {
  if (input.agentId) {
    const [agent] = await database
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1)
    if (!agent) throw new Error('Artifact Agent unavailable')
  }
  if (input.taskId) {
    const [task] = await database
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, workspaceId)))
      .limit(1)
    if (!task) throw new Error('Artifact Task unavailable')
  }
}

function normalizeLocation(location: ArtifactLocation): Required<Pick<ArtifactLocation, 'type'>> & {
  externalHarnessId?: string
  reference: string
  runtimeNodeId?: string
} {
  const reference = location.reference?.trim() ?? ''
  if (!reference || reference.length > 1024 || isUnsafeOpaqueReference(reference))
    throw new Error('Artifact location reference invalid')
  const runtimeNodeId = location.runtimeNodeId?.trim()
  const externalHarnessId = location.externalHarnessId?.trim()
  if (
    (runtimeNodeId && isUnsafeOpaqueReference(runtimeNodeId)) ||
    (externalHarnessId && isUnsafeOpaqueReference(externalHarnessId))
  )
    throw new Error('Artifact location invalid')
  if (
    (location.type === 'object_store' && (runtimeNodeId || externalHarnessId)) ||
    (location.type === 'runtime_node' && (!runtimeNodeId || externalHarnessId)) ||
    (location.type === 'external_harness' && (runtimeNodeId || !externalHarnessId))
  )
    throw new Error('Artifact location invalid')
  return {
    ...(externalHarnessId ? { externalHarnessId } : {}),
    reference,
    ...(runtimeNodeId ? { runtimeNodeId } : {}),
    type: location.type,
  }
}

function normalizeInput(owner: UserPrincipalRef, input: ArtifactCreateInput) {
  const filename = input.filename.trim()
  if (!filename || filename.includes('/') || filename.includes('\\'))
    throw new Error('Artifact filename invalid')
  const mediaType = input.mediaType.trim().toLowerCase()
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType))
    throw new Error('Artifact media type invalid')
  const checksumSha256 = input.checksumSha256.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(checksumSha256)) throw new Error('Artifact checksum invalid')
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
    throw new Error('Artifact size invalid')
  const sourceArtifactRef = input.sourceArtifactRef.trim()
  if (
    !sourceArtifactRef ||
    sourceArtifactRef.length > 512 ||
    isUnsafeOpaqueReference(sourceArtifactRef)
  )
    throw new Error('Artifact source reference invalid')
  const provenance = { ...input.provenance }
  if (!isSafeProvenance(provenance)) throw new Error('Artifact provenance invalid')
  const executionRef = input.executionRef?.trim() || null
  if (executionRef && isUnsafeOpaqueReference(executionRef))
    throw new Error('Artifact execution reference invalid')
  const location = normalizeLocation(input.location)
  return {
    agentId: input.agentId ?? null,
    availability: input.availability ?? 'pending',
    checksumSha256,
    executionRef,
    filename,
    location,
    mediaType,
    ownerPrincipalId: owner.userId,
    ownerPrincipalKind: owner.kind,
    provenance,
    retentionPolicy: input.retentionPolicy ?? 'standard',
    sensitivity: input.sensitivity ?? 'workspace',
    sizeBytes: input.sizeBytes,
    sourceArtifactRef,
    sourcePrincipalId: principalId(input.sourcePrincipal).trim(),
    sourcePrincipalKind: input.sourcePrincipal.kind,
    taskId: input.taskId ?? null,
  } as const
}

export async function createArtifact(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: ArtifactCreateInput
): Promise<ArtifactSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    await requireSourcePrincipal(transaction, workspaceId, input.sourcePrincipal)
    await requireAssociations(transaction, workspaceId, input)
    const normalized = normalizeInput(principal, input)
    const createPayloadHash = hashPayload(normalized)
    const [created] = await transaction
      .insert(artifacts)
      .values({
        ...normalized,
        createPayloadHash,
        externalHarnessId: normalized.location.externalHarnessId ?? null,
        locationRef: normalized.location.reference,
        locationType: normalized.location.type,
        provenance: normalized.provenance as JsonObject,
        runtimeNodeId: normalized.location.runtimeNodeId ?? null,
        workspaceId,
      })
      .onConflictDoNothing({ target: [artifacts.workspaceId, artifacts.sourceArtifactRef] })
      .returning()
    if (created) {
      await transaction.insert(workspaceEvents).values({
        eventType: 'artifact.created',
        payload: { actorUserId: principal.userId, artifactId: created.id },
        workspaceId,
      })
      return summary(created)
    }
    const [existing] = await transaction
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, workspaceId),
          eq(artifacts.sourceArtifactRef, normalized.sourceArtifactRef)
        )
      )
      .limit(1)
    if (!existing || existing.createPayloadHash !== createPayloadHash)
      throw new Error('Artifact source conflict')
    return summary(existing)
  })
}

export async function listArtifactsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeDeleted?: boolean }> = {}
): Promise<ArtifactSummary[]> {
  await requireMembership(database, workspaceId, principal)
  const rows = await database
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        ...(options.includeDeleted ? [] : [eq(artifacts.deletionState, 'active')])
      )
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
  return rows.map(summary)
}

export async function getArtifactForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  artifactId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeDeleted?: boolean }> = {}
): Promise<ArtifactSummary | null> {
  const [row] = await database
    .select({ artifact: artifacts })
    .from(artifacts)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, artifacts.workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, workspaceId),
        ...(options.includeDeleted ? [] : [eq(artifacts.deletionState, 'active')])
      )
    )
    .limit(1)
  return row ? summary(row.artifact) : null
}

async function requireArtifact(
  transaction: AgentHqTransaction,
  workspaceId: string,
  artifactId: string
) {
  const [row] = await transaction
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, workspaceId)))
    .limit(1)
  if (!row || row.deletionState === 'deleted') throw new Error('Artifact unavailable')
  return row
}

export async function setArtifactAvailability(
  database: AgentHqDatabase,
  workspaceId: string,
  artifactId: string,
  principal: UserPrincipalRef,
  availability: ArtifactAvailability,
  expectedVersion: number
): Promise<ArtifactSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const row = await requireArtifact(transaction, workspaceId, artifactId)
    if (row.version !== expectedVersion) throw new Error('Artifact version conflict')
    const [updated] = await transaction
      .update(artifacts)
      .set({ availability, updatedAt: new Date(), version: row.version + 1 })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.version, expectedVersion)))
      .returning()
    if (!updated) throw new Error('Artifact version conflict')
    await transaction.insert(workspaceEvents).values({
      eventType: 'artifact.availability_changed',
      payload: { actorUserId: principal.userId, artifactId, availability },
      workspaceId,
    })
    return summary(updated)
  })
}

export async function deleteArtifact(
  database: AgentHqDatabase,
  workspaceId: string,
  artifactId: string,
  principal: UserPrincipalRef,
  expectedVersion: number
): Promise<ArtifactSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const row = await requireArtifact(transaction, workspaceId, artifactId)
    if (row.version !== expectedVersion) throw new Error('Artifact version conflict')
    const deletedAt = new Date()
    const [updated] = await transaction
      .update(artifacts)
      .set({
        availability: 'unavailable',
        deletedAt,
        deletedByPrincipalId: principal.userId,
        deletedByPrincipalKind: 'user',
        deletionState: 'deleted',
        updatedAt: deletedAt,
        version: row.version + 1,
      })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.version, expectedVersion)))
      .returning()
    if (!updated) throw new Error('Artifact version conflict')
    await transaction.insert(workspaceEvents).values({
      eventType: 'artifact.deleted',
      payload: { actorUserId: principal.userId, artifactId },
      workspaceId,
    })
    return summary(updated)
  })
}
