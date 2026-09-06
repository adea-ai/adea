import type { AgentProfileState, AgentSummary, UserPrincipalRef } from "@adea/types";
import { and, asc, eq } from "drizzle-orm";
import type { AgentHqDatabase, AgentHqTransaction } from "./connection";
import { agents, rooms, workspaceEvents, workspaceMemberships } from "./schema";

type AgentCreateInput = Readonly<{
  avatarRef?: string;
  characterRef?: string;
  name: string;
  presentationMetadata?: Readonly<Record<string, string>>;
  profileId: string;
  profileVersion: string;
  roleSummary?: string;
  roomId?: string;
}>;

type AgentPresentationInput = Readonly<{
  avatarRef?: string | null;
  characterRef?: string | null;
  name?: string;
  presentationMetadata?: Readonly<Record<string, string>>;
  roleSummary?: string | null;
}>;

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
    }),
    ...(row.roleSummary ? { roleSummary: row.roleSummary } : {}),
    ...(row.roomId ? { roomId: row.roomId } : {}),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
  });
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
    .limit(1);
  if (!membership) throw new Error("Agent unavailable");
}

async function requireActiveRoom(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  roomId: string
) {
  const [room] = await database
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        eq(rooms.id, roomId),
        eq(rooms.workspaceId, workspaceId),
        eq(rooms.lifecycleState, "active")
      )
    )
    .limit(1);
  if (!room) throw new Error("Room unavailable");
}

export async function createAgent(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: AgentCreateInput
): Promise<AgentSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    if (input.roomId) await requireActiveRoom(transaction, workspaceId, input.roomId);
    const [created] = await transaction
      .insert(agents)
      .values({
        avatarRef: input.avatarRef?.trim() || null,
        characterRef: input.characterRef?.trim() || null,
        name: input.name.trim(),
        presentationMetadata: { ...(input.presentationMetadata ?? {}) },
        profileId: input.profileId.trim(),
        profileVersion: input.profileVersion.trim(),
        roleSummary: input.roleSummary?.trim() || null,
        roomId: input.roomId ?? null,
        workspaceId,
      })
      .returning();
    if (!created) throw new Error("Agent creation failed");
    await transaction.insert(workspaceEvents).values({
      eventType: "agent.created",
      payload: { actorUserId: principal.userId, agentId: created.id },
      workspaceId,
    });
    return summary(created);
  });
}

export async function listAgentsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<AgentSummary[]> {
  await requireMembership(database, workspaceId, principal);
  const rows = await database
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        ...(options.includeArchived ? [] : [eq(agents.lifecycleState, "active")])
      )
    )
    .orderBy(asc(agents.name), asc(agents.id));
  return rows.map(summary);
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
        ...(options.includeArchived ? [] : [eq(agents.lifecycleState, "active")])
      )
    )
    .limit(1);
  return row ? summary(row.agent) : null;
}

export async function assignAgentToRoom(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef,
  roomId: string | null
): Promise<AgentSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    if (roomId) await requireActiveRoom(transaction, workspaceId, roomId);
    const [updated] = await transaction
      .update(agents)
      .set({ roomId, updatedAt: new Date() })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, "active")
        )
      )
      .returning();
    if (!updated) throw new Error("Agent unavailable");
    await transaction.insert(workspaceEvents).values({
      eventType: "agent.room_assigned",
      payload: { actorUserId: principal.userId, agentId, roomId },
      workspaceId,
    });
    return summary(updated);
  });
}

export async function updateAgentPresentation(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef,
  input: AgentPresentationInput
): Promise<AgentSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
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
          eq(agents.lifecycleState, "active")
        )
      )
      .returning();
    if (!updated) throw new Error("Agent unavailable");
    await transaction.insert(workspaceEvents).values({
      eventType: "agent.presentation_updated",
      payload: { actorUserId: principal.userId, agentId },
      workspaceId,
    });
    return summary(updated);
  });
}

export async function changeAgentProfile(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ profileId: string; profileState?: AgentProfileState; profileVersion: string }>
): Promise<AgentSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    const [updated] = await transaction
      .update(agents)
      .set({
        profileId: input.profileId.trim(),
        profileState: input.profileState ?? "available",
        profileVersion: input.profileVersion.trim(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, "active")
        )
      )
      .returning();
    if (!updated) throw new Error("Agent unavailable");
    await transaction.insert(workspaceEvents).values({
      eventType: "agent.profile_changed",
      payload: {
        actorUserId: principal.userId,
        agentId,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
      },
      workspaceId,
    });
    return summary(updated);
  });
}

export async function archiveAgent(
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef
): Promise<void> {
  await database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    const [updated] = await transaction
      .update(agents)
      .set({ lifecycleState: "archived", updatedAt: new Date() })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.workspaceId, workspaceId),
          eq(agents.lifecycleState, "active")
        )
      )
      .returning({ id: agents.id });
    if (!updated) throw new Error("Agent unavailable");
    await transaction.insert(workspaceEvents).values({
      eventType: "agent.archived",
      payload: { actorUserId: principal.userId, agentId },
      workspaceId,
    });
  });
}
