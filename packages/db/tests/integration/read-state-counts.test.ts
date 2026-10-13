import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChannelReadStateSummary, UserPrincipalRef } from '@adea-ai/types'
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import {
  createDatabase,
  type AgentHqDatabase,
  type AgentHqTransaction,
  type DatabaseConnection,
} from '../../src/connection'
import { createMessage, deleteMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { setProjectVisibility } from '../../src/project-sharing'
import { createProject } from '../../src/projects'
import {
  listAccessibleChannelIds,
  listReadStateForUser,
  markChannelReadState,
  markThreadReadState,
} from '../../src/read-state'
import * as schema from '../../src/schema'
import {
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projectMembers,
  projects,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL
const READ_STATE_GATE_TIMEOUT_MS = 5_000

type SettledWrite<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }

function channelOf(state: readonly ChannelReadStateSummary[], channelId: string) {
  const row = state.find((entry) => entry.channelId === channelId)
  expect(row, `channel ${channelId} missing from read state`).toBeDefined()
  return row!
}

function observeWrite<T>(operation: Promise<T>): Promise<SettledWrite<T>> {
  return operation.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason })
  )
}

async function waitForReadStateUpsert(
  entered: Promise<void>,
  completion: Promise<SettledWrite<unknown>>
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      entered.then(() => ({ kind: 'entered' as const })),
      completion.then((outcome) => ({ kind: 'settled' as const, outcome })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), READ_STATE_GATE_TIMEOUT_MS)
      }),
    ])
    if (result.kind === 'entered') return
    if (result.kind === 'settled') {
      if (result.outcome.status === 'rejected') throw result.outcome.reason
      throw new Error('Read-state write completed before reaching the upsert gate')
    }
    throw new Error(
      `Read-state write did not reach the upsert gate within ${READ_STATE_GATE_TIMEOUT_MS} ms`
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Pause one read-state upsert after its transaction has read the old frontier. */
function pauseNextReadStateUpsert(
  database: AgentHqDatabase,
  table: typeof channelReadStates | typeof threadReadStates
) {
  let signalEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve
  })
  let signalRelease!: () => void
  const released = new Promise<void>((resolve) => {
    signalRelease = resolve
  })
  let intercepted = false

  const gateTransaction = (transaction: AgentHqTransaction) =>
    new Proxy(transaction as object, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (property !== 'insert') return typeof value === 'function' ? value.bind(target) : value
        return (insertedTable: unknown) => {
          const insert = Reflect.get(target, property, target) as (table: unknown) => object
          const builder = insert.call(target, insertedTable)
          if (insertedTable !== table) return builder
          return new Proxy(builder, {
            get(builderTarget, builderProperty) {
              const builderValue = Reflect.get(builderTarget, builderProperty, builderTarget)
              if (builderProperty !== 'values')
                return typeof builderValue === 'function'
                  ? builderValue.bind(builderTarget)
                  : builderValue
              return (...valuesArgs: unknown[]) => {
                const values = builderValue as (...args: unknown[]) => object
                const conflictBuilder = values.apply(builderTarget, valuesArgs)
                return new Proxy(conflictBuilder, {
                  get(conflictTarget, conflictProperty) {
                    const conflictValue = Reflect.get(
                      conflictTarget,
                      conflictProperty,
                      conflictTarget
                    )
                    if (conflictProperty !== 'onConflictDoUpdate')
                      return typeof conflictValue === 'function'
                        ? conflictValue.bind(conflictTarget)
                        : conflictValue
                    return async (...conflictArgs: unknown[]) => {
                      if (!intercepted) {
                        intercepted = true
                        signalEntered()
                        await released
                      }
                      const onConflict = conflictValue as (...args: unknown[]) => unknown
                      return onConflict.apply(conflictTarget, conflictArgs)
                    }
                  },
                })
              }
            },
          })
        }
      },
    }) as unknown as AgentHqTransaction

  const gatedDatabase = new Proxy(database as object, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property !== 'transaction')
        return typeof value === 'function' ? value.bind(target) : value
      return (
        callback: (transaction: AgentHqTransaction) => Promise<unknown>,
        ...args: unknown[]
      ) => {
        const transaction = value as (...transactionArgs: unknown[]) => Promise<unknown>
        return transaction.call(
          target,
          (tx: AgentHqTransaction) => callback(gateTransaction(tx)),
          ...args
        )
      }
    },
  }) as unknown as AgentHqDatabase

  return { database: gatedDatabase, entered, release: signalRelease }
}

