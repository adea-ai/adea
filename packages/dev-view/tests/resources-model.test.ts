// #424 resources pane models: ownership-gated process rows, typed usage
// cards, retained-data grouping, and explicit-unknown metric summaries.
import { describe, expect, test } from 'bun:test'

import type {
  ProcessRecord,
  ResourceMetric,
  RetainedDataRecord,
  UsageRecord,
} from '@adea-ai/types/dev-runtime'

import {
  formatBytes,
  isStoppableProcess,
  metricSummary,
  processRows,
  retainedGroups,
  usageCards,
} from '../src/resources/resources-model'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function record(overrides: Partial<RetainedDataRecord>): RetainedDataRecord {
  return {
    id: 'r',
    ownerId: 'wt-1',
    kind: 'terminal',
    byteLength: '10',
    protected: false,
    observedAt: '2026-09-19T00:00:00Z',
    ...overrides,
  }
}

function point(overrides: Partial<ResourceMetric>): ResourceMetric {
  return {
    ownerId: 'p1',
    observedAt: '2026-09-19T00:00:00Z',
    confidence: 'measured',
    ...overrides,
  }
}

function process(overrides: Partial<ProcessRecord>): ProcessRecord {
  return {
    id: 'record-1',
    scope: SCOPE,
    ownerKind: 'terminal',
    ownerId: 'term-1',
    pid: 4100,
    startIdentity: 'start-1',
    executableIdentity: '/exe/a',
    generation: 1,
    state: 'running',
    ...overrides,
  }
}

describe('process rows', () => {
  test('only a proven running launch record is stoppable', () => {
    expect(isStoppableProcess(process({}))).toBe(true)
    expect(isStoppableProcess(process({ state: 'unknown' }))).toBe(false)
    expect(isStoppableProcess(process({ state: 'exited' }))).toBe(false)
    expect(isStoppableProcess(process({ state: 'stopping' }))).toBe(false)
  })

  test('stoppable rows sort first and carry truthful state labels', () => {
    const rows = processRows([
      process({ id: 'a', state: 'unknown' }),
      process({ id: 'b', state: 'running' }),
      process({ id: 'c', state: 'exited' }),
    ])
    expect(rows.map((row) => row.record.id)).toEqual(['b', 'a', 'c'])
    expect(rows.find((row) => row.record.id === 'a')?.stateLabel).toBe('Identity unproven')
  })
})

describe('usage cards', () => {
  const base: UsageRecord = {
    id: 'u1',
    ownerId: 'usage:claude',
    provider: 'claude',
    quantity: '1200',
    unit: 'requests',
    source: 'official_api',
    confidence: 'authoritative',
    observedAt: '2026-09-19T00:00:00Z',
  }

  test('keeps the newest record per provider and flags declared staleness', () => {
    const cards = usageCards(
      [
        base,
        { ...base, id: 'u0', quantity: '1', observedAt: '2026-09-18T00:00:00Z' },
        {
          ...base,
          id: 'u2',
          provider: 'codex',
          quantity: 'unknown',
          unit: 'unknown',
          source: 'official_api',
          confidence: 'estimated',
          failure: { code: 'rate_limited', message: 'slow down' },
          expiresAt: '2026-09-19T01:00:00Z',
          observedAt: '2026-09-19T00:30:00Z',
        },
      ],
      Date.parse('2026-09-19T02:00:00Z')
    )
    expect(cards).toHaveLength(2)
    const claude = cards.find((card) => card.provider === 'claude')!
    expect(claude.quantity).toBe('1200')
    expect(claude.stale).toBe(false)
    const codex = cards.find((card) => card.provider === 'codex')!
    expect(codex.quantityIsUnknown).toBe(true)
    expect(codex.failure).toMatchObject({ code: 'rate_limited' })
    expect(codex.stale).toBe(true)
  })

  test('estimate rows keep their source label so they never read as billing truth', () => {
    const [card] = usageCards(
      [{ ...base, source: 'local_transcript_estimate', confidence: 'estimated' }],
      0
    )
    expect(card?.sourceLabel).toBe('Local estimate (not billing truth)')
  })
})

describe('retained data and metrics', () => {
  test('groups retained bytes by kind and surfaces protected bytes', () => {
    const groups = retainedGroups([
      record({ id: '1', byteLength: '100', protected: true }),
      record({ id: '2', kind: 'checkpoint', byteLength: '50' }),
      record({ id: '3', byteLength: '24' }),
    ])
    expect(groups[0]).toMatchObject({
      kind: 'terminal',
      totalBytes: 124,
      protectedBytes: 100,
      count: 2,
    })
    expect(groups[1]).toMatchObject({ kind: 'checkpoint', totalBytes: 50 })
  })

  test('metric summaries keep unknowns absent instead of zero', () => {
    const empty = metricSummary([point({ observedAt: '2026-09-19T00:00:01Z' })])
    expect(empty.cpuPercent).toBeUndefined()
    expect(empty.residentBytes).toBeUndefined()
    expect(empty.sampleCount).toBe(1)
    const full = metricSummary([
      point({ cpuPercent: 12.5, residentBytes: '2048' }),
      point({ cpuPercent: 20, residentBytes: '4096', observedAt: '2026-09-19T00:00:05Z' }),
    ])
    expect(full.cpuPercent).toBe(20)
    expect(full.residentBytes).toBe('4096')
    expect(full.lastObservedAt).toBe('2026-09-19T00:00:05Z')
  })

  test('formatBytes renders explicit unknown and unit scaling', () => {
    expect(formatBytes(Number.NaN)).toBe('unknown')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB')
  })
})
