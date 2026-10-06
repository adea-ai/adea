import type {
  PrincipalRef,
  UserPrincipalRef,
  WorkspaceAccentId,
  WorkspaceLogo,
  WorkspacePermission,
  WorkspaceSceneId,
  WorkspaceSummary,
  WorkspaceUpdate,
} from '@adea-ai/types'
import { and, asc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { appendWorkspaceEvent } from './transactions'
import { authorizationAuditRecords, workspaceMemberships, workspaces } from './schema'

export type WorkspaceRole = 'admin' | 'member' | 'owner'

export type WorkspaceMembershipRecord = Readonly<{
  role: WorkspaceRole
  userId: string
  workspaceId: string
}>

function workspaceLogo(row: typeof workspaces.$inferSelect): WorkspaceLogo {
  return row.logoKind === 'emoji' && row.logoValue
    ? Object.freeze({ kind: 'emoji', value: row.logoValue })
    : Object.freeze({ kind: 'monogram' })
}

function workspaceSummary(
  row: typeof workspaces.$inferSelect,
  sortOrder: number
): WorkspaceSummary {
  return Object.freeze({
    accent: (row.accent as WorkspaceAccentId | null) ?? null,
    id: row.id,
    logo: workspaceLogo(row),
    name: row.name,
    scene: row.scene as WorkspaceSceneId,
    sortOrder,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  })
}

/** A workspace update the caller's own version no longer matches. */
export class WorkspaceVersionConflictError extends Error {
  constructor() {
    super('Workspace version conflict')
    this.name = 'WorkspaceVersionConflictError'
  }
}

/** The next free position in the user's own workspace list. */
async function nextWorkspaceSortOrder(
  transaction: AgentHqTransaction,
  userId: string
): Promise<number> {
  const [row] = await transaction
    .select({ value: max(workspaceMemberships.sortOrder) })
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, userId))
  return row?.value === null || row?.value === undefined ? 0 : row.value + 1
}

async function membershipSortOrder(
  transaction: AgentHqTransaction,
  workspaceId: string,
  userId: string
): Promise<number> {
  const [row] = await transaction
    .select({ sortOrder: workspaceMemberships.sortOrder })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      )
    )
    .limit(1)
  return row?.sortOrder ?? 0
}

type WorkspaceCreationInput = Readonly<{
  idempotencyKey: string
  name: string
  owner: UserPrincipalRef
  scene?: WorkspaceSceneId
}>

async function createWorkspaceWithOwnerInTransaction(
  transaction: AgentHqTransaction,
  input: WorkspaceCreationInput
): Promise<Readonly<{ created: boolean; workspace: WorkspaceSummary }>> {
  const [createdWorkspace] = await transaction
    .insert(workspaces)
    .values({
      idempotencyKey: input.idempotencyKey,
      name: input.name.trim(),
      ownerUserId: input.owner.userId,
      scene: input.scene ?? 'home',
    })
    .onConflictDoNothing({ target: [workspaces.ownerUserId, workspaces.idempotencyKey] })
    .returning()

  if (!createdWorkspace) {
    const [existingWorkspace] = await transaction
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.ownerUserId, input.owner.userId),
          eq(workspaces.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1)
    if (!existingWorkspace) throw new Error('Workspace creation conflict')
    return Object.freeze({
      created: false,
      workspace: workspaceSummary(
        existingWorkspace,
        await membershipSortOrder(transaction, existingWorkspace.id, input.owner.userId)
      ),
    })
  }

  const sortOrder = await nextWorkspaceSortOrder(transaction, input.owner.userId)
  await transaction.insert(workspaceMemberships).values({
    role: 'owner',
    sortOrder,
    userId: input.owner.userId,
    workspaceId: createdWorkspace.id,
  })
  await appendWorkspaceEvent(transaction, {
    eventType: 'workspace.created',
    payload: { ownerUserId: input.owner.userId },
    workspaceId: createdWorkspace.id,
  })

  return Object.freeze({ created: true, workspace: workspaceSummary(createdWorkspace, sortOrder) })
}

export async function createWorkspaceWithOwner(
  database: AgentHqDatabase,
  input: WorkspaceCreationInput
): Promise<Readonly<{ created: boolean; workspace: WorkspaceSummary }>> {
  return database.transaction((transaction) =>
    createWorkspaceWithOwnerInTransaction(transaction, input)
  )
}

