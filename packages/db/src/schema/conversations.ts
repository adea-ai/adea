import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { agents } from './agents'
import { artifacts } from './artifacts'
import { contentRefs } from './content-refs'
import { entityId, timestampColumns } from './conventions'
import { users } from './identity'
import { rooms } from './rooms'
import { appSchema } from './schema'
import { tasks } from './tasks'
import { workspaces } from './workspaces'

export const channelKind = appSchema.enum('channel_kind', ['room', 'direct_agent', 'group'])
export const channelLifecycleState = appSchema.enum('channel_lifecycle_state', [
  'active',
  'archived',
])
export const channelVisibility = appSchema.enum('channel_visibility', ['workspace', 'participants'])
export const conversationPrincipalKind = appSchema.enum('conversation_principal_kind', [
  'user',
  'agent',
])
export const messageSenderKind = appSchema.enum('message_sender_kind', ['user', 'agent', 'system'])

export const channels = appSchema.table(
  'channels',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: channelKind('kind').notNull(),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    visibility: channelVisibility('visibility').default('workspace').notNull(),
    isPrimaryRoomChannel: boolean('is_primary_room_channel').default(false).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    lifecycleState: channelLifecycleState('lifecycle_state').default('active').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    version: integer('version').default(1).notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('channels_workspace_idempotency_unique').on(table.workspaceId, table.idempotencyKey),
    uniqueIndex('channels_active_primary_room_unique')
      .on(table.roomId)
      .where(
        sql`${table.isPrimaryRoomChannel} = true and ${table.lifecycleState} = 'active' and ${table.roomId} is not null`
      ),
    uniqueIndex('channels_active_direct_agent_unique')
      .on(table.workspaceId, table.agentId)
      .where(sql`${table.kind} = 'direct_agent' and ${table.lifecycleState} = 'active'`),
    check('channels_title_nonempty', sql`length(btrim(${table.title})) > 0`),
    check('channels_idempotency_nonempty', sql`length(btrim(${table.idempotencyKey})) > 0`),
    check('channels_sort_nonnegative', sql`${table.sortOrder} >= 0`),
    check('channels_version_positive', sql`${table.version} > 0`),
    check(
      'channels_kind_association',
      sql`(${table.kind} = 'room' and ${table.roomId} is not null and ${table.agentId} is null) or (${table.kind} = 'direct_agent' and ${table.roomId} is null and ${table.agentId} is not null) or (${table.kind} = 'group' and ${table.roomId} is null and ${table.agentId} is null)`
    ),
    check(
      'channels_primary_room_only',
      sql`${table.isPrimaryRoomChannel} = false or (${table.kind} = 'room' and ${table.roomId} is not null)`
    ),
    index('channels_workspace_order_idx').on(
      table.workspaceId,
      table.lifecycleState,
      table.sortOrder,
      table.id
    ),
    index('channels_room_idx').on(table.workspaceId, table.roomId, table.lifecycleState),
  ]
)

export const channelParticipants = appSchema.table(
  'channel_participants',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    principalKind: conversationPrincipalKind('principal_kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('channel_participants_user_unique')
      .on(table.channelId, table.userId)
      .where(sql`${table.principalKind} = 'user' and ${table.userId} is not null`),
    uniqueIndex('channel_participants_agent_unique')
      .on(table.channelId, table.agentId)
      .where(sql`${table.principalKind} = 'agent' and ${table.agentId} is not null`),
    check(
      'channel_participants_principal_consistent',
      sql`(${table.principalKind} = 'user' and ${table.userId} is not null and ${table.agentId} is null) or (${table.principalKind} = 'agent' and ${table.userId} is null and ${table.agentId} is not null)`
    ),
    index('channel_participants_workspace_idx').on(table.workspaceId, table.channelId),
  ]
)

export const messages = appSchema.table(
  'messages',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    sequence: bigint('sequence', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    senderKind: messageSenderKind('sender_kind').notNull(),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'restrict' }),
    senderAgentId: uuid('sender_agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    senderSystemId: text('sender_system_id'),
    bodyText: text('body_text'),
    bodyContentRefId: uuid('body_content_ref_id').references(() => contentRefs.id, {
      onDelete: 'restrict',
    }),
    threadRootMessageId: uuid('thread_root_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'restrict',
    }),
    replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'restrict',
    }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    executionRef: text('execution_ref'),
    externalSessionRef: text('external_session_ref'),
    idempotencyKey: text('idempotency_key').notNull(),
    createPayloadHash: text('create_payload_hash').notNull(),
    version: integer('version').default(1).notNull(),
    editedAt: timestamp('edited_at', { mode: 'date', withTimezone: true }),
    deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('messages_sequence_unique').on(table.sequence),
    unique('messages_channel_idempotency_unique').on(table.channelId, table.idempotencyKey),
    check('messages_idempotency_nonempty', sql`length(btrim(${table.idempotencyKey})) > 0`),
    check('messages_version_positive', sql`${table.version} > 0`),
    check(
      'messages_sender_consistent',
      sql`(${table.senderKind} = 'user' and ${table.senderUserId} is not null and ${table.senderAgentId} is null and ${table.senderSystemId} is null) or (${table.senderKind} = 'agent' and ${table.senderUserId} is null and ${table.senderAgentId} is not null and ${table.senderSystemId} is null) or (${table.senderKind} = 'system' and ${table.senderUserId} is null and ${table.senderAgentId} is null and length(btrim(${table.senderSystemId})) > 0)`
    ),
    check(
      'messages_body_available_or_deleted',
      sql`${table.deletedAt} is not null or ${table.bodyText} is not null or ${table.bodyContentRefId} is not null`
    ),
    index('messages_channel_order_idx').on(table.channelId, table.sequence),
    index('messages_workspace_thread_idx').on(
      table.workspaceId,
      table.channelId,
      table.threadRootMessageId,
      table.sequence
    ),
    index('messages_task_idx').on(table.workspaceId, table.taskId),
  ]
)

export const messageMentions = appSchema.table(
  'message_mentions',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    principalKind: conversationPrincipalKind('principal_kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex('message_mentions_user_unique')
      .on(table.messageId, table.userId)
      .where(sql`${table.principalKind} = 'user' and ${table.userId} is not null`),
    uniqueIndex('message_mentions_agent_unique')
      .on(table.messageId, table.agentId)
      .where(sql`${table.principalKind} = 'agent' and ${table.agentId} is not null`),
    check(
      'message_mentions_principal_consistent',
      sql`(${table.principalKind} = 'user' and ${table.userId} is not null and ${table.agentId} is null) or (${table.principalKind} = 'agent' and ${table.userId} is null and ${table.agentId} is not null)`
    ),
    index('message_mentions_workspace_idx').on(table.workspaceId, table.messageId),
  ]
)

export const messageArtifactReferences = appSchema.table(
  'message_artifact_references',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'restrict' }),
    ...timestampColumns(),
  },
  (table) => [
    unique('message_artifact_references_unique').on(table.messageId, table.artifactId),
    index('message_artifact_workspace_idx').on(table.workspaceId, table.messageId),
  ]
)
