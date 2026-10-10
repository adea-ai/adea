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
import { and, asc, desc, eq, isNotNull, isNull, max, inArray, or, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { mintControlPlaneIdentifier } from './control-plane-identifiers'
import { appendWorkspaceEvent } from './transactions'
import {
  authorizationAuditRecords,
  runtimeNodes,
  tasks,
  projectMembers,
  users,
  workspaceDeletions,
  workspaceMemberships,
  workspaces,
} from './schema'

export type WorkspaceRole = 'admin' | 'member' | 'owner'

export type WorkspaceMembershipRecord = Readonly<{
  role: WorkspaceRole
  deletionPending?: boolean
  userId: string
  workspaceId: string
}>

function workspaceLogo(row: typeof workspaces.$inferSelect): WorkspaceLogo {
  return row.logoKind === 'emoji' && row.logoValue
    ? Object.freeze({ kind: 'emoji', value: row.logoValue })
    : Object.freeze({
        kind:
          row.logoKind === 'home' || (row.logoKind === 'monogram' && row.isPersonal)
            ? 'home'
            : 'box',
      })
}

function workspaceSummary(
  row: typeof workspaces.$inferSelect,
  sortOrder: number,
  userId: string
): WorkspaceSummary {
  return Object.freeze({
    canDelete: row.ownerUserId === userId && !isPersonalWorkspace(row),
    canArchive: row.ownerUserId === userId && !isPersonalWorkspace(row),
    isPersonal: row.isPersonal && row.ownerUserId === userId,
    ...(row.deletionRequestedAt ? { deletionPending: true } : {}),
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
  input: WorkspaceCreationInput,
  isPersonal = false
): Promise<Readonly<{ created: boolean; workspace: WorkspaceSummary }>> {
  // Serialize creation with deletion so an old creation key cannot race a
  // deletion receipt and recreate the workspace after its root was removed.
  await transaction
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.owner.userId))
    .for('update')
  const [deleted] = await transaction
    .select({ id: workspaceDeletions.workspaceId })
    .from(workspaceDeletions)
    .where(
      and(
        eq(workspaceDeletions.ownerUserId, input.owner.userId),
        eq(workspaceDeletions.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1)
  if (deleted) throw new Error('Workspace creation conflict')
  const [createdWorkspace] = await transaction
    .insert(workspaces)
    .values({
      controlPlaneWorkspaceId: mintControlPlaneIdentifier('wsp'),
      idempotencyKey: input.idempotencyKey,
      name: input.name.trim(),
      ownerUserId: input.owner.userId,
      isPersonal,
      logoKind: isPersonal ? 'home' : 'box',
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
        await membershipSortOrder(transaction, existingWorkspace.id, input.owner.userId),
        input.owner.userId
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

  return Object.freeze({
    created: true,
    workspace: workspaceSummary(createdWorkspace, sortOrder, input.owner.userId),
  })
}

export async function createWorkspaceWithOwner(
  database: AgentHqDatabase,
  input: WorkspaceCreationInput
): Promise<Readonly<{ created: boolean; workspace: WorkspaceSummary }>> {
  return database.transaction((transaction) =>
    createWorkspaceWithOwnerInTransaction(transaction, input)
  )
}

const legacyPersonalKeys = ['default-home', 'default']

function isPersonalWorkspace(
  row: Pick<typeof workspaces.$inferSelect, 'isPersonal' | 'idempotencyKey'>
): boolean {
  return row.isPersonal
}

/** The root identity is never inferred from a mutable name, logo or scene. */
export class WorkspacePersonalProtectedError extends Error {
  constructor() {
    super(
      'Your personal workspace cannot be deleted or archived. You can rename it and change its settings.'
    )
    this.name = 'WorkspacePersonalProtectedError'
  }
}

/** Caller holds the owner lock. Preserve every setting and ID of a proven legacy root. */
export async function personalWorkspaceInTransaction(
  transaction: AgentHqTransaction,
  ownerUserId: string
) {
  const [existing] = await transaction
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.ownerUserId, ownerUserId),
        or(eq(workspaces.isPersonal, true), inArray(workspaces.idempotencyKey, legacyPersonalKeys))
      )
    )
    .orderBy(
      desc(workspaces.isPersonal),
      sql`case when ${workspaces.idempotencyKey} = 'default-home' then 0 else 1 end`,
      asc(workspaces.createdAt),
      asc(workspaces.id)
    )
    .limit(1)
    .for('update')
  if (!existing || existing.isPersonal) return existing
  const [promoted] = await transaction
    .update(workspaces)
    .set({
      isPersonal: true,
      deletedAt: null,
      deletionRequestedAt: null,
      updatedAt: new Date(),
      version: sql`${workspaces.version} + 1`,
    })
    .where(eq(workspaces.id, existing.id))
    .returning()
  return promoted
}

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
 * Exactly one persistent personal/root workspace per owner. Only stable legacy
 * seed markers are promoted. Ambiguous claimed workspaces are retained and a
 * new root is added; Home/Work names alone never identify a personal workspace.
 */
export async function ensureBootstrapWorkspaces(
  database: AgentHqDatabase,
  owner: UserPrincipalRef
): Promise<WorkspaceSummary[]> {
  return database.transaction(async (transaction) => {
    await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, owner.userId))
      .for('update')
    const personal = await personalWorkspaceInTransaction(transaction, owner.userId)
    if (!personal)
      await createWorkspaceWithOwnerInTransaction(
        transaction,
        {
          idempotencyKey: `personal:${crypto.randomUUID()}`,
          name: 'Home',
          scene: 'home',
          owner,
        },
        true
      )
    else {
      // Repair a missing owner membership without moving an existing one.
      await transaction
        .insert(workspaceMemberships)
        .values({
          role: 'owner',
          userId: owner.userId,
          workspaceId: personal.id,
          sortOrder: await nextWorkspaceSortOrder(transaction, owner.userId),
        })
        .onConflictDoNothing({
          target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
        })
    }
    const rows = await workspacesForUser(transaction, owner)
    return rows.map(({ sortOrder, workspace }) =>
      workspaceSummary(workspace, sortOrder, owner.userId)
    )
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
      deletionRequestedAt: workspaces.deletionRequestedAt,
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
  if (!membership) return null
  const { deletionRequestedAt, ...record } = membership
  return Object.freeze({ ...record, ...(deletionRequestedAt ? { deletionPending: true } : {}) })
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
    // Project lists only grant access alongside a workspace membership; drop
    // them too so a later re-join starts with no project access.
    await transaction
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.workspaceId, workspaceId),
          eq(projectMembers.userId, principal.userId)
        )
      )
    return removed.length === 1
  })
}

