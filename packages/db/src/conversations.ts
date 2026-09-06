import { createHash, randomUUID } from "node:crypto";

import type {
  ChannelSummary,
  ConversationParticipantRef,
  MessageSenderRef,
  MessageSummary,
  UserPrincipalRef,
} from "@adea-ai/types";
import { and, asc, eq, gt, inArray, isNull, max } from "drizzle-orm";

import type { AgentHqDatabase, AgentHqTransaction } from "./connection";
import { attachMessageContentRef } from "./content-refs";
import { reopenTasksForChannelMessage } from "./tasks";
import {
  agents,
  artifacts,
  channelParticipants,
  channels,
  messageArtifactReferences,
  messageMentions,
  messages,
  rooms,
  tasks,
  workspaceEvents,
  workspaceMemberships,
} from "./schema";

type Database = AgentHqDatabase | AgentHqTransaction;
type ChannelRow = typeof channels.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  return value;
}

function hashPayload(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
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
    .limit(1);
  if (!membership) throw new Error("Channel unavailable");
}

async function requireActiveRoom(database: Database, workspaceId: string, roomId: string) {
  const [room] = await database
    .select()
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
  return room;
}

async function requireActiveAgent(database: Database, workspaceId: string, agentId: string) {
  const [agent] = await database
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.workspaceId, workspaceId),
        eq(agents.lifecycleState, "active")
      )
    )
    .limit(1);
  if (!agent) throw new Error("Agent unavailable");
}

async function requireWorkspaceUser(database: Database, workspaceId: string, userId: string) {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      )
    )
    .limit(1);
  if (!membership) throw new Error("Conversation participant unavailable");
}

async function validateParticipant(
  database: Database,
  workspaceId: string,
  participant: ConversationParticipantRef
) {
  if (participant.kind === "user")
    await requireWorkspaceUser(database, workspaceId, participant.userId);
  else await requireActiveAgent(database, workspaceId, participant.agentId);
}

async function channelSummary(database: Database, row: ChannelRow): Promise<ChannelSummary> {
  const participantRows = await database
    .select()
    .from(channelParticipants)
    .where(
      and(
        eq(channelParticipants.workspaceId, row.workspaceId),
        eq(channelParticipants.channelId, row.id)
      )
    );
  const participants = participantRows
    .map((participant): ConversationParticipantRef =>
      participant.principalKind === "user"
        ? { kind: "user", userId: participant.userId! }
        : { agentId: participant.agentId!, kind: "agent" }
    )
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return Object.freeze({
    ...(row.agentId ? { agentId: row.agentId } : {}),
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    isPrimaryRoomChannel: row.isPrimaryRoomChannel,
    kind: row.kind,
    lifecycleState: row.lifecycleState,
    participants: Object.freeze(participants),
    ...(row.roomId ? { roomId: row.roomId } : {}),
    sortOrder: row.sortOrder,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  });
}

async function requireChannel(database: Database, workspaceId: string, channelId: string) {
  const [channel] = await database
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.workspaceId, workspaceId),
        eq(channels.lifecycleState, "active")
      )
    )
    .limit(1);
  if (!channel) throw new Error("Channel unavailable");
  return channel;
}

async function requireChannelAccess(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
) {
  const channel = await requireChannel(database, workspaceId, channelId);
  if (channel.visibility === "participants") {
    const [participant] = await database
      .select({ id: channelParticipants.id })
      .from(channelParticipants)
      .where(
        and(
          eq(channelParticipants.workspaceId, workspaceId),
          eq(channelParticipants.channelId, channelId),
          eq(channelParticipants.principalKind, "user"),
          eq(channelParticipants.userId, principal.userId)
        )
      )
      .limit(1);
    if (!participant) throw new Error("Channel unavailable");
  }
  return channel;
}

async function nextChannelSortOrder(database: Database, workspaceId: string) {
  const [position] = await database
    .select({ value: max(channels.sortOrder) })
    .from(channels)
    .where(eq(channels.workspaceId, workspaceId));
  return (position?.value ?? -1) + 1;
}

async function findActiveDirectAgentChannel(
  database: Database,
  workspaceId: string,
  agentId: string
) {
  const [row] = await database
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.agentId, agentId),
        eq(channels.kind, "direct_agent"),
        eq(channels.lifecycleState, "active")
      )
    )
    .limit(1);
  return row ?? null;
}

