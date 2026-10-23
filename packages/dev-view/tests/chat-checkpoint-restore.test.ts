import { describe, expect, test } from 'bun:test'

import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import type { CheckpointRestoreOutcome } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'
import {
  ChatRuntimeError,
  createCheckpointRestorePort,
  createCheckpointRestorer,
  type CheckpointRestorePort,
} from '../src/chat/model'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const IDENTITY = { runtimeSessionId: 'session-1', generation: 4 }
const identity = {
  schemaVersion: 1,
  restoreId: 'restore-1',
  checkpointId: 'cp-1',
  checkpointEventId: 'event-9',
  requestedGeneration: 4,
  completedAt: '2026-10-23T10:00:00.000Z',
} as const
const resolved: CheckpointRestoreOutcome = {
  ...identity,
  status: 'resolved',
  restoredGeneration: 5,
  providerRestoreId: 'provider-1',
  restoredAt: '2026-10-23T10:00:00.000Z',
}
const failed: CheckpointRestoreOutcome = { ...identity, status: 'failed', code: 'stale_generation' }
const reject = (code: string, message = code) =>
  new ChatRuntimeError({ code, retryable: false, message } as never)

function service(reply: (command: DevCommand) => unknown) {
  const commands: DevCommand[] = []
  const fake = {
    execute: async (command: DevCommand): Promise<DevReply> => {
      commands.push(command)
      const value = reply(command)
      return value instanceof ChatRuntimeError
        ? ({
            ok: false,
            error: { code: value.code, retryable: false, message: value.message },
          } as never)
        : ({ ok: true, value } as never)
    },
  } as unknown as DevRuntimeService
  return { fake, commands }
}

describe('checkpoint restore port', () => {
  test('asks the host once, bound to the session generation, with the key it was given', async () => {
    const { fake, commands } = service(() => resolved)
    const port = createCheckpointRestorePort(fake, SCOPE)
    const outcome = await port.restore(IDENTITY, {
      checkpointEventId: 'event-9',
      idempotencyKey: 'restore-abc',
    })
    expect(outcome).toEqual(resolved)
    expect(commands).toHaveLength(1)
    expect(commands[0]!.operation).toBe('dev.session.restoreCheckpoint')
    expect(commands[0]!.body).toEqual({
      runtimeSessionId: 'session-1',
      expectedGeneration: 4,
      checkpointEventId: 'event-9',
    })
    expect(commands[0]!.idempotencyKey).toBe('restore-abc')
    expect(commands[0]!.resource).toEqual({
      kind: 'runtime_session',
      id: 'session-1',
      generation: 4,
    })
  })

  test('refuses an answer that is malformed or about another checkpoint or generation', async () => {
    const input = { checkpointEventId: 'event-9', idempotencyKey: 'k' }
    for (const answer of [
      { status: 'resolved' },
      { ...resolved, checkpointEventId: 'event-other' },
      { ...resolved, requestedGeneration: 3, restoredGeneration: 4 },
    ]) {
      const { fake } = service(() => answer)
      await expect(
        createCheckpointRestorePort(fake, SCOPE).restore(IDENTITY, input)
      ).rejects.toThrow()
    }
  })
})

function scripted(script: Array<CheckpointRestoreOutcome | Error>) {
  const calls: Array<{ checkpointEventId: string; idempotencyKey: string }> = []
  const port: CheckpointRestorePort = {
    restore: async (_identity, input) => {
      calls.push({ ...input })
      const next = script.shift()
      if (next === undefined) throw new Error('unscripted')
      if (next instanceof Error) throw next
      return next
    },
  }
  let n = 0
  return {
    calls,
    restorer: createCheckpointRestorer({ port, identity: IDENTITY, randomId: () => `id${++n}` }),
  }
}

describe('checkpoint restorer', () => {
  test('success is only the typed resolved outcome, naming the next generation', async () => {
    const { restorer } = scripted([resolved])
    expect(await restorer.restore('event-9')).toEqual({
      status: 'resolved',
      restoredGeneration: 5,
      restoredAt: resolved.restoredAt,
    })
  })

  test('a failed outcome is a failure in the host’s terms, never a restore', async () => {
    const { restorer } = scripted([failed])
    const result = await restorer.restore('event-9')
    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.code).toBe('stale_generation')
    expect(result.status === 'failed' && result.message).toContain('moved on')
  })

  test('an answer lost in transit is retried with the same key; a definite answer ends the key', async () => {
    const { restorer, calls } = scripted([
      reject('timeout', 'The host did not answer.'),
      resolved,
      failed,
      resolved,
    ])
    const lost = await restorer.restore('event-9')
    expect(lost.status === 'failed' && lost.message).toBe('The host did not answer.')
    await restorer.restore('event-9')
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey)
    // The resolved answer ended that key; the next restore is a new decision.
    await restorer.restore('event-9')
    expect(calls[2]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey)
    // A different checkpoint never shares a key.
    await restorer.restore('event-10')
    expect(calls[3]!.idempotencyKey).not.toBe(calls[2]!.idempotencyKey)
  })

  test('a refusal that cannot change is final for its key', async () => {
    const { restorer, calls } = scripted([reject('unsupported_capability'), resolved])
    const refused = await restorer.restore('event-9')
    expect(refused.status === 'failed' && refused.message).toContain('cannot restore')
    await restorer.restore('event-9')
    expect(calls[1]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey)
  })

  test('one restore at a time, and none after the conversation closes', async () => {
    let release!: (value: CheckpointRestoreOutcome) => void
    const port: CheckpointRestorePort = {
      restore: () => new Promise((resolve) => (release = resolve)),
    }
    const restorer = createCheckpointRestorer({ port, identity: IDENTITY })
    const first = restorer.restore('event-9')
    const second = await restorer.restore('event-10')
    expect(second).toEqual({ status: 'failed', message: 'A restore is already running.' })
    release(resolved)
    expect((await first).status).toBe('resolved')
    restorer.dispose()
    expect((await restorer.restore('event-9')).status).toBe('failed')
  })
})
