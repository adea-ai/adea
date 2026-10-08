import { describe, expect, test } from 'bun:test'
import type {
  DevCommand,
  DevReply,
  PaneLeaf,
  Scope,
  TerminalRecord,
} from '@adea-ai/types/dev-runtime'

import {
  TERMINAL_PLACEHOLDER_PREFIX,
  createSessionTerminal,
  isTerminalPlaceholderLeaf,
  replaceLeaf,
  terminateSessionTerminal,
  terminatesOnLastClose,
} from '../src/terminal/terminal-close'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const session = '00000000-0000-4000-8000-000000000004'
const worktree = '00000000-0000-4000-8000-000000000005'
const primary = '00000000-0000-4000-8000-000000000006'
const other = '00000000-0000-4000-8000-000000000007'

function terminalLeaf(overrides: Partial<PaneLeaf> = {}): PaneLeaf {
  return { kind: 'leaf', id: 'dev-terminal', pane: 'terminal', ...overrides }
}
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
function success(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    observedAt: '2026-10-07T20:00:00.000Z',
    value,
  }
}
function failure(command: DevCommand, code = 'unavailable'): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: false,
    error: { code, retryable: false, message: 'denied', observedAt: '2026-10-07T20:00:00.000Z' },
  } as DevReply
}

const decision = (closedLeaf: PaneLeaf, overrides: { leafCountBefore?: number } = {}) =>
  terminatesOnLastClose({
    leafCountBefore: overrides.leafCountBefore ?? 1,
    closedLeaf,
    primaryTerminalId: primary,
  })

describe('terminatesOnLastClose', () => {
  test('terminates when the last leaf bound the primary, explicitly or as the first unbound leaf', () => {
    expect(decision(terminalLeaf({ resourceId: primary }))).toBe(true)
    expect(decision(terminalLeaf({ resourceId: undefined }))).toBe(true)
  })

  test('never terminates while another leaf remains in the center', () => {
    expect(decision(terminalLeaf({ resourceId: primary }), { leafCountBefore: 2 })).toBe(false)
  })

  test('never terminates a leaf bound to a split terminal that is not the primary', () => {
    expect(decision(terminalLeaf({ resourceId: other }))).toBe(false)
  })

  test('never terminates without a projected primary or on an editor leaf', () => {
    expect(
      terminatesOnLastClose({
        leafCountBefore: 1,
        closedLeaf: terminalLeaf(),
        primaryTerminalId: undefined,
      })
    ).toBe(false)
    expect(
      decision({ kind: 'leaf', id: 'dev-editor-1', pane: 'editor', resourceId: primary })
    ).toBe(false)
  })
})

describe('isTerminalPlaceholderLeaf', () => {
  test('matches only terminal leaves carrying the close placeholder prefix', () => {
    expect(isTerminalPlaceholderLeaf(terminalLeaf({ id: `${TERMINAL_PLACEHOLDER_PREFIX}1` }))).toBe(
      true
    )
    expect(isTerminalPlaceholderLeaf(terminalLeaf({ id: 'dev-terminal' }))).toBe(false)
    expect(
      isTerminalPlaceholderLeaf({
        kind: 'leaf',
        id: `${TERMINAL_PLACEHOLDER_PREFIX}1`,
        pane: 'editor',
      })
    ).toBe(false)
  })
})

