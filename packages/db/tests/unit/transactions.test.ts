import { describe, expect, test } from 'bun:test'

import type { AgentHqDatabase, AgentHqTransaction } from '../../src/connection'
import {
  appendWorkspaceEvent,
  inReadSnapshot,
  inTransaction,
  lockWorkspaceEventSequence,
  ReadSnapshotIsolationError,
  type WorkspaceEventInput,
} from '../../src/transactions'
import {
  workspaceEventDispatches,
  workspaceEventSequences,
  workspaceEvents,
} from '../../src/schema'

function transactionWithIsolation(isolationLevel: string): AgentHqTransaction {
  return {
    execute: async () => [{ isolationLevel }],
    rollback: () => undefined,
  } as unknown as AgentHqTransaction
}

describe('inReadSnapshot', () => {
  test('rejects a caller-owned READ COMMITTED transaction before invoking the reader', async () => {
    const transaction = transactionWithIsolation('read committed')
    let invoked = false

    await expect(
      inReadSnapshot(transaction, async () => {
        invoked = true
        return 'read result'
      })
    ).rejects.toThrow('REPEATABLE READ or SERIALIZABLE')

    expect(invoked).toBe(false)
  })

  for (const isolationLevel of ['repeatable read', 'serializable']) {
    test(`reuses a caller-owned ${isolationLevel.toUpperCase()} transaction`, async () => {
      const transaction = transactionWithIsolation(isolationLevel)

      await expect(inReadSnapshot(transaction, async (existing) => existing)).resolves.toBe(
        transaction
      )
    })
  }
})

test('root snapshot and mutation callbacks retain the caller transaction and result', async () => {
  const tx = transactionWithIsolation('repeatable read')
  const calls: unknown[] = []
  const database = {
    transaction: async (
      operation: (transaction: AgentHqTransaction) => Promise<unknown>,
      config?: unknown
    ) => {
      calls.push(config)
      return operation(tx)
    },
  } as unknown as AgentHqDatabase
  expect(
    await inReadSnapshot(database, async (existing) => {
      expect(existing).toBe(tx)
      return 'snapshot'
    })
  ).toBe('snapshot')
  expect(
    await inTransaction(database, async (existing) => {
      expect(existing).toBe(tx)
      return 'mutation'
    })
  ).toBe('mutation')
  expect(calls).toEqual([{ accessMode: 'read only', isolationLevel: 'repeatable read' }, undefined])
  await expect(
    inTransaction(database, async () => {
      throw new Error('mutation refused')
    })
  ).rejects.toThrow('mutation refused')
})

test('missing, weak and uppercase isolation evidence has explicit outcomes', async () => {
  for (const rows of [[], [{}], [{ isolationLevel: 'read uncommitted' }]]) {
    const tx = {
      rollback: () => undefined,
      execute: async () => rows,
    } as unknown as AgentHqTransaction
    let called = false
    await expect(
      inReadSnapshot(tx, async () => {
        called = true
      })
    ).rejects.toBeInstanceOf(ReadSnapshotIsolationError)
    expect(called).toBe(false)
  }
  expect(await inReadSnapshot(transactionWithIsolation('REPEATABLE READ'), async () => 1)).toBe(1)
})

function eventTransaction(
  options: { allocation?: boolean; event?: boolean; lock?: boolean; dispatchFailure?: boolean } = {}
) {
  const writes: { table: unknown; values?: Record<string, unknown>; conflict?: unknown }[] = []
  const locks: unknown[] = []
  const occurredAt = new Date('2026-01-01T00:00:00.000Z')
  const tx = {
    insert: (table: unknown) => {
      const write = { table } as (typeof writes)[number]
      writes.push(write)
      return {
        values: (values: Record<string, unknown>) => {
          write.values = values
          if (table === workspaceEventDispatches) {
            if (options.dispatchFailure) return Promise.reject(new Error('dispatch failed'))
            return Promise.resolve()
          }
          return {
            onConflictDoNothing: async (conflict: unknown) => {
              write.conflict = conflict
            },
            onConflictDoUpdate: (conflict: unknown) => {
              write.conflict = conflict
              return {
                returning: async () => (options.allocation === false ? [] : [{ lastSequence: 7 }]),
              }
            },
            returning: async () => (options.event === false ? [] : [{ id: 'event-1', occurredAt }]),
          }
        },
      }
    },
    select: () => ({
      from: () => ({
        where: (predicate: unknown) => ({
          for: async (mode: unknown) => {
            locks.push({ predicate, mode })
            return options.lock === false ? [] : [{ workspaceId: 'workspace-1' }]
          },
        }),
      }),
    }),
  } as unknown as AgentHqTransaction
  return { tx, writes, locks, occurredAt }
}

