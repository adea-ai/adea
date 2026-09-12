import type {
  PrincipalRef,
  UserPrincipalRef,
  WorkspacePermission,
  WorkspaceSceneId,
  WorkspaceSummary,
} from '@adea-ai/types'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { appendWorkspaceEvent } from './transactions'
import { authorizationAuditRecords, workspaceMemberships, workspaces } from './schema'

export type WorkspaceRole = 'admin' | 'member' | 'owner'

export type WorkspaceMembershipRecord = Readonly<{
  role: WorkspaceRole
  userId: string
  workspaceId: string
}>

function workspaceSummary(row: typeof workspaces.$inferSelect): WorkspaceSummary {
  return Object.freeze({
    id: row.id,
    name: row.name,
    scene: row.scene as WorkspaceSceneId,
    updatedAt: row.updatedAt.toISOString(),
  })
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
    return Object.freeze({ created: false, workspace: workspaceSummary(existingWorkspace) })
  }

  await transaction.insert(workspaceMemberships).values({
    role: 'owner',
    userId: input.owner.userId,
    workspaceId: createdWorkspace.id,
  })
  await appendWorkspaceEvent(transaction, {
    eventType: 'workspace.created',
    payload: { ownerUserId: input.owner.userId },
    workspaceId: createdWorkspace.id,
  })

  return Object.freeze({ created: true, workspace: workspaceSummary(createdWorkspace) })
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

async function workspacesForUser(transaction: AgentHqTransaction, owner: UserPrincipalRef) {
  return transaction
    .select({ workspace: workspaces })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(and(eq(workspaceMemberships.userId, owner.userId), isNull(workspaces.deletedAt)))
    .orderBy(desc(workspaces.updatedAt))
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

    return rows.map(({ workspace }) => workspaceSummary(workspace))
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
    .values({ role, userId: principal.userId, workspaceId })
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
  const rows = await database
    .select({ workspace: workspaces })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
    .where(and(eq(workspaceMemberships.userId, principal.userId), isNull(workspaces.deletedAt)))
    .orderBy(desc(workspaces.updatedAt))
  return rows.map(({ workspace }) => workspaceSummary(workspace))
}

export async function getWorkspaceForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<WorkspaceSummary | null> {
  const [row] = await database
    .select({ workspace: workspaces })
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
  return row ? workspaceSummary(row.workspace) : null
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
    if (!existing.deletedAt) return workspaceSummary(existing)

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
      return workspaceSummary(reopened)
    }
    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.reopened',
      payload: { actorUserId: principal.userId },
      workspaceId,
    })
    return workspaceSummary(workspace)
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