const bootstrapWorkspaceInputs = [
  { idempotencyKey: 'default-home', name: 'Home', scene: 'home' as const },
  { idempotencyKey: 'default-work', name: 'Work', scene: 'work' as const },
] as const

/** The user's live workspaces in their own order (position, then creation). */
async function workspacesForUser(
  transaction: AgentHqDatabase | AgentHqTransaction,
  owner: UserPrincipalRef
) {
  return transaction
    .select({ sortOrder: workspaceMemberships.sortOrder, workspace: workspaces })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(and(eq(workspaceMemberships.userId, owner.userId), isNull(workspaces.deletedAt)))
    .orderBy(asc(workspaceMemberships.sortOrder), asc(workspaces.createdAt), asc(workspaces.id))
}

/**
 * Ensures first-launch workspaces exist and upgrades the legacy single default
 * workspace without changing the workspace data stored under its ID.
 */
export async function ensureBootstrapWorkspaces(
  database: AgentHqDatabase,
  owner: UserPrincipalRef
): Promise<WorkspaceSummary[]> {
  return database.transaction(async (transaction) => {
    let rows = await workspacesForUser(transaction, owner)
    const hasBootstrapWorkspace = rows.some(({ workspace }) =>
      ['default', 'default-home', 'default-work'].includes(workspace.idempotencyKey)
    )

    if (rows.length === 0 || hasBootstrapWorkspace) {
      const legacy = rows.find(({ workspace }) => workspace.idempotencyKey === 'default')
      const home = rows.find(({ workspace }) => workspace.idempotencyKey === 'default-home')
      if (legacy && !home) {
        await transaction
          .update(workspaces)
          .set({ idempotencyKey: 'default-home', name: 'Home', scene: 'home' })
          .where(eq(workspaces.id, legacy.workspace.id))
      }

      rows = await workspacesForUser(transaction, owner)
      for (const input of bootstrapWorkspaceInputs) {
        if (!rows.some(({ workspace }) => workspace.idempotencyKey === input.idempotencyKey)) {
          await createWorkspaceWithOwnerInTransaction(transaction, { ...input, owner })
        }
        rows = await workspacesForUser(transaction, owner)
      }
    }

    return rows.map(({ sortOrder, workspace }) => workspaceSummary(workspace, sortOrder))
  })
}

export async function findWorkspaceMembership(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<WorkspaceMembershipRecord | null> {
  const [membership] = await database
    .select({
      role: workspaceMemberships.role,
      userId: workspaceMemberships.userId,
      workspaceId: workspaceMemberships.workspaceId,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId),
        ...(options.includeArchived ? [] : [isNull(workspaces.deletedAt)])
      )
    )
    .limit(1)
  return membership ? Object.freeze(membership) : null
}

export async function addWorkspaceMembership(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  role: Exclude<WorkspaceRole, 'owner'>
): Promise<WorkspaceMembershipRecord> {
  const [membership] = await database
    .insert(workspaceMemberships)
    .values({
      role,
      sortOrder: sql`(select coalesce(max(${workspaceMemberships.sortOrder}) + 1, 0) from ${workspaceMemberships} where ${workspaceMemberships.userId} = ${principal.userId})`,
      userId: principal.userId,
      workspaceId,
    })
    .returning({
      role: workspaceMemberships.role,
      userId: workspaceMemberships.userId,
      workspaceId: workspaceMemberships.workspaceId,
    })
  if (!membership) throw new Error('Workspace membership creation failed')
  return Object.freeze(membership)
}

export async function removeWorkspaceMembership(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    const [workspace] = await transaction
      .select({ ownerUserId: workspaces.ownerUserId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    if (workspace?.ownerUserId === principal.userId) {
      throw new Error('Workspace owner membership cannot be removed')
    }

    const removed = await transaction
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, principal.userId)
        )
      )
      .returning({ id: workspaceMemberships.id })
    return removed.length === 1
  })
}

export async function listWorkspacesForUser(
  database: AgentHqDatabase,
  principal: UserPrincipalRef
): Promise<WorkspaceSummary[]> {
  const rows = await workspacesForUser(database, principal)
  return rows.map(({ sortOrder, workspace }) => workspaceSummary(workspace, sortOrder))
}