describe('terminateSessionTerminal', () => {
  test('revalidates the record then issues the privileged terminate with its generation', async () => {
    const commands: DevCommand[] = []
    const freed = await terminateSessionTerminal({
      scope,
      runtimeSessionId: session,
      worktreeId: worktree,
      terminalId: primary,
      execute: async (command) => {
        commands.push(command)
        return commands.length === 1
          ? success(command, { items: [record()], observedAt: '2026-10-07T20:00:00.000Z' })
          : success(command, record({ state: 'terminating' }))
      },
    })
    expect(freed).toBe(true)
    expect(commands.map((command) => command.operation)).toEqual([
      'dev.terminal.list',
      'dev.terminal.terminate',
    ])
    const terminate = commands[1]!
    expect(terminate.body).toEqual({
      terminalId: primary,
      expectedGeneration: 12,
      confirmationId: `close-${primary}-12`,
    })
    expect(terminate.resource).toEqual({ kind: 'terminal', id: primary, generation: 12 })
    expect(terminate.capabilities).toEqual(['dev.terminal.manage'])
  })

  test('issues nothing when the terminal record can no longer be verified', async () => {
    const commands: DevCommand[] = []
    const freed = await terminateSessionTerminal({
      scope,
      runtimeSessionId: session,
      worktreeId: worktree,
      terminalId: primary,
      execute: async (command) => {
        commands.push(command)
        return success(command, { items: [], observedAt: '2026-10-07T20:00:00.000Z' })
      },
    })
    expect(freed).toBe(false)
    expect(commands.map((command) => command.operation)).toEqual(['dev.terminal.list'])
  })

  test('reports the host refusal instead of throwing', async () => {
    const freed = await terminateSessionTerminal({
      scope,
      runtimeSessionId: session,
      worktreeId: worktree,
      terminalId: primary,
      execute: async (command) =>
        command.operation === 'dev.terminal.terminate'
          ? failure(command, 'permission_denied')
          : success(command, { items: [record()], observedAt: '2026-10-07T20:00:00.000Z' }),
    })
    expect(freed).toBe(false)
  })
})

describe('createSessionTerminal', () => {
  test('creates one instance in the selected session worktree and returns its record', async () => {
    const commands: DevCommand[] = []
    const created = await createSessionTerminal({
      scope,
      runtimeSessionId: session,
      worktreeId: worktree,
      execute: async (command) => {
        commands.push(command)
        return success(command, record({ id: other, generation: 3, state: 'running' }))
      },
    })
    expect(created).toEqual({ status: 'ready', terminal: record({ id: other, generation: 3 }) })
    const command = commands[0]!
    expect(command.operation).toBe('dev.terminal.create')
    expect(command.body).toEqual({
      runtimeSessionId: session,
      worktreeId: worktree,
      cols: 80,
      rows: 24,
    })
    expect(command.capabilities).toEqual(['dev.terminal.manage'])
    expect(command.resource).toBeUndefined()
  })

  test('fails closed on a refusal, a malformed record, or a thrown transport', async () => {
    const refusal = await createSessionTerminal({
      scope,
      runtimeSessionId: session,
      worktreeId: worktree,
      execute: async (command) => failure(command),
    })
    expect(refusal).toEqual({ status: 'unavailable', reason: 'unavailable' })
    const malformed = await createSessionTerminal({
      scope,
      runtimeSessionId: session,
      worktreeId: worktree,
      execute: async (command) => success(command, { id: '', generation: 1 }),
    })
    expect(malformed).toEqual({ status: 'unavailable', reason: 'incompatible' })
    const thrown = await createSessionTerminal({
      scope,
      runtimeSessionId: session,
      worktreeId: worktree,
      execute: async () => {
        throw new Error('transport down')
      },
    })
    expect(thrown).toEqual({ status: 'unavailable', reason: 'unavailable' })
  })
})

describe('replaceLeaf', () => {
  test('swaps one leaf and keeps every other node untouched', () => {
    const survivor = terminalLeaf({ id: 'survivor', resourceId: other })
    const center = {
      kind: 'split',
      id: 'split-1',
      direction: 'row',
      ratio: 0.4,
      children: [
        terminalLeaf({ id: 'gone' }),
        {
          kind: 'split',
          id: 'split-2',
          direction: 'column',
          ratio: 0.7,
          children: [survivor, terminalLeaf({ id: 'gone-2' })],
        },
      ],
    } as const
    const next = replaceLeaf(center, 'gone-2', terminalLeaf({ id: 'fresh', resourceId: primary }))
    expect(next).toEqual({
      kind: 'split',
      id: 'split-1',
      direction: 'row',
      ratio: 0.4,
      children: [
        terminalLeaf({ id: 'gone' }),
        {
          kind: 'split',
          id: 'split-2',
          direction: 'column',
          ratio: 0.7,
          children: [survivor, terminalLeaf({ id: 'fresh', resourceId: primary })],
        },
      ],
    })
  })

  test('leaves the tree unchanged when the id is absent', () => {
    const center = terminalLeaf()
    expect(replaceLeaf(center, 'missing', terminalLeaf({ id: 'fresh' }))).toBe(center)
  })
})
