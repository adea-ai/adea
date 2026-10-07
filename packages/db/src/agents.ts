import type { AgentProfileState, AgentSummary, UserPrincipalRef } from '@adea-ai/types'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { agents, projects, workspaceMemberships, workspaces } from './schema'
import { appendWorkspaceEvent } from './transactions'

type AgentCreateInput = Readonly<{
  avatarRef?: string
  characterRef?: string
  name: string
  presentationMetadata?: Readonly<Record<string, string>>
  profileId: string
  profileVersion: string
  roleSummary?: string
  projectId?: string
}>

type AgentPresentationInput = Readonly<{
  avatarRef?: string | null
  characterRef?: string | null
  name?: string
  presentationMetadata?: Readonly<Record<string, string>>
  roleSummary?: string | null
}>

function summary(row: typeof agents.$inferSelect): AgentSummary {
  return Object.freeze({
    ...(row.avatarRef ? { avatarRef: row.avatarRef } : {}),
    ...(row.characterRef ? { characterRef: row.characterRef } : {}),
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    lifecycleState: row.lifecycleState,
    name: row.name,
    presentationMetadata: Object.freeze(row.presentationMetadata as Record<string, string>),
    profile: Object.freeze({
      id: row.profileId,
      state: row.profileState,
      version: row.profileVersion,
      revision: row.profileRevision,
    }),
    ...(row.roleSummary ? { roleSummary: row.roleSummary } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
  })
}

async function requireMembership(
  database: AgentHqDatabase | AgentHqTransaction,
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
  if (!membership) throw new Error('Agent unavailable')
}

async function requireActiveProject(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  projectId: string
) {
  const [project] = await database
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.workspaceId, workspaceId),
        eq(projects.lifecycleState, 'active')
      )
    )
    .limit(1)
  if (!project) throw new Error('Project unavailable')
}

async function requireProfileManager(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  // Hold membership and workspace identity through commit, including role/archive races.
  const [membership] = await transaction
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId),
        isNull(workspaces.deletedAt)
      )
    )
    .for('share')
  if (!membership || !['owner', 'admin'].includes(membership.role))
    throw new Error('Agent unavailable')
}

export async function createAgent(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: AgentCreateInput
): Promise<AgentSummary> {
  return database.transaction(async (transaction) => {
    await requireProfileManager(transaction, workspaceId, principal)
    if (input.projectId) await requireActiveProject(transaction, workspaceId, input.projectId)
    const [created] = await transaction
      .insert(agents)
      .values({
        avatarRef: input.avatarRef?.trim() || null,
        characterRef: input.characterRef?.trim() || null,
        name: input.name.trim(),
        presentationMetadata: { ...input.presentationMetadata },
        profileId: input.profileId.trim(),
        profileVersion: input.profileVersion.trim(),
        roleSummary: input.roleSummary?.trim() || null,
        projectId: input.projectId ?? null,
        workspaceId,
      })
      .returning()
    if (!created) throw new Error('Agent creation failed')
    await appendWorkspaceEvent(transaction, {
      eventType: 'agent.created',
      payload: { actorUserId: principal.userId, agentId: created.id },
      workspaceId,
    })
    return summary(created)
  })
}

export async function listAgentsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<AgentSummary[]> {
  await requireMembership(database, workspaceId, principal)
  const rows = await database
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        ...(options.includeArchived ? [] : [eq(agents.lifecycleState, 'active')])
      )
    )
    .orderBy(asc(agents.name), asc(agents.id))
  return rows.map(summary)
}

export async function getAgentForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<AgentSummary | null> {
  const [row] = await database
    .select({ agent: agents })
    .from(agents)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, agents.workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.workspaceId, workspaceId),
        ...(options.includeArchived ? [] : [eq(agents.lifecycleState, 'active')])
      )
    )
    .limit(1)
  return row ? summary(row.agent) : null
}

export async function assignAgentToProject(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef,
  projectId: string | null
): Promise<AgentSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    if (projectId) await requireActiveProject(transaction, workspaceId, projectId)
    const [updated] = await transaction
      .update(agents)
      .set({ projectId, updatedAt: new Date() })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, 'active')
        )
      )
      .returning()
    if (!updated) throw new Error('Agent unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'agent.project_assigned',
      payload: { actorUserId: principal.userId, agentId, projectId },
      workspaceId,
    })
    return summary(updated)
  })
}

export async function updateAgentPresentation(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef,
  input: AgentPresentationInput
): Promise<AgentSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const [updated] = await transaction
      .update(agents)
      .set({
        ...(input.avatarRef !== undefined ? { avatarRef: input.avatarRef?.trim() || null } : {}),
        ...(input.characterRef !== undefined
          ? { characterRef: input.characterRef?.trim() || null }
          : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.presentationMetadata !== undefined
          ? { presentationMetadata: { ...input.presentationMetadata } }
          : {}),
        ...(input.roleSummary !== undefined
          ? { roleSummary: input.roleSummary?.trim() || null }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, 'active')
        )
      )
      .returning()
    if (!updated) throw new Error('Agent unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'agent.presentation_updated',
      payload: { actorUserId: principal.userId, agentId },
      workspaceId,
    })
    return summary(updated)
  })
}

export async function changeAgentProfile(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    expectedRevision: number
    profileId: string
    profileState?: AgentProfileState
    profileVersion: string
  }>
): Promise<AgentSummary> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new AgentProfileConflictError()
  return database.transaction(async (transaction) => {
    await requireProfileManager(transaction, workspaceId, principal)
    const [previous] = await transaction
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, 'active')
        )
      )
      .for('update')
    if (!previous) throw new Error('Agent unavailable')
    if (previous.profileRevision !== input.expectedRevision) throw new AgentProfileConflictError()
    const [updated] = await transaction
      .update(agents)
      .set({
        profileId: input.profileId.trim(),
        profileState: input.profileState ?? 'available',
        profileVersion: input.profileVersion.trim(),
        profileRevision: previous.profileRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, 'active')
        )
      )
      .returning()
    if (!updated) throw new Error('Agent unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'agent.profile_changed',
      payload: {
        actorUserId: principal.userId,
        agentId,
        profileId: updated.profileId,
        profileVersion: updated.profileVersion,
        previousProfileId: previous.profileId,
        previousProfileVersion: previous.profileVersion,
        profileRevision: updated.profileRevision,
      },
      workspaceId,
    })
    return summary(updated)
  })
}

export class AgentProfileConflictError extends Error {
  constructor() {
    super('Agent profile changed; refresh and retry')
    this.name = 'AgentProfileConflictError'
  }
}

export async function archiveAgent(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef
): Promise<void> {
  await database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const [updated] = await transaction
      .update(agents)
      .set({ lifecycleState: 'archived', updatedAt: new Date() })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, 'active')
        )
      )
      .returning({ id: agents.id })
    if (!updated) throw new Error('Agent unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'agent.archived',
      payload: { actorUserId: principal.userId, agentId },
      workspaceId,
    })
  })
}