export async function getWorkspaceForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<WorkspaceSummary | null> {
  const [row] = await database
    .select({ sortOrder: workspaceMemberships.sortOrder, workspace: workspaces })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId),
        isNull(workspaces.deletedAt)
      )
    )
    .limit(1)
  return row ? workspaceSummary(row.workspace, row.sortOrder) : null
}

export async function archiveWorkspace(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<void> {
  await database.transaction(async (transaction) => {
    const [workspace] = await transaction
      .select({ ownerUserId: workspaces.ownerUserId })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.ownerUserId, principal.userId),
          isNull(workspaces.deletedAt)
        )
      )
      .limit(1)
    if (!workspace) throw new Error('Workspace unavailable')

    const now = new Date()
    await transaction
      .update(workspaces)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(workspaces.id, workspaceId))
    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.archived',
      payload: { actorUserId: principal.userId },
      workspaceId,
    })
  })
}

export async function reopenWorkspace(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<WorkspaceSummary> {
  return database.transaction(async (transaction) => {
    const [existing] = await transaction
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, principal.userId)))
      .limit(1)
    if (!existing) throw new Error('Workspace unavailable')
    const sortOrder = await membershipSortOrder(transaction, workspaceId, principal.userId)
    if (!existing.deletedAt) return workspaceSummary(existing, sortOrder)

    const [workspace] = await transaction
      .update(workspaces)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.ownerUserId, principal.userId),
          isNotNull(workspaces.deletedAt)
        )
      )
      .returning()
    if (!workspace) {
      const [reopened] = await transaction
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, principal.userId)))
        .limit(1)
      if (!reopened || reopened.deletedAt) throw new Error('Workspace unavailable')
      return workspaceSummary(reopened, sortOrder)
    }
    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.reopened',
      payload: { actorUserId: principal.userId },
      workspaceId,
    })
    return workspaceSummary(workspace, sortOrder)
  })
}

/**
 * Applies a versioned update to a live workspace the caller is a member of.
 * The caller's authorization (`workspace.update`) is checked by the route; a
 * stale `expectedVersion` raises `WorkspaceVersionConflictError`.
 */
export async function updateWorkspace(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ expectedVersion: number; update: WorkspaceUpdate }>
): Promise<WorkspaceSummary> {
  return database.transaction(async (transaction) => {
    const [membership] = await transaction
      .select({ sortOrder: workspaceMemberships.sortOrder })
      .from(workspaceMemberships)
      .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, principal.userId),
          isNull(workspaces.deletedAt)
        )
      )
      .limit(1)
    if (!membership) throw new Error('Workspace unavailable')

    const { update } = input
    const [workspace] = await transaction
      .update(workspaces)
      .set({
        ...(update.name !== undefined ? { name: update.name.trim() } : {}),
        ...(update.scene !== undefined ? { scene: update.scene } : {}),
        ...(update.accent !== undefined ? { accent: update.accent } : {}),
        ...(update.logo !== undefined
          ? {
              logoKind: update.logo.kind,
              logoValue: update.logo.kind === 'emoji' ? update.logo.value : null,
            }
          : {}),
        updatedAt: new Date(),
        version: sql`${workspaces.version} + 1`,
      })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.version, input.expectedVersion),
          isNull(workspaces.deletedAt)
        )
      )
      .returning()
    if (!workspace) throw new WorkspaceVersionConflictError()

    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.updated',
      payload: { actorUserId: principal.userId },
      workspaceId,
    })
    return workspaceSummary(workspace, membership.sortOrder)
  })
}

function principalIdentifier(principal: PrincipalRef): string {
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

export async function recordWorkspaceAuthorizationDecision(
  database: AgentHqDatabase,
  record: Readonly<{
    decision: 'allowed' | 'denied'
    permission: WorkspacePermission
    principal: PrincipalRef
    reason: string
    workspaceId: string
  }>
): Promise<void> {
  await database.insert(authorizationAuditRecords).values({
    decision: record.decision,
    permission: record.permission,
    principalId: principalIdentifier(record.principal),
    principalKind: record.principal.kind,
    reason: record.reason,
    workspaceId: record.workspaceId,
  })
}
