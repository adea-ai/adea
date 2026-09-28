import { expect, test } from 'bun:test'
import type { DevCommand, DevReply, Scope, TerminalRecord } from '@adea-ai/types/dev-runtime'
import { resolveSelectedTerminal } from '../src/terminal/selected-terminal'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const session = '00000000-0000-4000-8000-000000000004'
const worktree = '00000000-0000-4000-8000-000000000005'
const primary = '00000000-0000-4000-8000-000000000006'
const other = '00000000-0000-4000-8000-000000000007'
const selection = { runtimeSessionId: session, worktreeId: worktree, terminalId: primary }
function record(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id: primary,
    scope,
    runtimeSessionId: session,
    worktreeId: worktree,
    sidecarId: 'sidecar',
    processRecordId: 'process',
    state: 'running',
    health: 'healthy',
    generation: 12,
    lastSeq: '33',
    ...overrides,
  }
}
function success(
  command: DevCommand,
  items: readonly TerminalRecord[],
  nextCursor?: string
): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    observedAt: '2026-09-27T20:00:00.000Z',
    value: { items, observedAt: '2026-09-27T20:00:00.000Z', ...(nextCursor ? { nextCursor } : {}) },
  }
}

test('resolves the exact selected terminal across pages and retains its own generation', async () => {
  const commands: DevCommand[] = []
  const result = await resolveSelectedTerminal({
    scope,
    selection,
    execute: async (command) => {
      commands.push(command)
      return commands.length === 1
        ? success(command, [record({ id: other })], 'next')
        : success(command, [record()])
    },
  })
  expect(result).toEqual({ status: 'ready', terminal: record() })
  expect(commands.map((command) => command.body)).toEqual([
    { runtimeSessionId: session, worktreeId: worktree, limit: 500 },
    { runtimeSessionId: session, worktreeId: worktree, limit: 500, cursor: 'next' },
  ])
  expect(commands.every((command) => command.operation === 'dev.terminal.list')).toBe(true)
  expect(
    commands.every(
      (command) => command.capabilities.join() === 'dev.terminal.attach' && !command.resource
    )
  ).toBe(true)
})

test('missing primary identity never chooses the first terminal or issues a command', async () => {
  let calls = 0
  const result = await resolveSelectedTerminal({
    scope,
    selection: { ...selection, terminalId: undefined },
    execute: async (command) => {
      calls++
      return success(command, [record({ id: other })])
    },
  })
  expect(result).toMatchObject({ status: 'unavailable', reason: 'not_found' })
  expect(calls).toBe(0)
})

test('refuses cross-scope, cross-session, and cross-worktree records with the requested ID', async () => {
  for (const candidate of [
    record({ scope: { ...scope, workspaceId: other } }),
    record({ runtimeSessionId: other }),
    record({ worktreeId: other }),
  ]) {
    const result = await resolveSelectedTerminal({
      scope,
      selection,
      execute: async (command) => success(command, [candidate]),
    })
    expect(result).toMatchObject({ status: 'unavailable', reason: 'identity_mismatch' })
  }
})

test('refuses duplicate exact IDs even when a later page conflicts', async () => {
  let calls = 0
  const result = await resolveSelectedTerminal({
    scope,
    selection,
    execute: async (command) => {
      calls++
      return calls === 1
        ? success(command, [record()], 'next')
        : success(command, [record({ generation: 13 })])
    },
  })
  expect(result).toMatchObject({ status: 'unavailable', reason: 'incompatible' })
  expect(calls).toBe(2)
})

test('retiring a pending selection prevents further pages and ignores its result', async () => {
  const controller = new AbortController()
  let release!: (reply: DevReply) => void
  let command!: DevCommand
  let calls = 0
  const result = resolveSelectedTerminal({
    scope,
    selection,
    signal: controller.signal,
    execute: (value) => {
      calls++
      command = value
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  controller.abort()
  release(success(command, [record()], 'next'))
  expect(await result).toMatchObject({ status: 'unavailable', reason: 'cancelled' })
  expect(calls).toBe(1)
})

test('bounds unique cursor chains before requesting page 65', async () => {
  let calls = 0
  const result = await resolveSelectedTerminal({
    scope,
    selection,
    execute: async (command) => {
      calls++
      return success(command, [], `cursor-${calls}`)
    },
  })
  expect(result).toMatchObject({ status: 'unavailable', reason: 'limit_exceeded' })
  expect(calls).toBe(64)
})

test('rejects oversized pages and repeated cursors', async () => {
  expect(
    await resolveSelectedTerminal({
      scope,
      selection,
      execute: async (command) =>
        success(
          command,
          Array.from({ length: 501 }, () => record())
        ),
    })
  ).toMatchObject({ status: 'unavailable', reason: 'limit_exceeded' })
  let calls = 0
  expect(
    await resolveSelectedTerminal({
      scope,
      selection,
      execute: async (command) => {
        calls++
        return success(command, [], 'same')
      },
    })
  ).toMatchObject({ status: 'unavailable', reason: 'incompatible' })
  expect(calls).toBe(2)
})

test('preserves a host denial and rejects mismatched reply identity or malformed record', async () => {
  expect(
    await resolveSelectedTerminal({
      scope,
      selection,
      execute: async (command) => ({
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: false,
        error: {
          code: 'capability_unavailable',
          retryable: false,
          message: 'denied',
          observedAt: '2026-09-27T20:00:00.000Z',
        },
      }),
    })
  ).toMatchObject({ status: 'unavailable', reason: 'capability_unavailable' })
  expect(
    await resolveSelectedTerminal({
      scope,
      selection,
      execute: async (command) => ({ ...success(command, [record()]), requestId: other }),
    })
  ).toMatchObject({ status: 'unavailable', reason: 'incompatible' })
  expect(
    await resolveSelectedTerminal({
      scope,
      selection,
      execute: async (command) => success(command, [record({ generation: -1 })]),
    })
  ).toMatchObject({ status: 'unavailable', reason: 'incompatible' })
})

test('terminal lifecycle and health prevent attaching ended or faulted terminals', async () => {
  for (const candidate of [
    record({ state: 'exited' }),
    record({ state: 'terminating' }),
    record({ state: 'creating' }),
    record({ health: 'faulted' }),
  ]) {
    expect(
      await resolveSelectedTerminal({
        scope,
        selection,
        execute: async (command) => success(command, [candidate]),
      })
    ).toMatchObject({ status: 'unavailable', reason: 'unavailable' })
  }
})

test('rejects malformed page metadata using the canonical reply contract', async () => {
  for (const change of [
    { nextCursor: 'x'.repeat(513) },
    { observedAt: 'invalid' },
    { extra: true },
  ]) {
    expect(
      await resolveSelectedTerminal({
        scope,
        selection,
        execute: async (command) => {
          const reply = success(command, [record()])
          return {
            ...reply,
            value: { ...(reply.ok ? (reply.value as object) : {}), ...change },
          } as DevReply
        },
      })
    ).toMatchObject({ status: 'unavailable', reason: 'incompatible' })
  }
})

test('rejects non-target rows that violate the filtered listing identity', async () => {
  for (const candidate of [
    record({ id: other, scope: { ...scope, workspaceId: other } }),
    record({ id: other, runtimeSessionId: other }),
    record({ id: other, worktreeId: other }),
  ]) {
    expect(
      await resolveSelectedTerminal({
        scope,
        selection,
        execute: async (command) => success(command, [candidate, record()]),
      })
    ).toMatchObject({ status: 'unavailable', reason: 'identity_mismatch' })
  }
})
