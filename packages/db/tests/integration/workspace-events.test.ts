// Durable workspace event log: atomicity with the domain mutation, per-workspace
// ordering under concurrency, replay after a cursor, retention, publication
// records, and the contract that keeps private content out of the log.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createArtifact, setArtifactAvailability } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createMessage,
  deleteMessage,
  editMessage,
  provisionPrimaryRoomChannel,
} from '../../src/conversations'
import {
  assertCloudSafeEventPayload,
  WORKSPACE_EVENT_CONTRACTS,
  WORKSPACE_EVENT_TYPES,
} from '../../src/event-contract'
import {
  countWorkspaceEvents,
  listWorkspaceEventsAfter,
  markEventDispatchesNotified,
  pendingEventDispatches,
  pruneWorkspaceEventsBefore,
  workspaceEventWindow,
} from '../../src/event-log'
import { createTemporaryUserSession } from '../../src/identity'
import { createRoom } from '../../src/rooms'
import { workspaceEventDispatches } from '../../src/schema'
import { appendWorkspaceEvent, inTransaction } from '../../src/transactions'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('durable workspace events', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function fixture(name: string) {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `${name}-${crypto.randomUUID()}`,
      name,
      owner: owner.principal,
    })
    // Provisioning is itself a domain mutation, so the workspace's log already
    // starts with its own event; assertions are relative to that baseline.
    const { latest } = await workspaceEventWindow(connection.db, workspace.id)
    return { owner, start: latest, workspace }
  }

  const append = (workspaceId: string, eventType: string, payload: Record<string, unknown>) =>
    inTransaction(connection.db, (transaction) =>
      appendWorkspaceEvent(transaction, {
        eventType: eventType as never,
        payload,
        workspaceId,
      })
    )

  test('commits the event, its sequence, and its publication record with the mutation', async () => {
    const { start, workspace } = await fixture('events-atomic')
    const roomId = crypto.randomUUID()

    const committed = await inTransaction(connection.db, async (transaction) => {
      const event = await appendWorkspaceEvent(transaction, {
        eventType: 'room.created',
        payload: { actorUserId: null, roomId },
        workspaceId: workspace.id,
      })
      return event
    })

    expect(committed.workspaceSequence).toBe(start + 1)
    expect(committed.schemaVersion).toBe(WORKSPACE_EVENT_CONTRACTS['room.created'].schemaVersion)
    expect(committed.aggregateType).toBe('room')
    expect(committed.aggregateId).toBe(roomId)

    const [replayed] = await listWorkspaceEventsAfter(connection.db, workspace.id, start)
    expect(replayed?.eventId).toBe(committed.eventId)
    // The publication record is created with the event, not after it.
    expect((await pendingEventDispatches(connection.db, workspace.id)).at(-1)).toEqual({
      eventId: committed.eventId,
      workspaceSequence: start + 1,
    })
  })

  test('a rolled-back mutation publishes no event and leaves no sequence gap', async () => {
    const { start, workspace } = await fixture('events-rollback')
    const first = await append(workspace.id, 'room.created', { roomId: crypto.randomUUID() })

    await expect(
      inTransaction(connection.db, async (transaction) => {
        await appendWorkspaceEvent(transaction, {
          eventType: 'room.created',
          payload: { roomId: crypto.randomUUID() },
          workspaceId: workspace.id,
        })
        throw new Error('mutation failed after appending its event')
      })
    ).rejects.toThrow('mutation failed after appending its event')

    expect(await countWorkspaceEvents(connection.db, workspace.id)).toBe(start + 1)
    expect(await workspaceEventWindow(connection.db, workspace.id)).toEqual({
      earliest: 1,
      latest: start + 1,
    })

    // The next committed event continues the sequence: no phantom reservation.
    const next = await append(workspace.id, 'room.created', { roomId: crypto.randomUUID() })
    expect(next.workspaceSequence).toBe(first.workspaceSequence + 1)
  })

  test('concurrent writers receive unique, ordered, gap-free sequences', async () => {
    const { start, workspace } = await fixture('events-concurrent')
    const writers = 12

    const written = await Promise.all(
      Array.from({ length: writers }, (_, index) =>
        append(workspace.id, 'room.updated', { roomId: crypto.randomUUID(), index })
      )
    )

    const sequences = written.map((event) => event.workspaceSequence).toSorted((a, b) => a - b)
    expect(sequences).toEqual(Array.from({ length: writers }, (_, index) => start + index + 1))
    expect(new Set(written.map((event) => event.eventId)).size).toBe(writers)

    const replayed = await listWorkspaceEventsAfter(connection.db, workspace.id, start)
    expect(replayed.map((event) => event.workspaceSequence)).toEqual(sequences)
  })

  test('replays strictly after a cursor in sequence order and stops at the head', async () => {
    const { start, workspace } = await fixture('events-replay')
    for (let index = 0; index < 5; index += 1) {
      await append(workspace.id, 'room.updated', { roomId: crypto.randomUUID(), index })
    }

    const firstPage = await listWorkspaceEventsAfter(connection.db, workspace.id, start, 2)
    expect(firstPage.map((event) => event.workspaceSequence)).toEqual([start + 1, start + 2])

    const secondPage = await listWorkspaceEventsAfter(
      connection.db,
      workspace.id,
      firstPage.at(-1)!.workspaceSequence,
      10
    )
    expect(secondPage.map((event) => event.workspaceSequence)).toEqual([
      start + 3,
      start + 4,
      start + 5,
    ])

    // Idempotent replay: a cursor at the head delivers nothing.
    expect(await listWorkspaceEventsAfter(connection.db, workspace.id, start + 5)).toEqual([])
    // A cursor ahead of the head also delivers nothing; continuity is decided by
    // the retained window, not by inventing events.
    expect(await listWorkspaceEventsAfter(connection.db, workspace.id, start + 99)).toEqual([])
    expect(await workspaceEventWindow(connection.db, workspace.id)).toEqual({
      earliest: 1,
      latest: start + 5,
    })

    // Events for one workspace never leak into another workspace's replay.
    const { workspace: other } = await fixture('events-replay-other')
    const otherEvents = await listWorkspaceEventsAfter(connection.db, other.id, 0)
    expect(otherEvents.length).toBeGreaterThan(0)
    expect(otherEvents.map((event) => event.eventId)).not.toContain(firstPage[0]!.eventId)
  })

  test('retention prunes the oldest events and their publication records only', async () => {
    const { start, workspace } = await fixture('events-retention')
    for (let index = 0; index < 4; index += 1) {
      await append(workspace.id, 'room.updated', { roomId: crypto.randomUUID(), index })
    }

    const retainedFrom = start + 3
    const pruned = await pruneWorkspaceEventsBefore(connection.db, workspace.id, start + 2)
    expect(pruned).toBeGreaterThan(0)
    expect(await countWorkspaceEvents(connection.db, workspace.id)).toBe(start + 4 - pruned)
    expect(await workspaceEventWindow(connection.db, workspace.id)).toEqual({
      earliest: retainedFrom,
      latest: start + 4,
    })
    // A cursor inside the pruned range is exactly what resync is for: the log
    // answers from the retained window rather than pretending continuity.
    expect(
      (await listWorkspaceEventsAfter(connection.db, workspace.id, start + 1)).map(
        (event) => event.workspaceSequence
      )
    ).toEqual([retainedFrom, start + 4])

    const remaining = await connection.db
      .select({ id: workspaceEventDispatches.id })
      .from(workspaceEventDispatches)
      .where(eq(workspaceEventDispatches.workspaceId, workspace.id))
    expect(remaining).toHaveLength(2)
  })

  test('a lost wake-up never loses the durable event', async () => {
    const { start, workspace } = await fixture('events-wakeup')
    const first = await append(workspace.id, 'room.created', { roomId: crypto.randomUUID() })
    // Nothing marked the publication record: the wake-up was lost.
    expect((await pendingEventDispatches(connection.db, workspace.id)).at(-1)).toEqual({
      eventId: first.eventId,
      workspaceSequence: start + 1,
    })

    const second = await append(workspace.id, 'room.updated', { roomId: crypto.randomUUID() })
    // Catch-up reads answer from the log regardless of the record's state.
    const replayed = await listWorkspaceEventsAfter(connection.db, workspace.id, start)
    expect(replayed.map((event) => event.eventId)).toEqual([first.eventId, second.eventId])

    // Marking is idempotent and counts one attempt per notified record.
    const pendingBefore = (await pendingEventDispatches(connection.db, workspace.id)).length
    expect(
      await markEventDispatchesNotified(connection.db, workspace.id, second.workspaceSequence)
    ).toBe(pendingBefore)
    expect(
      await markEventDispatchesNotified(connection.db, workspace.id, second.workspaceSequence)
    ).toBe(0)
    expect(await pendingEventDispatches(connection.db, workspace.id)).toEqual([])
  })

  test('refuses payloads that would leak private content, keys, or transient deltas', async () => {
    const { start, workspace } = await fixture('events-redaction')

    const messageId = crypto.randomUUID()
    const forbidden: Record<string, unknown>[] = [
      { bodyText: 'private objective', messageId },
      { delta: [{ text: 'partial token' }], messageId },
      { keyEnvelope: { wrapped: 'abc' }, messageId },
      { messageId, storageUrl: 'https://example.test/signed' },
      { messageId, nested: { credentials: { token: 'secret' } } },
    ]
    for (const payload of forbidden) {
      expect(() => assertCloudSafeEventPayload('message.created', payload)).toThrow(
        /cannot enter the durable workspace event log/
      )
    }

    // Fail closed on the append path: no event, no sequence consumed.
    await expect(
      append(workspace.id, 'message.created', {
        bodyText: 'private message body',
        messageId: crypto.randomUUID(),
      })
    ).rejects.toThrow(/cannot enter the durable workspace event log/)
    expect(await countWorkspaceEvents(connection.db, workspace.id)).toBe(start)
    expect((await workspaceEventWindow(connection.db, workspace.id)).latest).toBe(start)

    // An unknown or transient event type is refused rather than logged.
    await expect(
      append(workspace.id, 'message.delta', { messageId: crypto.randomUUID() })
    ).rejects.toThrow(/Unknown durable workspace event type/)
    expect(WORKSPACE_EVENT_TYPES).not.toContain('message.delta')

    // Every registered type declares a positive payload version.
    for (const type of WORKSPACE_EVENT_TYPES) {
      expect(WORKSPACE_EVENT_CONTRACTS[type].schemaVersion).toBeGreaterThan(0)
    }
  })

  test('bounded payloads: an oversized event is refused', async () => {
    const { start, workspace } = await fixture('events-bounded')
    await expect(
      append(workspace.id, 'room.updated', {
        blob: 'x'.repeat(9 * 1024),
        roomId: crypto.randomUUID(),
      })
    ).rejects.toThrow(/durable event budget/)
    expect(await countWorkspaceEvents(connection.db, workspace.id)).toBe(start)
  })

  test('conversation mutations emit cloud-safe create, update, and delete events', async () => {
    const { owner, workspace } = await fixture('events-conversation')
    const room = await createRoom(connection.db, workspace.id, owner.principal, {
      functionKey: 'engineering',
      name: 'Event Room',
    })
    const channel = await provisionPrimaryRoomChannel(
      connection.db,
      workspace.id,
      room.id,
      owner.principal
    )

    const created = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      bodyText: 'durable message body',
      idempotencyKey: 'event-log-message',
      sender: owner.principal,
    })
    const edited = await editMessage(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      { bodyText: 'edited durable body' },
      created.version
    )
    await deleteMessage(connection.db, workspace.id, created.id, owner.principal, edited.version)

    const events = await listWorkspaceEventsAfter(connection.db, workspace.id, 0)
    const messageEvents = events.filter((event) => event.aggregateType === 'message')
    expect(messageEvents.map((event) => event.eventType)).toEqual([
      'message.created',
      'message.updated',
      'message.deleted',
    ])
    for (const event of messageEvents) {
      expect(event.aggregateId).toBe(created.id)
      expect(event.actor).toEqual({ id: owner.principal.userId, kind: 'user' })
      // The body text stays in the Message row; the event carries an identity.
      expect(JSON.stringify(event.payload)).not.toContain('durable message body')
      expect(JSON.stringify(event.payload)).not.toContain('edited durable body')
    }
    // Room and channel provisioning are visible in the same ordered log, in
    // sequence order with no gaps.
    expect(events.map((event) => event.workspaceSequence)).toEqual(
      events.map((_, index) => index + 1)
    )
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['workspace.created', 'room.created', 'channel.created'])
    )
  })

  test('two clients at different cursors converge on the same durable history', async () => {
    const { start, workspace } = await fixture('events-convergence')

    // Client A applies the first two events, client B nothing yet.
    const first = await append(workspace.id, 'message.created', { messageId: crypto.randomUUID() })
    const second = await append(workspace.id, 'message.updated', { messageId: crypto.randomUUID() })
    const clientACursor = second.workspaceSequence

    // A third event lands while client A is connected and client B is away.
    const third = await append(workspace.id, 'message.deleted', { messageId: crypto.randomUUID() })

    const clientB = await listWorkspaceEventsAfter(connection.db, workspace.id, start)
    const clientAResume = await listWorkspaceEventsAfter(connection.db, workspace.id, clientACursor)

    // Both converge on the same final state: B replays everything it missed,
    // A resumes after its cursor, and neither depends on a transient delta.
    const clientAHistory = [first, second]
      .map((event) => event.eventId)
      .concat(clientAResume.map((event) => event.eventId))
    expect(clientAHistory).toEqual(clientB.map((event) => event.eventId))
    expect(clientAResume.map((event) => event.workspaceSequence)).toEqual([third.workspaceSequence])

    // Replay is idempotent across clients: the same cursor yields the same page.
    expect(await listWorkspaceEventsAfter(connection.db, workspace.id, start)).toEqual(clientB)
    // And no client can reach another workspace's history.
    const other = await fixture('events-convergence-other')
    expect(
      (await listWorkspaceEventsAfter(connection.db, other.workspace.id, 0)).map(
        (event) => event.eventId
      )
    ).not.toContain(third.eventId)
  })

  test('artifact availability changes travel as bounded metadata events', async () => {
    const { owner, workspace } = await fixture('events-artifact')
    const artifact = await createArtifact(connection.db, workspace.id, owner.principal, {
      checksumSha256: 'a'.repeat(64),
      filename: 'brief.md',
      location: { reference: 'outputs/brief-1', runtimeNodeId: 'node-1', type: 'runtime_node' },
      mediaType: 'text/markdown',
      sensitivity: 'workspace',
      sizeBytes: 1024,
      sourceArtifactRef: 'runtime-output:brief',
      sourcePrincipal: owner.principal,
    })
    await setArtifactAvailability(
      connection.db,
      workspace.id,
      artifact.id,
      owner.principal,
      'unavailable',
      artifact.version
    )

    const events = await listWorkspaceEventsAfter(connection.db, workspace.id, 0)
    const availability = events.find((event) => event.eventType === 'artifact.availability_changed')
    expect(availability).toBeDefined()
    expect(availability!.aggregateId).toBe(artifact.id)
    expect(availability!.payload).toEqual({
      actorUserId: owner.principal.userId,
      artifactId: artifact.id,
      availability: 'unavailable',
    })
    // Cloud-safe: an availability hint, never a location or credential.
    expect(JSON.stringify(events)).not.toContain('outputs/brief-1')
  })
})