describe.skipIf(!connectionUrl)('read state unread counts', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => {
    const db = connection.db
    if (workspaceIds.length) {
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
      // Replies reference their roots; drop them first.
      await db
        .delete(messages)
        .where(
          and(inArray(messages.workspaceId, workspaceIds), isNotNull(messages.threadRootMessageId))
        )
      await db.delete(messages).where(inArray(messages.workspaceId, workspaceIds))
      await db
        .delete(channelParticipants)
        .where(inArray(channelParticipants.workspaceId, workspaceIds))
      await db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await db.delete(projectMembers).where(inArray(projectMembers.workspaceId, workspaceIds))
      await db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
      await db.delete(workspaceEvents).where(inArray(workspaceEvents.workspaceId, workspaceIds))
      await db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    if (userIds.length) {
      await db.delete(temporaryUserSessions).where(inArray(temporaryUserSessions.userId, userIds))
      await db.delete(users).where(inArray(users.id, userIds))
    }
    await connection.close()
  })

  async function user(label: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `read-counts-${label}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  async function workspace(owner: UserPrincipalRef) {
    const { workspace: created } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `read-counts-${crypto.randomUUID()}`,
      name: 'Counts HQ',
      owner,
    })
    workspaceIds.push(created.id)
    return created.id
  }

  async function projectChannel(workspaceId: string, owner: UserPrincipalRef, name: string) {
    const project = await createProject(connection.db, workspaceId, owner, {
      iconKey: 'research',
      name,
    })
    const [channel] = await connection.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.projectId, project.id), eq(channels.isPrimaryProjectChannel, true)))
    return { channelId: channel!.id, projectId: project.id }
  }

  function post(
    workspaceId: string,
    channelId: string,
    sender: UserPrincipalRef,
    extra: Partial<Parameters<typeof createMessage>[4]> = {}
  ) {
    return createMessage(connection.db, workspaceId, channelId, sender, {
      bodyText: 'read counts fixture',
      idempotencyKey: crypto.randomUUID(),
      sender,
      ...extra,
    })
  }

  // The previous implementation, kept verbatim as an oracle: load every live
  // message of every accessible channel and count in memory. The SQL version
  // must agree with it field for field.
  async function reference(
    workspaceId: string,
    principal: UserPrincipalRef
  ): Promise<readonly ChannelReadStateSummary[]> {
    const db = connection.db
    const channelIds = (await listAccessibleChannelIds(db, workspaceId, principal)).map(
      ({ id }) => id
    )
    if (!channelIds.length) return []
    const channelStates = await db
      .select()
      .from(channelReadStates)
      .where(
        and(
          eq(channelReadStates.workspaceId, workspaceId),
          eq(channelReadStates.userId, principal.userId),
          inArray(channelReadStates.channelId, channelIds)
        )
      )
    const threadStates = await db
      .select()
      .from(threadReadStates)
      .where(
        and(
          eq(threadReadStates.workspaceId, workspaceId),
          eq(threadReadStates.userId, principal.userId),
          inArray(threadReadStates.channelId, channelIds)
        )
      )
    const rows = await db
      .select({
        channelId: messages.channelId,
        sequence: messages.sequence,
        threadRootMessageId: messages.threadRootMessageId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          inArray(messages.channelId, channelIds),
          isNull(messages.deletedAt)
        )
      )
      .orderBy(asc(messages.sequence))
    return channelIds.map((channelId) => {
      const channelState = channelStates.find((state) => state.channelId === channelId)
      const channelMessages = rows.filter((row) => row.channelId === channelId)
      const topLevel = channelMessages.filter((row) => !row.threadRootMessageId)
      const lastReadSequence = channelState?.lastReadSequence ?? 0
      const topLevelUnreadCount = topLevel.filter(
        ({ sequence }) => sequence > lastReadSequence
      ).length
      const roots = [...new Set(channelMessages.flatMap((row) => row.threadRootMessageId ?? []))]
      const threads = roots
        .map((threadRootMessageId) => {
          const replies = channelMessages.filter(
            (row) => row.threadRootMessageId === threadRootMessageId
          )
          const state = threadStates.find(
            (entry) => entry.threadRootMessageId === threadRootMessageId
          )
          const read = state?.lastReadSequence ?? 0
          return {
            lastReadSequence: read,
            latestSequence: replies.at(-1)!.sequence,
            manuallyUnread: state?.manuallyUnread ?? false,
            ...(state?.readAt ? { readAt: state.readAt.toISOString() } : {}),
            threadRootMessageId,
            unreadCount: replies.filter(({ sequence }) => sequence > read).length,
            ...(state?.updatedAt ? { updatedAt: state.updatedAt.toISOString() } : {}),
          }
        })
        .toSorted(
          (left, right) =>
            right.latestSequence - left.latestSequence ||
            left.threadRootMessageId.localeCompare(right.threadRootMessageId)
        )
      const threadUnreadCount = threads.reduce(
        (total, thread) => total + thread.unreadCount + (thread.manuallyUnread ? 1 : 0),
        0
      )
      const manuallyUnread = channelState?.manuallyUnread ?? false
      return {
        channelId,
        lastReadSequence,
        latestTopLevelSequence: topLevel.at(-1)?.sequence ?? 0,
        manuallyUnread,
        ...(channelState?.readAt ? { readAt: channelState.readAt.toISOString() } : {}),
        threadUnreadCount,
        threads,
        topLevelUnreadCount,
        unread: manuallyUnread || topLevelUnreadCount > 0 || threadUnreadCount > 0,
        ...(channelState?.updatedAt ? { updatedAt: channelState.updatedAt.toISOString() } : {}),
        workspaceId,
      }
    })
  }

  async function readState(workspaceId: string, principal: UserPrincipalRef) {
    const actual = await listReadStateForUser(connection.db, workspaceId, principal)
    expect(actual).toEqual(await reference(workspaceId, principal))
    return actual
  }

  test('counts thread replies, manual unread, and deletions like the message-level oracle', async () => {
    const owner = await user('owner')
    const bob = await user('bob')
    const workspaceId = await workspace(owner)
    await addWorkspaceMembership(connection.db, workspaceId, bob, 'member')
    const { channelId } = await projectChannel(workspaceId, owner, 'General')
    const { channelId: quietId } = await projectChannel(workspaceId, owner, 'Quiet')

    const first = await post(workspaceId, channelId, bob)
    const second = await post(workspaceId, channelId, bob)
    const third = await post(workspaceId, channelId, bob)
    const firstReplies = [
      await post(workspaceId, channelId, bob, { threadRootMessageId: first.id }),
      await post(workspaceId, channelId, bob, { threadRootMessageId: first.id }),
      await post(workspaceId, channelId, bob, { threadRootMessageId: first.id }),
    ]
    const secondReply = await post(workspaceId, channelId, bob, {
      threadRootMessageId: second.id,
    })

    let state = await readState(workspaceId, owner)
    expect(channelOf(state, quietId)).toMatchObject({
      latestTopLevelSequence: 0,
      threadUnreadCount: 0,
      threads: [],
      topLevelUnreadCount: 0,
      unread: false,
    })
    expect(channelOf(state, channelId)).toMatchObject({
      lastReadSequence: 0,
      latestTopLevelSequence: third.sequence,
      threadUnreadCount: 4,
      topLevelUnreadCount: 3,
      unread: true,
    })
    // Threads are ordered newest reply first.
    expect(channelOf(state, channelId).threads).toEqual([
      {
        lastReadSequence: 0,
        latestSequence: secondReply.sequence,
        manuallyUnread: false,
        threadRootMessageId: second.id,
        unreadCount: 1,
      },
      {
        lastReadSequence: 0,
        latestSequence: firstReplies[2]!.sequence,
        manuallyUnread: false,
        threadRootMessageId: first.id,
        unreadCount: 3,
      },
    ])

    // Thread unread counts follow each thread's own frontier.
    state = await markThreadReadState(
      connection.db,
      workspaceId,
      channelId,
      first.id,
      owner,
      'read',
      firstReplies[1]!.sequence
    )
    expect(state).toEqual(await reference(workspaceId, owner))
    expect(
      channelOf(state, channelId).threads.find(
        ({ threadRootMessageId }) => threadRootMessageId === first.id
      )
    ).toMatchObject({ lastReadSequence: firstReplies[1]!.sequence, unreadCount: 1 })
    expect(channelOf(state, channelId).threadUnreadCount).toBe(2)

    // A manually unread thread counts once, with nothing past its frontier.
    state = await markThreadReadState(
      connection.db,
      workspaceId,
      channelId,
      second.id,
      owner,
      'unread'
    )
    expect(state).toEqual(await reference(workspaceId, owner))
    expect(
      channelOf(state, channelId).threads.find(
        ({ threadRootMessageId }) => threadRootMessageId === second.id
      )
    ).toMatchObject({ manuallyUnread: true, unreadCount: 0 })
    expect(channelOf(state, channelId).threadUnreadCount).toBe(2)

    // Reading the channel clears top-level counts; threads keep it unread.
    state = await markChannelReadState(connection.db, workspaceId, channelId, owner, 'read')
    expect(state).toEqual(await reference(workspaceId, owner))
    expect(channelOf(state, channelId)).toMatchObject({
      lastReadSequence: third.sequence,
      topLevelUnreadCount: 0,
      unread: true,
    })
    expect(channelOf(state, channelId).readAt).toBeString()

    // A manually unread channel is unread with nothing new in it.
    await markThreadReadState(connection.db, workspaceId, channelId, first.id, owner, 'read')
    await markThreadReadState(connection.db, workspaceId, channelId, second.id, owner, 'read')
    state = await readState(workspaceId, owner)
    expect(channelOf(state, channelId).unread).toBe(false)
    state = await markChannelReadState(connection.db, workspaceId, channelId, owner, 'unread')
    expect(state).toEqual(await reference(workspaceId, owner))
    expect(channelOf(state, channelId)).toMatchObject({
      manuallyUnread: true,
      threadUnreadCount: 0,
      topLevelUnreadCount: 0,
      unread: true,
    })
    state = await markChannelReadState(connection.db, workspaceId, channelId, owner, 'read')
    expect(channelOf(state, channelId).unread).toBe(false)

    // Deleted messages never count. New unread messages, then delete them:
    // the newest top-level frontier moves back and the counts drop with them.
    const fourth = await post(workspaceId, channelId, bob)
    const lateReply = await post(workspaceId, channelId, bob, { threadRootMessageId: first.id })
    state = await readState(workspaceId, owner)
    expect(channelOf(state, channelId)).toMatchObject({
      latestTopLevelSequence: fourth.sequence,
      threadUnreadCount: 1,
      topLevelUnreadCount: 1,
    })
    await deleteMessage(connection.db, workspaceId, fourth.id, bob, fourth.version)
    await deleteMessage(connection.db, workspaceId, lateReply.id, bob, lateReply.version)
    state = await readState(workspaceId, owner)
    expect(channelOf(state, channelId)).toMatchObject({
      latestTopLevelSequence: third.sequence,
      threadUnreadCount: 0,
      topLevelUnreadCount: 0,
      unread: false,
    })
    expect(
      channelOf(state, channelId).threads.find(
        ({ threadRootMessageId }) => threadRootMessageId === first.id
      )?.latestSequence
    ).toBe(firstReplies[2]!.sequence)

    // A thread whose only live reply is deleted leaves the thread list, even
    // with a manual unread mark on it.
    await markThreadReadState(connection.db, workspaceId, channelId, second.id, owner, 'unread')
    await deleteMessage(connection.db, workspaceId, secondReply.id, bob, secondReply.version)
    state = await readState(workspaceId, owner)
    expect(
      channelOf(state, channelId).threads.map(({ threadRootMessageId }) => threadRootMessageId)
    ).toEqual([first.id])
    expect(channelOf(state, channelId).unread).toBe(false)

    // Deleting an unread top-level message below the frontier drops the count.
    const fifth = await post(workspaceId, channelId, bob)
    const sixth = await post(workspaceId, channelId, bob)
    await deleteMessage(connection.db, workspaceId, fifth.id, bob, fifth.version)
    state = await readState(workspaceId, owner)
    expect(channelOf(state, channelId)).toMatchObject({
      latestTopLevelSequence: sixth.sequence,
      topLevelUnreadCount: 1,
    })

    // Every reader has an independent view: bob has read nothing.
    const bobState = await readState(workspaceId, bob)
    expect(channelOf(bobState, channelId)).toMatchObject({
      lastReadSequence: 0,
      manuallyUnread: false,
      // first, second, third and sixth are live; fourth and fifth are deleted.
      topLevelUnreadCount: 4,
      threadUnreadCount: 3,
    })
  })

  test('keeps hidden project channels out and costs a fixed number of queries', async () => {
    const owner = await user('scope-owner')
    const bob = await user('scope-bob')
    const workspaceId = await workspace(owner)
    await addWorkspaceMembership(connection.db, workspaceId, bob, 'member')
    const open = await projectChannel(workspaceId, owner, 'Open')
    const secret = await projectChannel(workspaceId, owner, 'Secret')
    const secretRoot = await post(workspaceId, secret.channelId, owner)
    await post(workspaceId, secret.channelId, owner, { threadRootMessageId: secretRoot.id })
    await post(workspaceId, open.channelId, owner)
    await setProjectVisibility(connection.db, workspaceId, secret.projectId, owner, 'members')

    // The owner sees both; bob is not on the members-only project.
    const ownerState = await readState(workspaceId, owner)
    expect(ownerState.map(({ channelId }) => channelId).toSorted()).toEqual(
      [open.channelId, secret.channelId].toSorted()
    )
    const bobState = await readState(workspaceId, bob)
    expect(bobState.map(({ channelId }) => channelId)).toEqual([open.channelId])
    expect(bobState[0]).toMatchObject({ threadUnreadCount: 0, threads: [], topLevelUnreadCount: 1 })

    async function countQueries(principal: UserPrincipalRef) {
      let queries = 0
      const counting = postgres(connectionUrl!, {
        debug: () => {
          queries += 1
        },
        max: 1,
        prepare: false,
      })
      try {
        // Connection setup (type discovery) is not part of the read's cost.
        await counting`select 1`
        queries = 0
        const result = await listReadStateForUser(
          drizzle(counting, { schema }),
          workspaceId,
          principal
        )
        return { queries, result }
      } finally {
        await counting.end({ timeout: 5 })
      }
    }

    // Two for the project access scope, one canonical read of this user's group
    // admissions, then one channel aggregate and one thread aggregate. The
    // measured total includes the read snapshot's begin, isolation setup, and
    // commit — never one read per channel, thread, or message.
    const small = await countQueries(bob)
    expect(small.queries).toBe(8)
    expect(small.result).toEqual(bobState)

    for (let index = 0; index < 5; index += 1) {
      const { channelId } = await projectChannel(workspaceId, owner, `Busy ${index}`)
      const root = await post(workspaceId, channelId, owner)
      await post(workspaceId, channelId, owner, { threadRootMessageId: root.id })
      await post(workspaceId, channelId, owner, { threadRootMessageId: root.id })
    }
    const large = await countQueries(bob)
    expect(large.queries).toBe(8)
    expect(large.result).toHaveLength(6)
    expect(large.result).toEqual(await reference(workspaceId, bob))
  })

  test('does not rewind a non-group channel frontier when an older writer commits last', async () => {
    const owner = await user('channel-frontier-race')
    const workspaceId = await workspace(owner)
    const { channelId } = await projectChannel(workspaceId, owner, 'Channel frontier race')
    const first = await post(workspaceId, channelId, owner)
    const secondConnection = createDatabase(connectionUrl!)
    const gate = pauseNextReadStateUpsert(connection.db, channelReadStates)
    const staleWrite = observeWrite(
      markChannelReadState(gate.database, workspaceId, channelId, owner, 'read', first.sequence)
    )
    let failed = false
    let failure: unknown

    try {
      await waitForReadStateUpsert(gate.entered, staleWrite)

      const second = await createMessage(secondConnection.db, workspaceId, channelId, owner, {
        bodyText: 'newer channel frontier',
        idempotencyKey: crypto.randomUUID(),
        sender: owner,
      })
      expect(second.sequence).toBeGreaterThan(first.sequence)
      await markChannelReadState(
        secondConnection.db,
        workspaceId,
        channelId,
        owner,
        'read',
        second.sequence
      )
      gate.release()
      const outcome = await staleWrite
      if (outcome.status === 'rejected') throw outcome.reason

      const [saved] = await connection.db
        .select({ lastReadSequence: channelReadStates.lastReadSequence })
        .from(channelReadStates)
        .where(
          and(
            eq(channelReadStates.workspaceId, workspaceId),
            eq(channelReadStates.channelId, channelId),
            eq(channelReadStates.userId, owner.userId)
          )
        )
      expect(saved?.lastReadSequence).toBe(second.sequence)
    } catch (error) {
      failed = true
      failure = error
    } finally {
      gate.release()
      const outcome = await staleWrite
      try {
        await secondConnection.close()
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
      if (!failed && outcome.status === 'rejected') {
        failed = true
        failure = outcome.reason
      }
    }
    if (failed) throw failure
  })

  test('does not rewind a non-group thread frontier when an older writer commits last', async () => {
    const owner = await user('thread-frontier-race')
    const workspaceId = await workspace(owner)
    const { channelId } = await projectChannel(workspaceId, owner, 'Thread frontier race')
    const root = await post(workspaceId, channelId, owner)
    const firstReply = await post(workspaceId, channelId, owner, {
      threadRootMessageId: root.id,
    })
    const secondConnection = createDatabase(connectionUrl!)
    const gate = pauseNextReadStateUpsert(connection.db, threadReadStates)
    const staleWrite = observeWrite(
      markThreadReadState(
        gate.database,
        workspaceId,
        channelId,
        root.id,
        owner,
        'read',
        firstReply.sequence
      )
    )
    let failed = false
    let failure: unknown

    try {
      await waitForReadStateUpsert(gate.entered, staleWrite)

      const secondReply = await createMessage(secondConnection.db, workspaceId, channelId, owner, {
        bodyText: 'newer thread frontier',
        idempotencyKey: crypto.randomUUID(),
        replyToMessageId: root.id,
        sender: owner,
        threadRootMessageId: root.id,
      })
      expect(secondReply.sequence).toBeGreaterThan(firstReply.sequence)
      await markThreadReadState(
        secondConnection.db,
        workspaceId,
        channelId,
        root.id,
        owner,
        'read',
        secondReply.sequence
      )
      gate.release()
      const outcome = await staleWrite
      if (outcome.status === 'rejected') throw outcome.reason

      const [saved] = await connection.db
        .select({ lastReadSequence: threadReadStates.lastReadSequence })
        .from(threadReadStates)
        .where(
          and(
            eq(threadReadStates.workspaceId, workspaceId),
            eq(threadReadStates.channelId, channelId),
            eq(threadReadStates.threadRootMessageId, root.id),
            eq(threadReadStates.userId, owner.userId)
          )
        )
      expect(saved?.lastReadSequence).toBe(secondReply.sequence)
    } catch (error) {
      failed = true
      failure = error
    } finally {
      gate.release()
      const outcome = await staleWrite
      try {
        await secondConnection.close()
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
      if (!failed && outcome.status === 'rejected') {
        failed = true
        failure = outcome.reason
      }
    }
    if (failed) throw failure
  })
})