export async function listWorkspacesForUser(
  database: AgentHqDatabase,
  principal: UserPrincipalRef
): Promise<WorkspaceSummary[]> {
  const rows = await workspacesForUser(database, principal)
  return rows.map(({ sortOrder, workspace }) =>
    workspaceSummary(workspace, sortOrder, principal.userId)
  )
}

/** Reorders only this member's own complete live list, including their personal root. */
export async function reorderWorkspaces(
  database: AgentHqDatabase,
  principal: UserPrincipalRef,
  workspaceIds: readonly string[]
): Promise<WorkspaceSummary[]> {
  return database.transaction(async (transaction) => {
    await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, principal.userId))
      .for('update')
    const rows = await workspacesForUser(transaction, principal)
    const liveIds = new Set(rows.map(({ workspace }) => workspace.id))
    if (
      workspaceIds.length !== liveIds.size ||
      new Set(workspaceIds).size !== workspaceIds.length ||
      workspaceIds.some((id) => !liveIds.has(id))
    )
      throw new Error('Workspace order conflict')
    for (const [sortOrder, workspaceId] of workspaceIds.entries())
      await transaction
        .update(workspaceMemberships)
        .set({ sortOrder, updatedAt: new Date() })
        .where(
          and(
            eq(workspaceMemberships.userId, principal.userId),
            eq(workspaceMemberships.workspaceId, workspaceId)
          )
        )
    return (await workspacesForUser(transaction, principal)).map(({ sortOrder, workspace }) =>
      workspaceSummary(workspace, sortOrder, principal.userId)
    )
  })
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
  return row ? workspaceSummary(row.workspace, row.sortOrder, principal.userId) : null
}

