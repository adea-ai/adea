import type { AccountWorkspaceSummary, UserPrincipalRef } from '@adea-ai/types'
import { sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { readChannelsWithVisibleUnreadPublication } from './job-outbound-frontier'
import {
  channelParticipants,
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

/** One channel's row in the summary query. A channel with no membership row is `null`. */
type SummaryChannelRow = {
  channelId: string | null
  manuallyUnread: boolean
  mentions: number | string
  hasUnreadPublication: boolean
  ordinaryUnread: boolean
  sortOrder: number
  workspaceId: string
}

/**
 * Counts-only unread status for every live workspace the principal belongs to
 * (ADR 0011, "Counts-only cross-workspace status"), in one statement.
 *
 * Membership is the only authority: the query starts from the principal's own
 * memberships, so a workspace they do not belong to can never appear. Channel
 * visibility mirrors read state (`listAccessibleChannelIds`): active channels
 * that are workspace-visible or that list the user as a participant, and whose
 * project (if any) the user may see under ADR 0012 — owners and admins see
 * every project, everyone else sees `workspace` projects and the `members`
 * projects that list them (`visibleProjectCondition`).
 *
 * - `unreadChannels` counts channels with a live top-level message the user can
 *   see past their channel frontier, or that the user marked unread. A job
 *   publication is counted only while the user is authorized for it (#1217): the
 *   statement returns each channel's ordinary unread flag and whether it has an
 *   unread publication, and only the channels that need it are checked, in pages,
 *   against the same gates history applies. Thread-only replies do not count here;
 *   the in-workspace read state still reports them.
 * - `mentions` counts live, unread top-level messages in those channels that
 *   mention the user (`message_mentions`). Publications carry no mentions.
 *
 * Nothing in the result names a channel, message, or person.
 */
export async function accountWorkspaceSummaries(
  database: Database,
  principal: UserPrincipalRef
): Promise<readonly AccountWorkspaceSummary[]> {
  const rows = await database.execute<SummaryChannelRow>(sql`
    select
      membership.workspace_id as "workspaceId",
      membership.sort_order as "sortOrder",
      channel.id as "channelId",
      coalesce(read_state.manually_unread, false) as "manuallyUnread",
      (
        channel.latest_message_sequence > coalesce(read_state.last_read_sequence, 0)
        and exists (
          select 1 from ${messages} as unread
          where unread.channel_id = channel.id
            and unread.workspace_id = channel.workspace_id
            and unread.thread_root_message_id is null
            and unread.deleted_at is null
            and unread.sequence > coalesce(read_state.last_read_sequence, 0)
            and not (
              unread.sender_kind = 'system'
              and unread.sender_system_id like 'job-outbound:v1:%'
            )
        )
      ) as "ordinaryUnread",
      case when channel.latest_message_sequence > coalesce(read_state.last_read_sequence, 0) then exists (
        select 1 from ${messages} as publication
        where publication.channel_id = channel.id
          and publication.workspace_id = channel.workspace_id
          and publication.thread_root_message_id is null
          and publication.deleted_at is null
          and publication.sender_kind = 'system'
          and publication.sender_system_id like 'job-outbound:v1:%'
          and publication.sequence > coalesce(read_state.last_read_sequence, 0)
      ) else false end as "hasUnreadPublication",
      coalesce(mention.count, 0) as "mentions"
    from ${workspaceMemberships} as membership
    inner join ${workspaces} as workspace
      on workspace.id = membership.workspace_id and workspace.deleted_at is null
    left join ${channels} as channel
      on channel.workspace_id = membership.workspace_id
      and channel.lifecycle_state = 'active'
      and (
        channel.visibility = 'workspace'
        or exists (
          select 1 from ${channelParticipants} as participant
          where participant.channel_id = channel.id
            and participant.principal_kind = 'user'
            and participant.user_id = membership.user_id
        )
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
    order by membership.sort_order asc, membership.workspace_id asc
  `)
  const channelRows = [...rows]
  // Only a channel with no unread flag and an unread publication needs the publication gates.
  // With none, this adds no statement.
  const candidates = channelRows.filter(
    (row) =>
      row.channelId !== null &&
      !row.manuallyUnread &&
      !row.ordinaryUnread &&
      row.hasUnreadPublication
  )
  const withVisiblePublication = candidates.length
    ? await readChannelsWithVisibleUnreadPublication(database, principal, {
        channelIds: candidates.map((row) => row.channelId!),
        workspaceIds: [...new Set(candidates.map((row) => row.workspaceId))],
      })
    : new Set<string>()

  const summaries = new Map<string, { mentions: number; unreadChannels: number }>()
  for (const row of channelRows) {
    const summary = summaries.get(row.workspaceId) ?? { mentions: 0, unreadChannels: 0 }
    if (row.channelId !== null) {
      const unread =
        row.manuallyUnread || row.ordinaryUnread || withVisiblePublication.has(row.channelId)
      if (unread) summary.unreadChannels += 1
      summary.mentions += Number(row.mentions)
    }
    summaries.set(row.workspaceId, summary)
  }
  return Object.freeze(
    [...summaries].map(([workspaceId, summary]) =>
      Object.freeze({
        mentions: summary.mentions,
        unreadChannels: summary.unreadChannels,
        workspaceId,
      })
    )
  )
}