export async function provisionPrimaryRoomChannelInTransaction(
  transaction: AgentHqTransaction,
  workspaceId: string,
  roomId: string,
  roomName: string
): Promise<ChannelSummary> {
  const idempotencyKey = `primary-room:${roomId}`;
  const [created] = await transaction
    .insert(channels)
    .values({
      idempotencyKey,
      isPrimaryRoomChannel: true,
      kind: "room",
      roomId,
      sortOrder: await nextChannelSortOrder(transaction, workspaceId),
      title: roomName.trim(),
      visibility: "workspace",
      workspaceId,
    })
    .onConflictDoNothing({ target: [channels.workspaceId, channels.idempotencyKey] })
    .returning();
  if (created) {
    await transaction.insert(workspaceEvents).values({
      eventType: "channel.created",
      payload: { channelId: created.id, kind: "room", roomId },
      workspaceId,
    });
    return channelSummary(transaction, created);
  }
  const [existing] = await transaction
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (!existing || existing.kind !== "room" || existing.roomId !== roomId)
    throw new Error("Primary Room Channel conflict");
  if (existing.lifecycleState === "archived") {
    const [restored] = await transaction
      .update(channels)
      .set({ lifecycleState: "active", updatedAt: new Date(), version: existing.version + 1 })
      .where(and(eq(channels.id, existing.id), eq(channels.version, existing.version)))
      .returning();
    if (!restored) throw new Error("Channel version conflict");
    return channelSummary(transaction, restored);
  }
  return channelSummary(transaction, existing);
}

export async function provisionPrimaryRoomChannel(
  database: AgentHqDatabase,
  workspaceId: string,
  roomId: string,
  principal: UserPrincipalRef
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    const room = await requireActiveRoom(transaction, workspaceId, roomId);
    return provisionPrimaryRoomChannelInTransaction(transaction, workspaceId, roomId, room.name);
  });
}

async function createChannel(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    agentId?: string;
    idempotencyKey: string;
    kind: "room" | "direct_agent" | "group";
    roomId?: string;
    taskId?: string;
    title: string;
    visibility: "workspace" | "participants";
  }>
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    if (input.roomId) await requireActiveRoom(transaction, workspaceId, input.roomId);
    if (input.agentId) await requireActiveAgent(transaction, workspaceId, input.agentId);
    if (input.taskId) {
      const [task] = await transaction
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, workspaceId)))
        .limit(1);
      if (!task) throw new Error("Task unavailable");
    }
    const [created] = await transaction
      .insert(channels)
      .values({
        agentId: input.agentId ?? null,
        idempotencyKey: input.idempotencyKey.trim(),
        kind: input.kind,
        roomId: input.roomId ?? null,
        sortOrder: await nextChannelSortOrder(transaction, workspaceId),
        taskId: input.taskId ?? null,
        title: input.title.trim(),
        visibility: input.visibility,
        workspaceId,
      })
      .onConflictDoNothing({ target: [channels.workspaceId, channels.idempotencyKey] })
      .returning();
    let channel = created;
    if (!channel) {
      [channel] = await transaction
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, workspaceId),
            eq(channels.idempotencyKey, input.idempotencyKey.trim())
          )
        )
        .limit(1);
      if (
        !channel ||
        channel.kind !== input.kind ||
        channel.roomId !== (input.roomId ?? null) ||
        channel.agentId !== (input.agentId ?? null) ||
        channel.taskId !== (input.taskId ?? null) ||
        channel.title !== input.title.trim() ||
        channel.visibility !== input.visibility
      )
        throw new Error("Channel idempotency conflict");
    } else {
      await transaction.insert(workspaceEvents).values({
        eventType: "channel.created",
        payload: { actorUserId: principal.userId, channelId: channel.id, kind: channel.kind },
        workspaceId,
      });
    }
    if (created && channel.visibility === "participants") {
      await transaction.insert(channelParticipants).values([
        {
          channelId: channel.id,
          principalKind: "user",
          userId: principal.userId,
          workspaceId,
        },
        ...(channel.agentId
          ? [
              {
                agentId: channel.agentId,
                channelId: channel.id,
                principalKind: "agent" as const,
                workspaceId,
              },
            ]
          : []),
      ]);
    }
    return channelSummary(transaction, channel);
  });
}