export class WorkspaceCleanupRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceCleanupRequiredError'
  }
}
async function assertSupportedWorkspaceDeletion(
  transaction: AgentHqTransaction,
  workspace: typeof workspaces.$inferSelect,
  device: boolean
) {
  if (workspace.controlPlaneUsedAt)
    throw new WorkspaceCleanupRequiredError(
      'This workspace may have Control Plane skills, profiles, credentials, installations or execution data. Workspace-wide cleanup is not supported yet; the workspace has been kept.'
    )
  const [node] = await transaction
    .select({ id: runtimeNodes.id })
    .from(runtimeNodes)
    .where(eq(runtimeNodes.workspaceId, workspace.id))
    .limit(1)
  if (node)
    throw new WorkspaceCleanupRequiredError(
      'This workspace has registered runtime devices. Workspace cleanup acknowledgements are not supported yet; the workspace and device registrations have been kept.'
    )
  const [live] = await transaction
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspace.id),
        inArray(tasks.lifecycleState, ['queued', 'in_progress', 'in_review'])
      )
    )
    .limit(1)
  if (live)
    throw new WorkspaceCleanupRequiredError(
      'Stop running or queued workspace tasks before deleting this workspace. The workspace has been kept.'
    )
  if (!device)
    throw new WorkspaceCleanupRequiredError(
      'Open this workspace in the Adea desktop app to verify device-local cleanup before deletion. The browser cannot verify device resources; the workspace has been kept.'
    )
}
/**
 * There is no server-owned native cleanup-completion verifier yet. A desktop
 * origin, owner credential or prepare timestamp proves neither completion nor
 * local data removal. Fail closed before creating intent or cascading data.
 * Only a future verified owner contract can replace this gate.
 */
async function assertVerifiedWorkspaceCleanupCompletion(): Promise<void> {
  throw new WorkspaceCleanupRequiredError(
    'Permanent workspace deletion is unavailable because Adea cannot verify cleanup completion on the server yet. The workspace and its data have been kept.'
  )
}

/** Validate preparation; refuse new intent until cleanup completion can be verified. */
export async function beginWorkspaceDeletion(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ confirmationName: string; expectedVersion: number }>
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, principal.userId))
      .for('update')
    const [protectedRoot] = await transaction
      .select({ isPersonal: workspaces.isPersonal, idempotencyKey: workspaces.idempotencyKey })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, principal.userId)))
      .limit(1)
    if (protectedRoot && isPersonalWorkspace(protectedRoot))
      throw new WorkspacePersonalProtectedError()
    const [receipt] = await transaction
      .select()
      .from(workspaceDeletions)
      .where(eq(workspaceDeletions.workspaceId, workspaceId))
      .limit(1)
    if (receipt) {
      if (receipt.ownerUserId !== principal.userId) throw new Error('Workspace unavailable')
      if (protectedRoot) await assertVerifiedWorkspaceCleanupCompletion()
      return
    }
    const [workspace] = await transaction
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, principal.userId)))
      .for('update')
      .limit(1)
    if (!workspace) throw new Error('Workspace unavailable')
    if (workspace.version !== input.expectedVersion || workspace.name !== input.confirmationName)
      throw new WorkspaceVersionConflictError()
    await assertSupportedWorkspaceDeletion(transaction, workspace, true)
    await assertVerifiedWorkspaceCleanupCompletion()
    if (!workspace.deletionRequestedAt)
      await transaction
        .update(workspaces)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(workspaces.id, workspaceId))
  })
}

