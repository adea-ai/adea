import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { channels, messages } from './conversations'
import { entityId, timestampColumns } from './conventions'
import { users } from './identity'
import { appSchema } from './schema'
import { workspaces } from './workspaces'

export const channelReadStates = appSchema.table(
  'channel_read_states',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastReadSequence: bigint('last_read_sequence', { mode: 'number' }).default(0).notNull(),
    manuallyUnread: boolean('manually_unread').default(false).notNull(),
    readAt: timestamp('read_at', { mode: 'date', withTimezone: true }),
    version: integer('version').default(1).notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('channel_read_states_user_channel_unique').on(
      table.workspaceId,
      table.userId,
      table.channelId
    ),
    check('channel_read_states_sequence_nonnegative', sql`${table.lastReadSequence} >= 0`),
    check('channel_read_states_version_positive', sql`${table.version} > 0`),
    index('channel_read_states_workspace_user_idx').on(table.workspaceId, table.userId),
  ]
)

export const threadReadStates = appSchema.table(
  'thread_read_states',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    threadRootMessageId: uuid('thread_root_message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    lastReadSequence: bigint('last_read_sequence', { mode: 'number' }).default(0).notNull(),
    manuallyUnread: boolean('manually_unread').default(false).notNull(),
    readAt: timestamp('read_at', { mode: 'date', withTimezone: true }),
    version: integer('version').default(1).notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('thread_read_states_user_thread_unique').on(
      table.workspaceId,
      table.userId,
      table.threadRootMessageId
    ),
    check('thread_read_states_sequence_nonnegative', sql`${table.lastReadSequence} >= 0`),
    check('thread_read_states_version_positive', sql`${table.version} > 0`),
    index('thread_read_states_workspace_user_channel_idx').on(
      table.workspaceId,
      table.userId,
      table.channelId
    ),
  ]
)