export const createRoomChannel = (
  database: AgentHqDatabase,
  workspaceId: string,
  roomId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ idempotencyKey: string; taskId?: string; title: string }>
) =>
  createChannel(database, workspaceId, principal, {
    ...input,
    kind: "room",
    roomId,
    visibility: "workspace",
  });

export const createDirectAgentChannel = async (
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef
) => {
  await requireMembership(database, workspaceId, principal);
  await requireActiveAgent(database, workspaceId, agentId);
  // Semantic idempotency first: at most one active direct channel may exist per
  // agent, but the canonical idempotency key can point at an archived row while
  // the live row (created by the reopen path below) carries a suffixed key.
  // Opening the conversation must return the live row instead of attempting a
  // fresh insert that would violate channels_active_direct_agent_unique.
  const live = await findActiveDirectAgentChannel(database, workspaceId, agentId);
  if (live) return channelSummary(database, live);
  try {
    const existing = await createChannel(database, workspaceId, principal, {
      agentId,
      idempotencyKey: `direct-agent:${agentId}`,
      kind: "direct_agent",
      title: "Direct conversation",
      visibility: "participants",
    });
    if (existing.lifecycleState === "active") return existing;
    // A deleted conversation stays deleted: opening a new one starts fresh
    // history under a unique key instead of resurrecting the archived row.
    return await createChannel(database, workspaceId, principal, {
      agentId,
      idempotencyKey: `direct-agent:${agentId}:${randomUUID()}`,
      kind: "direct_agent",
      title: "Direct conversation",
      visibility: "participants",
    });
  } catch (error) {
    // A concurrent open may have inserted the live row after the lookup above.
    // Return it instead of surfacing the unique violation as a generic error.
    if (error instanceof Error && error.message.includes("channels_active_direct_agent_unique")) {
      const retry = await findActiveDirectAgentChannel(database, workspaceId, agentId);
      if (retry) return channelSummary(database, retry);
    }
    throw error;
  }
};

export const createGroupChannel = (
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ idempotencyKey: string; taskId?: string; title: string }>
) =>
  createChannel(database, workspaceId, principal, {
    ...input,
    kind: "group",
    visibility: "participants",
  });

export async function listChannelsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
) {
  await requireMembership(database, workspaceId, principal);
  const rows = await database
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        ...(options.includeArchived ? [] : [eq(channels.lifecycleState, "active")])
      )
    )
    .orderBy(asc(channels.sortOrder), asc(channels.id));
  const summaries = await Promise.all(rows.map((row) => channelSummary(database, row)));
  return summaries.filter(
    (channel) =>
      channel.visibility === "workspace" ||
      channel.participants.some(
        (participant) => participant.kind === "user" && participant.userId === principal.userId
      )
  );
}

export async function getChannelForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
) {
  await requireMembership(database, workspaceId, principal);
  const channel = await requireChannelAccess(database, workspaceId, channelId, principal);
  return channelSummary(database, channel);
}

export async function updateChannel(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    taskId?: string | null;
    title?: string;
    visibility?: "workspace" | "participants";
  }>,
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    const channel = await requireChannel(transaction, workspaceId, channelId);
    if (channel.version !== expectedVersion) throw new Error("Channel version conflict");
    if (input.taskId) {
      const [task] = await transaction
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, workspaceId)))
        .limit(1);
      if (!task) throw new Error("Task unavailable");
    }
    const [updated] = await transaction
      .update(channels)
      .set({
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        updatedAt: new Date(),
        version: channel.version + 1,
      })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
          eq(channels.version, expectedVersion)
        )
      )
      .returning();
    if (!updated) throw new Error("Channel version conflict");
    await transaction.insert(workspaceEvents).values({
      eventType: "channel.updated",
      payload: { actorUserId: principal.userId, channelId, version: updated.version },
      workspaceId,
    });
    return channelSummary(transaction, updated);
  });
}

