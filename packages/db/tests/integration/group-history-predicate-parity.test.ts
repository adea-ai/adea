import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createGroupChannel, createMessage, setChannelParticipants } from '../../src/conversations'
import {
  channelIsAmongGroups,
  groupHistoryMessageAndThreadVisibleCondition,
  groupHistoryMessageVisibleCondition,
  groupSummaryMessageAndThreadVisibleCondition,
  groupSummaryMessageVisibleCondition,
  type GroupHistoryAccess,
} from '../../src/group-participation-store'
import { createTemporaryUserSession } from '../../src/identity'
import {
  agents,
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projects,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

// The group history predicates used to spread a reader's groups into per-group `= $n` terms, which
// cost 22 to 37 bound parameters per group on the account summary and inbox and stopped working
// past the protocol's 65,534-parameter limit. They now bind each group map as one JSON parameter.
// This file holds the new predicates to the old ones on a populated database: the same messages
// must be visible for every access map, and a very large map must still run.

const connectionUrl = process.env.DATABASE_URL

type Access = ReadonlyMap<string, GroupHistoryAccess>

// The OR-chain predicates exactly as they were before the change, kept only as the oracle.
function referenceBase(
  input: { channelId: SQL; sequence: SQL; access: Access },
  includesEarlier: (history: GroupHistoryAccess) => boolean
): SQL {
  const conditions = [...input.access].map(([channelId, history]) =>
    includesEarlier(history)
      ? sql`${input.channelId} = ${channelId}::uuid`
      : sql`(${input.channelId} = ${channelId}::uuid and ${input.sequence} >= ${history.joinedSequence})`
  )
  return conditions.length ? (or(...conditions) ?? sql`false`) : sql`false`
}

function referenceWithThread(
  input: {
    channelId: SQL
    sequence: SQL
    threadRootMessageId: SQL
    replyToMessageId: SQL
    access: Access
  },
  includesEarlier: (history: GroupHistoryAccess) => boolean
): SQL {
  const visibility = (channelId: SQL, sequence: SQL) =>
    referenceBase({ channelId, sequence, access: input.access }, includesEarlier)
  return sql`(
    ${visibility(input.channelId, input.sequence)}
    and (
      ${input.threadRootMessageId} is null
      or exists (
        select 1 from ${messages} as history_root
        where history_root.id = ${input.threadRootMessageId}
          and history_root.channel_id = ${input.channelId}
          and ${visibility(sql.raw('history_root.channel_id'), sql.raw('history_root.sequence'))}
      )
    )
    and (
      ${input.replyToMessageId} is null
      or exists (
        select 1 from ${messages} as history_reply_parent
        where history_reply_parent.id = ${input.replyToMessageId}
          and history_reply_parent.channel_id = ${input.channelId}
          and ${visibility(sql.raw('history_reply_parent.channel_id'), sql.raw('history_reply_parent.sequence'))}
      )
    )
  )`
}

// mulberry32: a fixed seed keeps every run on the same access maps.
function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

describe.skipIf(!connectionUrl)('group history predicates against the OR-chain oracle', () => {
  let connection: DatabaseConnection
  let workspaceId: string
  const userIds: string[] = []
  const groups: Array<{ id: string; sequences: number[] }> = []

  beforeAll(async () => {
    connection = createDatabase(connectionUrl!)
    const db = connection.db
    const newUser = async (label: string) => {
      const session = await createTemporaryUserSession(db, {
        credentialDigest: `parity-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 300_000),
      })
      userIds.push(session.principal.userId)
      return session.principal
    }
    const owner = await newUser('owner')
    const reader = await newUser('reader')
    const { workspace } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `parity-${crypto.randomUUID()}`,
      name: 'Predicate parity HQ',
      owner,
    })
    workspaceId = workspace.id
    await addWorkspaceMembership(db, workspaceId, reader, 'member')

    for (let index = 0; index < 5; index++) {
      const channel = await createGroupChannel(db, workspaceId, owner, {
        idempotencyKey: `parity-${crypto.randomUUID()}`,
        title: `Parity group ${index}`,
      })
      await setChannelParticipants(
        db,
        workspaceId,
        channel.id,
        owner,
        [owner, reader].map((principal) => ({ kind: 'user' as const, userId: principal.userId })),
        channel.version
      )
      const sequences: number[] = []
      let root: { id: string } | undefined
      let previous: { id: string } | undefined
      for (let message = 0; message < 9; message++) {
        const sent = (await createMessage(db, workspaceId, channel.id, owner, {
          bodyText: `parity ${index}/${message}`,
          idempotencyKey: crypto.randomUUID(),
          sender: owner,
          // A thread under the second message, and replies that quote the previous message.
          ...(message >= 3 && root ? { threadRootMessageId: root.id } : {}),
          ...(message % 4 === 2 && previous ? { replyToMessageId: previous.id } : {}),
        })) as unknown as { id: string; sequence: number }
        sequences.push(sent.sequence)
        if (message === 1) root = sent
        previous = sent
      }
      groups.push({ id: channel.id, sequences })
    }
  })

  afterAll(async () => {
    const db = connection.db
    if (workspaceId) {
      const ids = [workspaceId]
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, ids))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, ids))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, ids))
      await db
        .delete(messages)
        .where(and(inArray(messages.workspaceId, ids), isNotNull(messages.threadRootMessageId)))
      await db.delete(messages).where(inArray(messages.workspaceId, ids))
      await db.delete(channelParticipants).where(inArray(channelParticipants.workspaceId, ids))
      await db.delete(channels).where(inArray(channels.workspaceId, ids))
      await db.delete(agents).where(inArray(agents.workspaceId, ids))
      await db.delete(projects).where(inArray(projects.workspaceId, ids))
      await db.delete(workspaceEvents).where(inArray(workspaceEvents.workspaceId, ids))
      await db.delete(workspaceMemberships).where(inArray(workspaceMemberships.workspaceId, ids))
      await db.delete(workspaces).where(inArray(workspaces.id, ids))
    }
    for (const userId of userIds) {
      await db.delete(temporaryUserSessions).where(eq(temporaryUserSessions.userId, userId))
      await db.delete(users).where(eq(users.id, userId))
    }
    await connection.close()
  })

  async function visibleIds(condition: SQL): Promise<string[]> {
    const rows = await connection.db.execute<{ id: string }>(sql`
      select candidate.id from ${messages} as candidate
      where candidate.workspace_id = ${workspaceId} and ${condition}
      order by candidate.id
    `)
    return [...rows].map((row) => row.id)
  }

  const candidate = {
    channelId: sql.raw('candidate.channel_id'),
    sequence: sql.raw('candidate.sequence'),
    threadRootMessageId: sql.raw('candidate.thread_root_message_id'),
    replyToMessageId: sql.raw('candidate.reply_to_message_id'),
  }

  function accessMaps(): Access[] {
    const next = random(20261017)
    const maps: Access[] = [new Map()]
    for (let trial = 0; trial < 150; trial++) {
      const map = new Map<string, GroupHistoryAccess>()
      for (const group of groups) {
        if (next() < 0.3) continue
        const edge = [0, 1, group.sequences[0]!, group.sequences[4]!, group.sequences.at(-1)!]
        const pick = next()
        map.set(group.id, {
          joinedSequence:
            pick < 0.5
              ? group.sequences[Math.floor(next() * group.sequences.length)]!
              : edge[Math.floor(next() * edge.length)]! + (next() < 0.2 ? 1 : 0),
          includesEarlierHistory: next() < 0.5,
          includesEarlierSummary: next() < 0.5,
        })
      }
      // Groups the reader holds elsewhere never match a fixture message.
      for (let extra = Math.floor(next() * 3); extra > 0; extra--) {
        map.set(crypto.randomUUID(), {
          joinedSequence: 1,
          includesEarlierHistory: true,
          includesEarlierSummary: true,
        })
      }
      maps.push(map)
    }
    return maps
  }

  test('history and summary predicates show exactly the messages the OR chain showed', async () => {
    let showing = 0
    for (const access of accessMaps()) {
      const history = await visibleIds(
        groupHistoryMessageVisibleCondition({ ...candidate, access })
      )
      const summary = await visibleIds(
        groupSummaryMessageVisibleCondition({ ...candidate, access })
      )
      expect(history).toEqual(
        await visibleIds(referenceBase({ ...candidate, access }, (h) => h.includesEarlierHistory))
      )
      expect(summary).toEqual(
        await visibleIds(referenceBase({ ...candidate, access }, (h) => h.includesEarlierSummary))
      )
      showing += history.length + summary.length
    }
    // The maps are not all empty or all full: the comparison saw both visible and hidden rows.
    expect(showing).toBeGreaterThan(0)
  })

  test('the thread and reply-parent wrappers compose the same way', async () => {
    let showing = 0
    let hidden = 0
    for (const access of accessMaps()) {
      const history = await visibleIds(
        groupHistoryMessageAndThreadVisibleCondition({ ...candidate, access })
      )
      const summary = await visibleIds(
        groupSummaryMessageAndThreadVisibleCondition({ ...candidate, access })
      )
      expect(history).toEqual(
        await visibleIds(
          referenceWithThread({ ...candidate, access }, (h) => h.includesEarlierHistory)
        )
      )
      expect(summary).toEqual(
        await visibleIds(
          referenceWithThread({ ...candidate, access }, (h) => h.includesEarlierSummary)
        )
      )
      showing += history.length + summary.length
      hidden += access.size ? groups.length * 9 - history.length : 0
    }
    expect(showing).toBeGreaterThan(0)
    expect(hidden).toBeGreaterThan(0)
  })

  test('group membership by channel matches an array of ids', async () => {
    const next = random(7)
    for (let trial = 0; trial < 25; trial++) {
      const chosen = groups.filter(() => next() < 0.5).map((group) => group.id)
      const withForeign = [...chosen, crypto.randomUUID()]
      const rows = async (condition: SQL) =>
        [
          ...(await connection.db.execute<{ id: string }>(sql`
            select channel.id from ${channels} as channel
            where channel.workspace_id = ${workspaceId} and ${condition}
            order by channel.id
          `)),
        ].map((row) => row.id)
      expect(await rows(channelIsAmongGroups(sql.raw('channel.id'), withForeign))).toEqual(
        chosen.toSorted()
      )
    }
  })

  test('a reader in 70,000 groups still runs, where 65,534 parameters were the old ceiling', async () => {
    const real = new Map<string, GroupHistoryAccess>(
      groups.slice(0, 3).map((group, index) => [
        group.id,
        {
          joinedSequence: group.sequences[3]!,
          // The first group shows everything, so the comparison below has rows to compare.
          includesEarlierHistory: index === 0,
          includesEarlierSummary: true,
        },
      ])
    )
    const huge = new Map(real)
    for (let index = 0; index < 70_000; index++)
      huge.set(crypto.randomUUID(), {
        joinedSequence: index,
        includesEarlierHistory: index % 2 === 0,
        includesEarlierSummary: index % 3 === 0,
      })
    const small = await visibleIds(
      groupHistoryMessageAndThreadVisibleCondition({ ...candidate, access: real })
    )
    expect(small.length).toBeGreaterThan(0)
    expect(
      await visibleIds(groupHistoryMessageAndThreadVisibleCondition({ ...candidate, access: huge }))
    ).toEqual(small)
    expect(
      await visibleIds(groupSummaryMessageAndThreadVisibleCondition({ ...candidate, access: huge }))
    ).toEqual(
      await visibleIds(groupSummaryMessageAndThreadVisibleCondition({ ...candidate, access: real }))
    )
  })
})
