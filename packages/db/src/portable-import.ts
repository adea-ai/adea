// Restore a portable workspace export into a clean environment (M18.02.2, #1226).
//
// The importer treats the bundle as untrusted data. It validates the document
// against the version-1 contract, recomputes the content digest, and only then
// writes. The write is one transaction, and the restored workspace is read back
// with the complete (unfiltered) reader and must hash to the bundle's digest
// before the transaction commits. A bundle that does not restore exactly is
// rolled back, never partially applied.
//
// Authority does not travel in the bundle:
// - the importer becomes the owner of the restored workspace; bundle roles are
//   never applied, and no membership is restored for any other person;
// - every user a record names must already exist in the destination, so an
//   import never creates an identity;
// - no credential, session, invitation, runtime key or synchronized key material
//   is accepted (the contract refuses unknown fields) or created.
//
// Residency does not change on import. Text bodies are product-database
// plaintext in both source and destination. Content refs come back as metadata:
// their bodies are absent, so availability is `missing` (or `deleted`) and the
// storage and synchronization policies are restored exactly, never upgraded.
// Artifacts, replicas and runtime bindings are never written.

import { createHash } from 'node:crypto'

import {
  canonicalPortableJson,
  type PortableExportExclusion,
  PORTABLE_EXTERNAL_DOMAIN_CLASSES,
  type PortableWorkspaceExport,
  type UserPrincipalRef,
} from '@adea-ai/types'
import { and, eq, inArray, max, sql } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import { mintControlPlaneIdentifier } from './control-plane-identifiers'
import { readCompletePortableContent } from './portable-export'
import { portableContentDigest } from './portable-export-content'
import { checkPortableBundle, PortableImportError } from './portable-import-guards'
import {
  agents,
  channelParticipants,
  channels,
  contentRefs,
  messageMentions,
  messages,
  projectMembers,
  projects,
  taskDependencies,
  taskExecutionAttempts,
  tasks,
  users,
  workspaceDeletions,
  workspaceMemberships,
  workspaces,
} from './schema'
import { appendWorkspaceEvent } from './transactions'

/** An external domain the bundle withholds. This destination restores none of them, so each is unavailable. */
export type PortableExternalDomain = Readonly<{
  authority: string
  class: string
  status: 'unavailable'
  treatment: string
}>

/** The bundle's withheld external domains, each reported unavailable, in class order. */
function externalDomainsOf(
  exclusions: readonly PortableExportExclusion[]
): readonly PortableExternalDomain[] {
  const external: readonly string[] = PORTABLE_EXTERNAL_DOMAIN_CLASSES
  return exclusions
    .filter((exclusion) => external.includes(exclusion.class))
    .map((exclusion) => ({
      authority: exclusion.authority,
      class: exclusion.class,
      status: 'unavailable' as const,
      treatment: exclusion.treatment,
    }))
    .toSorted((left, right) => (left.class < right.class ? -1 : left.class > right.class ? 1 : 0))
}

export type PortableImportResult = Readonly<{
  contentDigest: string
  externalDomains: readonly PortableExternalDomain[]
  counts: Readonly<{
    agents: number
    channelParticipants: number
    channels: number
    contentRefs: number
    executionAttempts: number
    messageMentions: number
    messages: number
    projectMembers: number
    projects: number
    taskDependencies: number
    tasks: number
  }>
  /** What this format version never restores. The ledger is carried verbatim from the bundle. */
  deferred: readonly PortableExportExclusion[]
  workspaceId: string
}>

// Postgres caps bind parameters at 65,535 per statement; the widest row has about
// 20 columns, so a batch of 500 rows stays well inside the limit.
const INSERT_BATCH = 500

async function insertBatched<T>(
  rows: readonly T[],
  insert: (batch: T[]) => Promise<unknown>
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH)
    await insert(rows.slice(offset, offset + INSERT_BATCH))
}

const messageHash = (value: unknown) =>
  createHash('sha256').update(canonicalPortableJson(value)).digest('hex')

/**
 * Restore one validated, digest-checked bundle into a destination that does
 * not yet contain the workspace. Throws `PortableImportError` with a stable
 * code; the destination is left unchanged on every failure.
 */