export async function archiveChannel(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    const channel = await requireChannel(transaction, workspaceId, channelId);
    if (channel.version !== expectedVersion) throw new Error("Channel version conflict");
    if (channel.isPrimaryRoomChannel && channel.roomId) {
      const [room] = await transaction
        .select({ lifecycleState: rooms.lifecycleState })
        .from(rooms)
        .where(and(eq(rooms.id, channel.roomId), eq(rooms.workspaceId, workspaceId)))
        .limit(1);
      if (room?.lifecycleState === "active") throw new Error("Primary Room Channel required");
    }
    const [archived] = await transaction
      .update(channels)
      .set({ lifecycleState: "archived", updatedAt: new Date(), version: channel.version + 1 })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
          eq(channels.version, expectedVersion)
        )
      )
      .returning();
    if (!archived) throw new Error("Channel version conflict");
    await transaction.insert(workspaceEvents).values({
      eventType: "channel.archived",
      payload: { actorUserId: principal.userId, channelId, version: archived.version },
      workspaceId,
    });
    return channelSummary(transaction, archived);
  });
}

export async function setChannelParticipants(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  participants: readonly ConversationParticipantRef[],
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    const channel = await requireChannel(transaction, workspaceId, channelId);
    if (channel.version !== expectedVersion) throw new Error("Channel version conflict");
    if (channel.kind !== "group") throw new Error("Channel participant policy conflict");
    const unique = new Map(participants.map((entry) => [JSON.stringify(entry), entry])).values();
    const normalized = [...unique];
    for (const participant of normalized)
      await validateParticipant(transaction, workspaceId, participant);
    await transaction
      .delete(channelParticipants)
      .where(
        and(
          eq(channelParticipants.workspaceId, workspaceId),
          eq(channelParticipants.channelId, channelId)
        )
      );
    if (normalized.length)
      await transaction.insert(channelParticipants).values(
        normalized.map((participant) => ({
          agentId: participant.kind === "agent" ? participant.agentId : null,
          channelId,
          principalKind: participant.kind,
          userId: participant.kind === "user" ? participant.userId : null,
          workspaceId,
        }))
      );
    const [updated] = await transaction
      .update(channels)
      .set({ updatedAt: new Date(), version: channel.version + 1 })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
          eq(channels.version, expectedVersion)
        )
      )
      .returning();
    if (!updated) throw new Error("Channel version conflict");
    return channelSummary(transaction, updated);
  });
}

async function messageSummary(database: Database, row: MessageRow): Promise<MessageSummary> {
  const [mentionRows, artifactRows] = await Promise.all([
    database
      .select()
      .from(messageMentions)
      .where(
        and(eq(messageMentions.workspaceId, row.workspaceId), eq(messageMentions.messageId, row.id))
      ),
    database
      .select({ id: messageArtifactReferences.artifactId })
      .from(messageArtifactReferences)
      .where(
        and(
          eq(messageArtifactReferences.workspaceId, row.workspaceId),
          eq(messageArtifactReferences.messageId, row.id)
        )
      )
      .orderBy(asc(messageArtifactReferences.artifactId)),
  ]);
  const mentions = mentionRows
    .map((mention): ConversationParticipantRef =>
      mention.principalKind === "user"
        ? { kind: "user", userId: mention.userId! }
        : { agentId: mention.agentId!, kind: "agent" }
    )
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  let sender: MessageSenderRef;
  if (row.senderKind === "user") sender = { kind: "user", userId: row.senderUserId! };
  else if (row.senderKind === "agent") sender = { agentId: row.senderAgentId!, kind: "agent" };
  else sender = { kind: "system", systemId: row.senderSystemId! };
  return Object.freeze({
    artifactIds: Object.freeze(artifactRows.map(({ id }) => id)),
    ...(!row.deletedAt && row.bodyContentRefId ? { bodyContentRefId: row.bodyContentRefId } : {}),
    ...(!row.deletedAt && row.bodyText ? { bodyText: row.bodyText } : {}),
    channelId: row.channelId,
    createdAt: row.createdAt.toISOString(),
    deleted: Boolean(row.deletedAt),
    ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {}),
    ...(row.editedAt ? { editedAt: row.editedAt.toISOString() } : {}),
    ...(row.executionRef ? { executionRef: row.executionRef } : {}),
    ...(row.externalSessionRef ? { externalSessionRef: row.externalSessionRef } : {}),
    id: row.id,
    mentions: Object.freeze(mentions),
    ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
    sender: Object.freeze(sender),
    sequence: row.sequence,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    ...(row.threadRootMessageId ? { threadRootMessageId: row.threadRootMessageId } : {}),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    workspaceId: row.workspaceId,
  });
}

async function requireMessage(database: Database, workspaceId: string, messageId: string) {
  const [message] = await database
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)))
    .limit(1);
  if (!message) throw new Error("Message unavailable");
  return message;
}