/** Fresh owner-only deletion proof; no cached membership can prove a purge. */
export async function workspaceDeletionState(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<'active' | 'cleanup_pending' | 'deleted' | null> {
  const [protectedRoot] = await database
    .select({ isPersonal: workspaces.isPersonal })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, principal.userId)))
    .limit(1)
  if (protectedRoot?.isPersonal) return null
  const [receipt] = await database
    .select({ id: workspaceDeletions.workspaceId })
    .from(workspaceDeletions)
    .where(
      and(
        eq(workspaceDeletions.workspaceId, workspaceId),
        eq(workspaceDeletions.ownerUserId, principal.userId)
      )
    )
    .limit(1)
  // A receipt alone is never proof while its owned cloud root still exists.
  if (receipt && !protectedRoot) return 'deleted'
  const [workspace] = await database
    .select({
      id: workspaces.id,
      pending: workspaces.deletionRequestedAt,
      isPersonal: workspaces.isPersonal,
      idempotencyKey: workspaces.idempotencyKey,
    })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, principal.userId)))
    .limit(1)
  return workspace && !isPersonalWorkspace(workspace)
    ? workspace.pending
      ? 'cleanup_pending'
      : 'active'
    : null
}

/** Permanent product-data deletion; external harness history and files are not owned here. */
export async function deleteWorkspace(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    expectedVersion: number
    confirmationName: string
    device?: boolean
  }>
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, principal.userId))
      .for('update')
    const [protectedRoot] = await transaction
      .select({ isPersonal: workspaces.isPersonal, idempotencyKey: workspaces.idempotencyKey })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, principal.userId)))
      .limit(1)
    if (protectedRoot && isPersonalWorkspace(protectedRoot))
      throw new WorkspacePersonalProtectedError()
    const [receipt] = await transaction
      .select()
      .from(workspaceDeletions)
      .where(eq(workspaceDeletions.workspaceId, workspaceId))
      .limit(1)
    if (receipt) {
      if (receipt.ownerUserId !== principal.userId) throw new Error('Workspace unavailable')
      if (protectedRoot) await assertVerifiedWorkspaceCleanupCompletion()
      return
    }
    const [workspace] = await transaction
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, principal.userId)))
      .for('update')
      .limit(1)
    if (!workspace) throw new Error('Workspace unavailable')
    if (workspace.version !== input.expectedVersion || workspace.name !== input.confirmationName)
      throw new WorkspaceVersionConflictError()
    // `device` selects an explanatory refusal only; it is never completion proof.
    await assertSupportedWorkspaceDeletion(transaction, workspace, Boolean(input.device))
    await assertVerifiedWorkspaceCleanupCompletion()
    // Reserved for a future server-owned completion verifier. No caller flag,
    // desktop header or prepare receipt can reach this cascade today.
    await transaction.insert(workspaceDeletions).values({
      workspaceId,
      ownerUserId: principal.userId,
      idempotencyKey: workspace.idempotencyKey,
    })
    // Memberships deliberately use RESTRICT; audits deliberately have no FK.
    // Every other workspace-owned row follows the root's verified FK cascades.
    await transaction
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
    await transaction
      .delete(authorizationAuditRecords)
      .where(eq(authorizationAuditRecords.workspaceId, workspaceId))
    await transaction.delete(workspaces).where(eq(workspaces.id, workspaceId))
  })
}

export async function archiveWorkspace(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<void> {
  await database.transaction(async (transaction) => {
    const [workspace] = await transaction
      .select({
        ownerUserId: workspaces.ownerUserId,
        isPersonal: workspaces.isPersonal,
        idempotencyKey: workspaces.idempotencyKey,
      })
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
    if (isPersonalWorkspace(workspace)) throw new WorkspacePersonalProtectedError()

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
    if (!existing.deletedAt) return workspaceSummary(existing, sortOrder, principal.userId)

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
      return workspaceSummary(reopened, sortOrder, principal.userId)
    }
    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.reopened',
      payload: { actorUserId: principal.userId },
      workspaceId,
    })
    return workspaceSummary(workspace, sortOrder, principal.userId)
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
          isNull(workspaces.deletedAt),
          isNull(workspaces.deletionRequestedAt)
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
          isNull(workspaces.deletedAt),
          isNull(workspaces.deletionRequestedAt)
        )
      )
      .returning()
    if (!workspace) throw new WorkspaceVersionConflictError()

    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.updated',
      payload: { actorUserId: principal.userId },
      workspaceId,
    })
    return workspaceSummary(workspace, membership.sortOrder, principal.userId)
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