export async function importPortableWorkspace(
  database: AgentHqDatabase,
  input: Readonly<{ bundle: unknown; importedAt?: Date; importer: UserPrincipalRef }>
): Promise<PortableImportResult> {
  const document: PortableWorkspaceExport = checkPortableBundle(input.bundle)

  const importedAt = input.importedAt ?? new Date()
  const { content } = document
  const workspaceId = content.workspace.workspaceId

  return database.transaction(async (transaction) => {
    const [importer] = await transaction
      .select({ disabledAt: users.disabledAt, id: users.id })
      .from(users)
      .where(eq(users.id, input.importer.userId))
      .for('update')
    if (!importer || importer.disabledAt)
      throw new PortableImportError('importer_unavailable', 'the importing user is unavailable')

    // A clean destination: neither the workspace nor a deletion receipt for it may
    // exist, so a deleted workspace can never be resurrected from a bundle.
    const [existing] = await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    const [deleted] = await transaction
      .select({ id: workspaceDeletions.workspaceId })
      .from(workspaceDeletions)
      .where(eq(workspaceDeletions.workspaceId, workspaceId))
      .limit(1)
    if (existing || deleted)
      throw new PortableImportError('target_exists', 'the destination already holds this workspace')

    const userIds = content.users.map((user) => user.userId)
    const present = userIds.length
      ? await transaction.select({ id: users.id }).from(users).where(inArray(users.id, userIds))
      : []
    const unresolved = userIds.length - present.length
    if (unresolved > 0)
      throw new PortableImportError(
        'unresolved_users',
        `${unresolved} referenced user(s) do not exist in the destination`
      )

    const [previous] = await transaction
      .select({ value: max(workspaceMemberships.sortOrder) })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, input.importer.userId))
    const sortOrder =
      previous?.value === null || previous?.value === undefined ? 0 : previous.value + 1

    await transaction.insert(workspaces).values({
      accent: content.workspace.accent,
      controlPlaneWorkspaceId: mintControlPlaneIdentifier('wsp'),
      createdAt: new Date(content.workspace.createdAt),
      idempotencyKey: `portable-import:${workspaceId}`,
      id: workspaceId,
      isPersonal: false,
      logoKind: content.workspace.logoKind,
      logoValue: content.workspace.logoValue,
      name: content.workspace.name,
      ownerUserId: input.importer.userId,
      scene: content.workspace.scene,
      updatedAt: new Date(content.workspace.updatedAt),
      version: content.workspace.version,
    })
    await transaction.insert(workspaceMemberships).values({
      role: 'owner',
      sortOrder,
      userId: input.importer.userId,
      workspaceId,
    })
    await appendWorkspaceEvent(transaction, {
      eventType: 'workspace.created',
      payload: { ownerUserId: input.importer.userId },
      workspaceId,
    })

    await insertBatched(content.projects, (batch) =>
      transaction.insert(projects).values(
        batch.map((project) => ({
          createdAt: new Date(project.createdAt),
          iconKey: project.iconKey,
          id: project.projectId,
          lifecycleState: project.lifecycleState,
          name: project.name,
          sortOrder: project.sortOrder,
          sourceKind: project.sourceKind,
          updatedAt: new Date(project.updatedAt),
          visibility: project.visibility,
          workspaceId,
        }))
      )
    )
    const memberRows = content.projects.flatMap((project) =>
      project.members.map((member) => ({
        createdAt: importedAt,
        projectId: project.projectId,
        role: member.role,
        updatedAt: importedAt,
        userId: member.userId,
        workspaceId,
      }))
    )
    await insertBatched(memberRows, (batch) => transaction.insert(projectMembers).values(batch))

    await insertBatched(content.agents, (batch) =>
      transaction.insert(agents).values(
        batch.map((agent) => ({
          createdAt: new Date(agent.createdAt),
          id: agent.agentId,
          isWorkspaceLead: agent.isWorkspaceLead,
          lifecycleState: agent.lifecycleState,
          name: agent.name,
          profileId: agent.profileId,
          profileRevision: agent.profileRevision,
          profileState: agent.profileState,
          profileVersion: agent.profileVersion,
          projectId: agent.projectId,
          revision: agent.revision,
          roleSummary: agent.roleSummary,
          updatedAt: new Date(agent.updatedAt),
          workspaceId,
        }))
      )
    )

    // Bodies never travel, so a restored ref has no body here. A deleted ref
    // stays deleted; every other ref is `missing` until its authority re-syncs.
    await insertBatched(content.contentRefs, (batch) =>
      transaction.insert(contentRefs).values(
        batch.map((ref) => ({
          availability: (ref.bodyState === 'deleted' ? 'deleted' : 'missing') as
            | 'deleted'
            | 'missing',
          contentType: ref.contentType,
          createdAt: new Date(ref.createdAt),
          deletedAt: ref.bodyState === 'deleted' ? new Date(ref.updatedAt) : null,
          digestSha256: ref.digestSha256,
          id: ref.contentRefId,
          keyVersion: ref.keyVersion,
          messageId: ref.messageId,
          revision: ref.revision,
          schemaVersion: ref.schemaVersion,
          sensitivity: ref.sensitivity,
          storagePolicy: ref.storagePolicy,
          synchronizationPolicy: ref.synchronizationPolicy,
          taskId: ref.taskId,
          updatedAt: new Date(ref.updatedAt),
          workspaceId,
        }))
      )
    )

    await insertBatched(content.tasks, (batch) =>
      transaction.insert(tasks).values(
        batch.map((task) => ({
          agentId: task.agentId,
          channelId: task.channelId,
          createdAt: new Date(task.createdAt),
          creatorUserId: task.creatorUserId,
          id: task.taskId,
          kind: task.kind,
          lifecycleState: task.lifecycleState,
          messageId: task.messageId,
          objective: task.objective,
          objectiveContentRefId: task.objectiveContentRefId,
          priority: task.priority,
          projectId: task.projectId,
          threadRootMessageId: task.threadRootMessageId,
          title: task.title,
          updatedAt: new Date(task.updatedAt),
          version: task.version,
          workspaceId,
        }))
      )
    )

    await insertBatched(content.channels, (batch) =>
      transaction.insert(channels).values(
        batch.map((channel) => ({
          agentId: channel.agentId,
          createdAt: new Date(channel.createdAt),
          id: channel.channelId,
          idempotencyKey: `portable-import:${channel.channelId}`,
          isPrimaryProjectChannel: channel.isPrimaryProjectChannel,
          kind: channel.kind,
          lifecycleState: channel.lifecycleState,
          projectId: channel.projectId,
          sortOrder: channel.sortOrder,
          taskId: channel.taskId,
          title: channel.title,
          updatedAt: new Date(channel.updatedAt),
          version: channel.version,
          visibility: channel.visibility,
          workspaceId,
        }))
      )
    )
    const participantRows = content.channels.flatMap((channel) =>
      channel.participants.map((participant) => ({
        agentId: participant.kind === 'agent' ? participant.agentId : null,
        channelId: channel.channelId,
        createdAt: importedAt,
        principalKind: participant.kind,
        updatedAt: importedAt,
        userId: participant.kind === 'user' ? participant.userId : null,
        workspaceId,
      }))
    )
    await insertBatched(participantRows, (batch) =>
      transaction.insert(channelParticipants).values(batch)
    )

    // Messages are inserted in conversation order (by channel, then by channelOrder),
    // whatever order the bundle lists them in. The identity sequence is assigned in
    // insertion order, so each channel reads back in its conversation order, and the
    // re-read below checks it. Thread and reply links follow in a second pass, once
    // every referenced message exists.
    const conversationOrder = content.messages.toSorted((left, right) =>
      left.channelId < right.channelId
        ? -1
        : left.channelId > right.channelId
          ? 1
          : left.channelOrder - right.channelOrder
    )
    await insertBatched(conversationOrder, (batch) =>
      transaction.insert(messages).values(
        batch.map((message) => {
          const sender = message.sender
          const body = message.body
          return {
            bodyContentRefId: body.kind === 'content_ref' ? body.contentRefId : null,
            bodyText: body.kind === 'text' ? body.text : null,
            channelId: message.channelId,
            createPayloadHash: messageHash(message),
            createdAt: new Date(message.createdAt),
            deletedAt: message.deletedAt ? new Date(message.deletedAt) : null,
            editedAt: message.editedAt ? new Date(message.editedAt) : null,
            id: message.messageId,
            idempotencyKey: `portable-import:${message.messageId}`,
            senderAgentId: sender.kind === 'agent' ? sender.agentId : null,
            senderKind: (sender.kind === 'user'
              ? 'user'
              : sender.kind === 'agent'
                ? 'agent'
                : 'system') as 'agent' | 'system' | 'user',
            senderSystemId: sender.kind === 'system' ? sender.systemId : null,
            senderUserId: sender.kind === 'user' ? sender.userId : null,
            taskId: message.taskId,
            updatedAt: new Date(message.updatedAt),
            version: message.version,
            workspaceId,
          }
        })
      )
    )
    for (const message of content.messages) {
      if (message.threadRootMessageId === null && message.replyToMessageId === null) continue
      await transaction
        .update(messages)
        .set({
          replyToMessageId: message.replyToMessageId,
          threadRootMessageId: message.threadRootMessageId,
          // An explicit value keeps the exported timestamp; the column's
          // on-update default would otherwise move it.
          updatedAt: new Date(message.updatedAt),
        })
        .where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, message.messageId)))
    }

    const mentionRows = content.messages.flatMap((message) =>
      message.mentions.map((mention) => ({
        agentId: mention.kind === 'agent' ? mention.agentId : null,
        messageId: message.messageId,
        principalKind: mention.kind,
        userId: mention.kind === 'user' ? mention.userId : null,
        workspaceId,
      }))
    )
    await insertBatched(mentionRows, (batch) => transaction.insert(messageMentions).values(batch))

    await insertBatched(content.taskDependencies, (batch) =>
      transaction.insert(taskDependencies).values(
        batch.map((dependency) => ({
          dependsOnTaskId: dependency.dependsOnTaskId,
          taskId: dependency.taskId,
          workspaceId,
        }))
      )
    )
    await insertBatched(content.executionAttempts, (batch) =>
      transaction.insert(taskExecutionAttempts).values(
        batch.map((attempt) => ({
          attempt: attempt.attempt,
          change: attempt.change,
          createdAt: new Date(attempt.createdAt),
          locationKind: attempt.locationKind,
          runtimeNodeId: null,
          taskId: attempt.taskId,
          updatedAt: new Date(attempt.createdAt),
          workspaceId,
        }))
      )
    )

    // The same derivation as a live message write: the newest top-level,
    // undeleted message per channel. The channel's own timestamp is kept.
    await transaction
      .update(channels)
      .set({
        latestMessageSequence: sql`coalesce((select max(${messages.sequence}) from ${messages} where ${messages.channelId} = ${channels.id} and ${messages.threadRootMessageId} is null and ${messages.deletedAt} is null), 0)`,
        updatedAt: sql`${channels.updatedAt}`,
      })
      .where(eq(channels.workspaceId, workspaceId))

    // Read the restored workspace back with the complete reader and require the
    // same digest. Any gap, reordering or altered field rolls the import back.
    const restored = await readCompletePortableContent(transaction, workspaceId)
    if (!restored || portableContentDigest(restored) !== document.contentDigest.value)
      throw new PortableImportError(
        'verification_failed',
        'the restored workspace does not reproduce the bundle digest'
      )

    return Object.freeze({
      contentDigest: document.contentDigest.value,
      counts: Object.freeze({
        agents: content.agents.length,
        channelParticipants: participantRows.length,
        channels: content.channels.length,
        contentRefs: content.contentRefs.length,
        executionAttempts: content.executionAttempts.length,
        messageMentions: mentionRows.length,
        messages: content.messages.length,
        projectMembers: memberRows.length,
        projects: content.projects.length,
        taskDependencies: content.taskDependencies.length,
        tasks: content.tasks.length,
      }),
      deferred: document.exclusions,
      externalDomains: externalDomainsOf(document.exclusions),
      workspaceId,
    })
  })
}