async function validateSender(database: Database, workspaceId: string, sender: MessageSenderRef) {
  if (sender.kind === "user") await requireWorkspaceUser(database, workspaceId, sender.userId);
  else if (sender.kind === "agent") await requireActiveAgent(database, workspaceId, sender.agentId);
  else if (!sender.systemId.trim()) throw new Error("Message sender invalid");
}

export async function createMessage(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    artifactIds?: readonly string[];
    bodyContentRefId?: string;
    bodyText?: string;
    executionRef?: string;
    externalSessionRef?: string;
    idempotencyKey: string;
    mentions?: readonly ConversationParticipantRef[];
    replyToMessageId?: string;
    sender: MessageSenderRef;
    taskId?: string;
    threadRootMessageId?: string;
  }>
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    await requireChannelAccess(transaction, workspaceId, channelId, principal);
    await validateSender(transaction, workspaceId, input.sender);
    if (Boolean(input.bodyText?.trim()) === Boolean(input.bodyContentRefId))
      throw new Error("Message body invalid");
    const artifactIds = [...new Set(input.artifactIds ?? [])].sort();
    if (artifactIds.length) {
      const availableArtifacts = await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.workspaceId, workspaceId),
            eq(artifacts.deletionState, "active"),
            inArray(artifacts.id, artifactIds)
          )
        );
      if (availableArtifacts.length !== artifactIds.length) throw new Error("Artifact unavailable");
    }
    const mentions = [
      ...new Map((input.mentions ?? []).map((entry) => [JSON.stringify(entry), entry])).values(),
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    for (const mention of mentions) await validateParticipant(transaction, workspaceId, mention);
    let reply: MessageRow | undefined;
    if (input.replyToMessageId) {
      reply = await requireMessage(transaction, workspaceId, input.replyToMessageId);
      if (reply.channelId !== channelId || reply.deletedAt)
        throw new Error("Message reply conflict");
    }
    if (input.threadRootMessageId) {
      const root = await requireMessage(transaction, workspaceId, input.threadRootMessageId);
      if (root.channelId !== channelId || root.threadRootMessageId)
        throw new Error("Message thread conflict");
      if (reply && (reply.threadRootMessageId ?? reply.id) !== root.id)
        throw new Error("Message thread conflict");
    }
    if (input.taskId) {
      const [task] = await transaction
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, workspaceId)))
        .limit(1);
      if (!task) throw new Error("Task unavailable");
    }
    const normalized = {
      ...input,
      artifactIds,
      bodyText: input.bodyText?.trim() || undefined,
      mentions,
    };
    const payloadHash = hashPayload(normalized);
    const [created] = await transaction
      .insert(messages)
      .values({
        bodyContentRefId: input.bodyContentRefId ?? null,
        bodyText: input.bodyText?.trim() || null,
        channelId,
        createPayloadHash: payloadHash,
        executionRef: input.executionRef?.trim() || null,
        externalSessionRef: input.externalSessionRef?.trim() || null,
        idempotencyKey: input.idempotencyKey.trim(),
        replyToMessageId: input.replyToMessageId ?? null,
        senderAgentId: input.sender.kind === "agent" ? input.sender.agentId : null,
        senderKind: input.sender.kind,
        senderSystemId: input.sender.kind === "system" ? input.sender.systemId.trim() : null,
        senderUserId: input.sender.kind === "user" ? input.sender.userId : null,
        taskId: input.taskId ?? null,
        threadRootMessageId: input.threadRootMessageId ?? null,
        workspaceId,
      })
      .onConflictDoNothing({ target: [messages.channelId, messages.idempotencyKey] })
      .returning();
    if (!created) {
      const [existing] = await transaction
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            eq(messages.idempotencyKey, input.idempotencyKey.trim())
          )
        )
        .limit(1);
      if (!existing || existing.createPayloadHash !== payloadHash)
        throw new Error("Message idempotency conflict");
      await reopenTasksForChannelMessage(
        transaction,
        workspaceId,
        channelId,
        existing.id,
        principal
      );
      return messageSummary(transaction, existing);
    }
    if (input.bodyContentRefId)
      await attachMessageContentRef(transaction, workspaceId, input.bodyContentRefId, created.id);
    if (mentions.length)
      await transaction.insert(messageMentions).values(
        mentions.map((mention) => ({
          agentId: mention.kind === "agent" ? mention.agentId : null,
          messageId: created.id,
          principalKind: mention.kind,
          userId: mention.kind === "user" ? mention.userId : null,
          workspaceId,
        }))
      );
    if (artifactIds.length)
      await transaction
        .insert(messageArtifactReferences)
        .values(
          artifactIds.map((artifactId) => ({ artifactId, messageId: created.id, workspaceId }))
        );
    await transaction.insert(workspaceEvents).values({
      eventType: "message.created",
      payload: {
        actorUserId: principal.userId,
        channelId,
        messageId: created.id,
        sequence: created.sequence,
      },
      workspaceId,
    });
    await reopenTasksForChannelMessage(transaction, workspaceId, channelId, created.id, principal);
    return messageSummary(transaction, created);
  });
}