describe('workspace event transaction composition with recording fakes', () => {
  test('sequence locking inserts the counter once then acquires an update row lock', async () => {
    const fixture = eventTransaction()
    await lockWorkspaceEventSequence(fixture.tx, 'workspace-1')
    expect(fixture.writes).toEqual([
      {
        table: workspaceEventSequences,
        values: { workspaceId: 'workspace-1', lastSequence: 0 },
        conflict: { target: workspaceEventSequences.workspaceId },
      },
    ])
    expect(fixture.locks).toEqual([{ predicate: expect.anything(), mode: 'update' }])
    await expect(
      lockWorkspaceEventSequence(eventTransaction({ lock: false }).tx, 'workspace-1')
    ).rejects.toThrow('Workspace event sequence lock failed')
  })

  test('appends versioned aggregate metadata and its matching dispatch in order', async () => {
    const fixture = eventTransaction()
    const event: WorkspaceEventInput = {
      workspaceId: 'workspace-1',
      eventType: 'agent.profile_changed',
      payload: { agentId: 'agent-1', actorUserId: 'user-1' },
      correlationId: 'request-1',
      occurredAt: fixture.occurredAt,
    }
    expect(await appendWorkspaceEvent(fixture.tx, event)).toEqual({
      aggregateId: 'agent-1',
      aggregateType: 'agent',
      correlationId: 'request-1',
      eventId: 'event-1',
      eventType: 'agent.profile_changed',
      occurredAt: fixture.occurredAt,
      schemaVersion: 2,
      workspaceId: 'workspace-1',
      workspaceSequence: 7,
    })
    expect(fixture.writes.map((write) => write.table)).toEqual([
      workspaceEventSequences,
      workspaceEvents,
      workspaceEventDispatches,
    ])
    expect(fixture.writes[0]?.values).toEqual({ workspaceId: 'workspace-1', lastSequence: 1 })
    expect(fixture.writes[1]?.values).toEqual({
      actorId: 'user-1',
      actorKind: 'user',
      aggregateId: 'agent-1',
      aggregateType: 'agent',
      correlationId: 'request-1',
      eventType: 'agent.profile_changed',
      occurredAt: fixture.occurredAt,
      payload: event.payload,
      schemaVersion: 2,
      workspaceId: 'workspace-1',
      workspaceSequence: 7,
    })
    expect(fixture.writes[2]?.values).toEqual({
      eventId: 'event-1',
      workspaceId: 'workspace-1',
      workspaceSequence: 7,
    })
  })

  test('workspace events derive provisioning actors, allow explicit actors and omit absent optional fields', async () => {
    for (const variant of [
      { payload: { ownerUserId: 'owner-1' }, actorId: 'owner-1', actorKind: 'user' },
      {
        payload: { actorUserId: 'user-1', ownerUserId: 'owner-1' },
        actorId: 'user-1',
        actorKind: 'user',
      },
      { payload: {}, actorId: null, actorKind: null },
      { payload: { actorUserId: 1 }, actorId: null, actorKind: null },
      {
        payload: { actorUserId: 'user-1' },
        actor: { kind: 'system' as const, id: 'system-1' },
        actorId: 'system-1',
        actorKind: 'system',
      },
    ]) {
      const fixture = eventTransaction()
      const record = await appendWorkspaceEvent(fixture.tx, {
        workspaceId: 'workspace-1',
        eventType: 'workspace.created',
        payload: variant.payload,
        ...('actor' in variant ? { actor: variant.actor } : {}),
      })
      expect(record.aggregateId).toBeNull()
      expect(record.correlationId).toBeNull()
      expect(fixture.writes[1]?.values).toMatchObject({
        actorId: variant.actorId,
        actorKind: variant.actorKind,
      })
      expect(fixture.writes[1]?.values).not.toHaveProperty('correlationId')
      expect(fixture.writes[1]?.values).not.toHaveProperty('occurredAt')
    }
  })

  test('validation and write failures stop before later writes', async () => {
    const invalid = eventTransaction()
    await expect(
      appendWorkspaceEvent(invalid.tx, {
        workspaceId: 'workspace-1',
        eventType: 'message.created',
        payload: { messageId: 'message-1', body: 'synthetic-private' },
      })
    ).rejects.toThrow('cannot enter')
    expect(invalid.writes).toEqual([])
    const event: WorkspaceEventInput = {
      workspaceId: 'workspace-1',
      eventType: 'workspace.created',
      payload: {},
    }
    for (const [options, count, message] of [
      [{ allocation: false }, 1, 'Workspace event sequence allocation failed'],
      [{ event: false }, 2, 'was not appended'],
      [{ dispatchFailure: true }, 3, 'dispatch failed'],
    ] as const) {
      const fixture = eventTransaction(options)
      await expect(appendWorkspaceEvent(fixture.tx, event)).rejects.toThrow(message)
      expect(fixture.writes).toHaveLength(count)
    }
  })
})
