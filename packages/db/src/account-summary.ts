import type { AccountWorkspaceSummary, UserPrincipalRef } from '@adea-ai/types'
import { sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { userChannelStanding } from './group-participation-store'
import {
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projectMembers,
  projects,
  workspaceMemberships,
  workspaces,
} from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

/**
 * Counts-only unread status for every live workspace the principal belongs to
 * (ADR 0011, "Counts-only cross-workspace status"), in one grouped query.
 *
 * Membership is the only authority: the query starts from the principal's own
 * memberships, so a workspace they do not belong to can never appear. Channel
 * visibility mirrors read state (`listAccessibleChannelIds`): active channels
 * that are workspace-visible or that list the user as a participant, and whose
 * project (if any) the user may see under ADR 0012 — owners and admins see
 * every project, everyone else sees `workspace` projects and the `members`
 * projects that list them (`visibleProjectCondition`).
 *
 * - `unreadChannels` counts channels whose newest live top-level message
 *   (`channels.latest_message_sequence`) is past the user's channel frontier,
 *   or that the user marked unread. Thread-only replies do not count here;
 *   the in-workspace read state still reports them.
 * - `mentions` counts live, unread top-level messages in those channels that
 *   mention the user (`message_mentions`). The lateral count runs only for
 *   channels that are already unread by sequence.
 *
 * Nothing in the result names a channel, message, or person.
 */
export async function accountWorkspaceSummaries(
  database: Database,
  principal: UserPrincipalRef
): Promise<readonly AccountWorkspaceSummary[]> {
  const rows = await database.execute<{
    mentions: number
    unreadChannels: number
    workspaceId: string
  }>(sql`
    select
      membership.workspace_id as "workspaceId",
      (count(channel.id) filter (
        where channel.latest_message_sequence > coalesce(read_state.last_read_sequence, 0)
          or coalesce(read_state.manually_unread, false)
      ))::int as "unreadChannels",
      coalesce(sum(mention.count), 0)::int as "mentions"
    from ${workspaceMemberships} as membership
    inner join ${workspaces} as workspace
      on workspace.id = membership.workspace_id and workspace.deleted_at is null
    left join ${channels} as channel
      on channel.workspace_id = membership.workspace_id
      and channel.lifecycle_state = 'active'
      and (
        channel.visibility = 'workspace'
        or ${userChannelStanding(sql.raw('channel.kind'), sql.raw('channel.id'), sql.raw('membership.user_id'))}
      )
      and (
        channel.project_id is null
        or membership.role in ('owner', 'admin')
        or exists (
          select 1 from ${projects} as project
          where project.id = channel.project_id
            and project.visibility <> 'members'
        )
        or exists (
          select 1 from ${projectMembers} as project_member
          where project_member.project_id = channel.project_id
            and project_member.user_id = membership.user_id
        )
      )
    left join ${channelReadStates} as read_state
      on read_state.workspace_id = channel.workspace_id
      and read_state.user_id = membership.user_id
      and read_state.channel_id = channel.id
    left join lateral (
      select count(*) as count
      from ${messageMentions} as mentioned
      inner join ${messages} as message on message.id = mentioned.message_id
      where channel.latest_message_sequence > coalesce(read_state.last_read_sequence, 0)
        and mentioned.principal_kind = 'user'
        and mentioned.user_id = membership.user_id
        and message.channel_id = channel.id
        and message.thread_root_message_id is null
        and message.deleted_at is null
        and message.sequence > coalesce(read_state.last_read_sequence, 0)
    ) as mention on true
    where membership.user_id = ${principal.userId}
    group by membership.workspace_id, membership.sort_order
    order by membership.sort_order asc, membership.workspace_id asc
  `)
  return Object.freeze(
    [...rows].map((row) =>
      Object.freeze({
        mentions: Number(row.mentions),
        unreadChannels: Number(row.unreadChannels),
        workspaceId: row.workspaceId,
      })
    )
  )
}