export async function listMessagesForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ afterSequence?: number; limit?: number; threadRootMessageId?: string }> = {}
) {
  await requireMembership(database, workspaceId, principal);
  await requireChannelAccess(database, workspaceId, channelId, principal);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = await database
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.channelId, channelId),
        ...(options.afterSequence !== undefined
          ? [gt(messages.sequence, options.afterSequence)]
          : []),
        ...(options.threadRootMessageId
          ? [eq(messages.threadRootMessageId, options.threadRootMessageId)]
          : [])
      )
    )
    .orderBy(asc(messages.sequence))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const summaries = await Promise.all(page.map((row) => messageSummary(database, row)));
  return Object.freeze({
    messages: Object.freeze(summaries),
    ...(hasMore && page.length ? { nextAfterSequence: page.at(-1)!.sequence } : {}),
  });
}

export async function getMessageForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  messageId: string,
  principal: UserPrincipalRef
) {
  await requireMembership(database, workspaceId, principal);
  const message = await requireMessage(database, workspaceId, messageId);
  await requireChannelAccess(database, workspaceId, message.channelId, principal);
  return messageSummary(database, message);
}

export async function editMessage(
  database: AgentHqDatabase,
  workspaceId: string,
  messageId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ bodyContentRefId?: string | null; bodyText?: string | null }>,
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    const message = await requireMessage(transaction, workspaceId, messageId);
    await requireChannelAccess(transaction, workspaceId, message.channelId, principal);
    if (message.deletedAt) throw new Error("Message unavailable");
    if (message.version !== expectedVersion) throw new Error("Message version conflict");
    if (Boolean(input.bodyText?.trim()) === Boolean(input.bodyContentRefId))
      throw new Error("Message body invalid");
    const [updated] = await transaction
      .update(messages)
      .set({
        bodyContentRefId: input.bodyContentRefId ?? null,
        bodyText: input.bodyText?.trim() || null,
        editedAt: new Date(),
        updatedAt: new Date(),
        version: message.version + 1,
      })
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.version, expectedVersion),
          isNull(messages.deletedAt)
        )
      )
      .returning();
    if (!updated) throw new Error("Message version conflict");
    if (input.bodyContentRefId)
      await attachMessageContentRef(transaction, workspaceId, input.bodyContentRefId, messageId);
    await transaction.insert(workspaceEvents).values({
      eventType: "message.updated",
      payload: { actorUserId: principal.userId, messageId, version: updated.version },
      workspaceId,
    });
    return messageSummary(transaction, updated);
  });
}

export async function deleteMessage(
  database: AgentHqDatabase,
  workspaceId: string,
  messageId: string,
  principal: UserPrincipalRef,
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal);
    const message = await requireMessage(transaction, workspaceId, messageId);
    await requireChannelAccess(transaction, workspaceId, message.channelId, principal);
    if (message.deletedAt) throw new Error("Message unavailable");
    if (message.version !== expectedVersion) throw new Error("Message version conflict");
    const now = new Date();
    const [deleted] = await transaction
      .update(messages)
      .set({
        bodyContentRefId: null,
        bodyText: null,
        deletedAt: now,
        updatedAt: now,
        version: message.version + 1,
      })
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.version, expectedVersion)
        )
      )
      .returning();
    if (!deleted) throw new Error("Message version conflict");
    await transaction.insert(workspaceEvents).values({
      eventType: "message.deleted",
      payload: { actorUserId: principal.userId, messageId, version: deleted.version },
      workspaceId,
    });
    return messageSummary(transaction, deleted);
  });
}
