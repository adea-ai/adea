import { describe, expect, test } from 'bun:test'

import {
  decodeDevCommand,
  decodeDevReply,
  devOperationDecoders,
  type DevOperation,
  type ForeignProcessRecord,
  type ResourcePreferences,
} from '../src/dev-runtime'

/** Decodes a success value through the full reply envelope, the way the
 * transport does. */
function replyDecoder(operation: DevOperation) {
  return (value: unknown) => {
    const reply = decodeDevReply({
      schemaVersion: 1,
      operation,
      requestId: '00000000-0000-4000-8000-000000000002',
      ok: true,
      value,
      observedAt: '2026-10-06T09:20:00.000Z',
    })
    return reply.ok ? reply.value : undefined
  }
}

const scope = {
  accountId: '00000000-0000-4000-8000-0000000000a1',
  workspaceId: '00000000-0000-4000-8000-0000000000b1',
  runtimeNodeId: '00000000-0000-4000-8000-0000000000c1',
}

const foreign: ForeignProcessRecord = {
  id: 'foreign-1',
  observationGeneration: 3,
  pid: 51_822,
  startIdentity: 'Tue Oct  6 09:14:03 2026',
  executableIdentity: '/opt/homebrew/bin/node',
  label: 'node',
  commandPreview: 'node ~/code/side-project/node_modules/.bin/next dev -p 4000',
  cwdLabel: '~/code/side-project',
  attribution: { kind: 'harness', harness: 'Claude Code' },
  listeningPorts: [4000],
  childCount: 2,
  residentBytes: '859832320',
  cpuPercent: 1.5,
  residentHistory: ['800000000', '859832320'],
  protection: 'none',
  stoppable: true,
  observedAt: '2026-10-06T09:20:00.000Z',
}

const preferences: ResourcePreferences = {
  coverage: 'machine',
  includeAutomationApps: true,
  recognizedHarnesses: ['Claude Code', 'Codex'],
  portRange: { from: 1024, to: 65_535 },
  alerts: {
    residentBytesAbove: '2147483648',
    growthBytes: '524288000',
    growthWindowSeconds: 600,
    notify: 'badge',
    snoozeSeconds: 3600,
  },
  cleanup: {
    mode: 'ask',
    serverIdleSeconds: 14_400,
    suggestMergedWorktreesAfterSeconds: 259_200,
    quarantineRetentionSeconds: 604_800,
    retainedDataRetentionSeconds: 1_209_600,
  },
  protectedExecutables: ['postgres', 'com.docker.*'],
  sampling: { visibleSeconds: 2, backgroundSeconds: 60 },
  version: 4,
  updatedAt: '2026-10-06T09:20:00.000Z',
}

function snapshotWith(extra: Record<string, unknown>) {
  return {
    processes: [],
    ports: [],
    metrics: [],
    retainedData: [],
    observedAt: '2026-10-06T09:20:00.000Z',
    ...extra,
  }
}

describe('machine-wide resource DTOs', () => {
  test('a snapshot carries foreign processes and the machine summary only additively', () => {
    const decode = replyDecoder('dev.resources.snapshot')
    expect(decode(snapshotWith({}))).toEqual(snapshotWith({}))
    const machine = {
      memoryTotalBytes: '34359738368',
      memoryUsedBytes: '12670066688',
      cpuPercent: 18,
      diskFreeBytes: '227633266688',
      diskTotalBytes: '1000000000000',
      observedAt: '2026-10-06T09:20:00.000Z',
    }
    const full = snapshotWith({ foreign: [foreign], machine })
    expect(decode(full)).toEqual(full)
  })

  test('a protected foreign process can never be marked stoppable', () => {
    const decode = replyDecoder('dev.resources.snapshot')
    expect(() =>
      decode(snapshotWith({ foreign: [{ ...foreign, protection: 'system', stoppable: true }] }))
    ).toThrow('never stoppable')
    expect(
      decode(snapshotWith({ foreign: [{ ...foreign, protection: 'system', stoppable: false }] }))
    ).toBeDefined()
  })

  test('byte counts are decimal strings and unknown values stay absent', () => {
    const decode = replyDecoder('dev.resources.snapshot')
    expect(() => decode(snapshotWith({ foreign: [{ ...foreign, residentBytes: '-1' }] }))).toThrow(
      'decimal byte count'
    )
    expect(() =>
      decode(snapshotWith({ foreign: [{ ...foreign, residentHistory: ['1.5'] }] }))
    ).toThrow('decimal byte count')
    const { residentBytes: _bytes, cpuPercent: _cpu, ...unknown } = foreign
    expect(decode(snapshotWith({ foreign: [unknown] }))).toBeDefined()
  })

  test('attribution variants are exact', () => {
    const decode = replyDecoder('dev.resources.snapshot')
    for (const attribution of [
      { kind: 'automation', label: 'Chrome for Testing' },
      { kind: 'adea_terminal' },
      { kind: 'unknown' },
    ]) {
      expect(decode(snapshotWith({ foreign: [{ ...foreign, attribution }] }))).toBeDefined()
    }
    expect(() =>
      decode(snapshotWith({ foreign: [{ ...foreign, attribution: { kind: 'unknown', x: 1 } }] }))
    ).toThrow('unknown key')
  })

  test('foreign stop plans bind the foreign_process resource and accept an explicit force', () => {
    const command = {
      schemaVersion: 1,
      operation: 'dev.resources.foreignStopPlan',
      requestId: '00000000-0000-4000-8000-000000000001',
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      issuedAt: '2026-10-06T09:20:00.000Z',
      expiresAt: '2026-10-06T09:20:30.000Z',
      scope,
      capabilities: ['dev.resources.stopForeign'],
      resource: { kind: 'foreign_process', id: 'foreign-1', generation: 3 },
      body: {
        foreignProcessId: 'foreign-1',
        expectedGeneration: 3,
        force: false,
        reason: 'Stop next dev on 4000',
      },
    }
    expect(decodeDevCommand(command)).toEqual(command)
    expect(() =>
      decodeDevCommand({ ...command, resource: { ...command.resource, kind: 'process' } })
    ).toThrow('expected foreign_process')
    expect(() => decodeDevCommand({ ...command, capabilities: ['dev.resources.stop'] })).toThrow(
      'registry capabilities'
    )
  })

  test('the foreign stop result reports exactly which PIDs were signalled', () => {
    const decode = replyDecoder('dev.resources.foreignStopCommit')
    const result = {
      foreignProcessId: 'foreign-1',
      outcome: 'stopped',
      signalledPids: [51_830, 51_822],
      observedAt: '2026-10-06T09:20:05.000Z',
    }
    expect(decode(result)).toEqual(result)
    expect(() => decode({ ...result, outcome: 'killed' })).toThrow()
  })

  test('preferences decode stored and input shapes strictly', () => {
    expect(replyDecoder('dev.resources.preferences')(preferences)).toEqual(preferences)
    const { version: _version, updatedAt: _updatedAt, ...input } = preferences
    expect(
      devOperationDecoders['dev.resources.preferencesUpdate'].request({
        expectedVersion: 4,
        preferences: input,
      })
    ).toBeDefined()
    // The stored revision belongs to the host: an input carrying it is refused.
    expect(() =>
      devOperationDecoders['dev.resources.preferencesUpdate'].request({
        expectedVersion: 4,
        preferences,
      })
    ).toThrow('unknown key')
    expect(() =>
      devOperationDecoders['dev.resources.preferencesUpdate'].request({
        expectedVersion: 4,
        preferences: { ...input, protectedExecutables: ['/usr/bin/evil'] },
      })
    ).toThrow('path separators')
    expect(() =>
      devOperationDecoders['dev.resources.preferencesUpdate'].request({
        expectedVersion: 4,
        preferences: { ...input, coverage: 'everything' },
      })
    ).toThrow()
  })

  test('worktree storage pages carry explicit measurement state', () => {
    const decode = replyDecoder('dev.resources.worktreeStorage')
    const value = {
      items: [
        {
          worktreeId: 'wt-1',
          sourceBytes: '5200000000',
          buildBytes: '6400000000',
          state: 'measured',
          measuredAt: '2026-10-06T09:20:00.000Z',
        },
        { worktreeId: 'wt-2', state: 'unreadable' },
      ],
      observedAt: '2026-10-06T09:20:00.000Z',
    }
    expect(decode(value)).toEqual(value)
  })
})
