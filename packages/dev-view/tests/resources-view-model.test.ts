import { describe, expect, test } from 'bun:test'

import type {
  ForeignProcessRecord,
  PortRecord,
  ProcessRecord,
  ResourceMetric,
  ResourceSnapshot,
  Worktree,
} from '@adea-ai/types/dev-runtime'

import {
  attentionSummary,
  barSegments,
  cleanupCandidates,
  FALLBACK_PREFERENCES,
  formatSize,
  isResourcePreferences,
  leakState,
  memoryBreakdown,
  serverGroups,
  sparklinePoints,
  storageRows,
  storageTotals,
} from '../src/resources/resources-view-model'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const MiB = 1024 * 1024
const GiB = 1024 * MiB
const alerts = FALLBACK_PREFERENCES.alerts

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    scope,
    kind: 'managed',
    repoId: 'repo-1',
    projectId: 'project-1',
    canonicalRoot: `/code/${id}`,
    rootIdentity: { mtimeNs: '1', size: '1' },
    provenance: 'adea',
    branchRef: `refs/heads/${id}`,
    lifecycle: 'ready',
    bootstrap: 'completed',
    archived: false,
    generation: 1,
    version: 1,
    ...overrides,
  } as Worktree
}

function process(id: string, overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id,
    scope,
    ownerKind: 'server',
    ownerId: id,
    pid: 4000,
    startIdentity: 'start',
    executableIdentity: '/bin/node',
    generation: 1,
    state: 'running',
    ...overrides,
  }
}

function metric(processRecordId: string, at: number, bytes: number, cpu?: number): ResourceMetric {
  return {
    ownerId: processRecordId,
    processRecordId,
    generation: 1,
    residentBytes: String(bytes),
    ...(cpu !== undefined ? { cpuPercent: cpu } : {}),
    observedAt: new Date(at).toISOString(),
    confidence: 'measured',
  }
}

function foreign(id: string, overrides: Partial<ForeignProcessRecord> = {}): ForeignProcessRecord {
  return {
    id,
    observationGeneration: 1,
    pid: 9000,
    startIdentity: 'Tue Oct 6 09:14:03 2026',
    executableIdentity: '/opt/homebrew/bin/node',
    label: 'node',
    attribution: { kind: 'unknown' },
    listeningPorts: [],
    childCount: 0,
    residentBytes: String(100 * MiB),
    residentHistory: [String(100 * MiB)],
    protection: 'none',
    stoppable: true,
    observedAt: new Date(600_000).toISOString(),
    ...overrides,
  }
}

function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    processes: [],
    ports: [],
    metrics: [],
    retainedData: [],
    observedAt: new Date(600_000).toISOString(),
    ...overrides,
  }
}

describe('leak detection', () => {
  test('growth over the window marks a server as leaking', () => {
    const points = [
      { at: 0, bytes: 1 * GiB },
      { at: 300_000, bytes: 1.3 * GiB },
      { at: 600_000, bytes: 1.6 * GiB },
    ]
    const state = leakState(points, alerts)
    expect(state.kind).toBe('growing')
    expect(state.growthBytes).toBeCloseTo(0.6 * GiB, 0)
  })

  test('a server over the limit without growth is over_limit; a quiet one is normal', () => {
    expect(leakState([{ at: 0, bytes: 3 * GiB }], alerts).kind).toBe('over_limit')
    expect(
      leakState(
        [
          { at: 0, bytes: 200 * MiB },
          { at: 1000, bytes: 210 * MiB },
        ],
        alerts
      ).kind
    ).toBe('normal')
    expect(leakState([], alerts).kind).toBe('normal')
  })
})

describe('server groups', () => {
  test('groups Adea servers by worktree and foreign rows by where they run', () => {
    const port: PortRecord = {
      id: 'port-1',
      scope,
      protocol: 'tcp',
      host: 'localhost',
      port: 3000,
      owner: 'adea',
      processRecordId: 'p-web',
      preview: { browserLaneId: 'lane-1', url: 'http://localhost:3000' },
      state: 'observed',
      observedAt: new Date(0).toISOString(),
    }
    const groups = serverGroups({
      snapshot: snapshot({
        processes: [
          process('p-web', { worktreeId: 'wt-main' }),
          process('p-orphan', { worktreeId: 'wt-gone', pid: 4001 }),
          process('p-exited', { state: 'exited' }),
        ],
        ports: [port],
        metrics: [metric('p-web', 0, 500 * MiB, 3), metric('p-web', 2000, 510 * MiB, 4)],
        foreign: [
          foreign('f-term', {
            worktreeId: 'wt-main',
            attribution: { kind: 'adea_terminal' },
            listeningPorts: [5173],
          }),
          foreign('f-claude', {
            attribution: { kind: 'harness', harness: 'Claude Code' },
            listeningPorts: [4000],
          }),
          foreign('f-pg', { protection: 'protected_list', stoppable: false, label: 'postgres' }),
        ],
      }),
      worktrees: [worktree('wt-main')],
      alerts,
    })
    expect(groups.map((group) => group.kind)).toEqual([
      'worktree',
      'missing_worktree',
      'elsewhere',
      'protected',
    ])
    const main = groups[0]!
    expect(main.title).toBe('wt-main')
    expect(main.rows.map((row) => row.id).toSorted()).toEqual(['f-term', 'p-web'])
    const web = main.rows.find((row) => row.id === 'p-web')!
    expect(web).toMatchObject({
      kind: 'owned',
      residentBytes: 510 * MiB,
      cpuPercent: 4,
      stoppable: true,
    })
    expect(web.kind === 'owned' && web.previewUrl).toBe('http://localhost:3000')
    // Exited launches are not listed as running servers.
    expect(groups.flatMap((group) => group.rows).some((row) => row.id === 'p-exited')).toBe(false)
    expect(groups[2]!.rows[0]).toMatchObject({ id: 'f-claude', attributionLabel: 'Claude Code' })
    expect(groups[3]!.rows[0]).toMatchObject({ id: 'f-pg', stoppable: false })
  })

  test('an Adea port without a process id joins the process of its session', () => {
    const groups = serverGroups({
      snapshot: snapshot({
        processes: [process('p-browser', { ownerKind: 'browser', runtimeSessionId: 'session-1' })],
        ports: [
          {
            id: 'port-1',
            scope,
            protocol: 'tcp',
            host: 'localhost',
            port: 5173,
            owner: 'adea',
            runtimeSessionId: 'session-1',
            state: 'observed',
            observedAt: new Date(0).toISOString(),
          },
        ],
      }),
      worktrees: [],
      alerts,
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.kind).toBe('adea')
    expect(groups[0]!.rows[0]!.ports).toHaveLength(1)
  })

  test('unknown memory stays unknown, never zero', () => {
    const groups = serverGroups({
      snapshot: snapshot({ processes: [process('p-1')] }),
      worktrees: [],
      alerts,
    })
    expect(groups[0]!.rows[0]!.residentBytes).toBeUndefined()
    expect(groups[0]!.totalBytes).toBeUndefined()
    expect(formatSize(undefined)).toBe('—')
  })
})

describe('memory breakdown', () => {
  test('splits Adea, listed rows elsewhere, other apps, and free', () => {
    const groups = serverGroups({
      snapshot: snapshot({
        processes: [process('p-1')],
        metrics: [metric('p-1', 0, 1 * GiB)],
        foreign: [
          foreign('f-term', {
            attribution: { kind: 'adea_terminal' },
            residentBytes: String(1 * GiB),
          }),
          foreign('f-else', { residentBytes: String(2 * GiB) }),
        ],
      }),
      worktrees: [],
      alerts,
    })
    const breakdown = memoryBreakdown(groups, {
      memoryTotalBytes: String(32 * GiB),
      memoryUsedBytes: String(12 * GiB),
      observedAt: new Date(0).toISOString(),
    })
    expect(breakdown).toEqual({
      adeaBytes: 2 * GiB,
      elsewhereBytes: 2 * GiB,
      otherBytes: 8 * GiB,
      freeBytes: 20 * GiB,
      totalBytes: 32 * GiB,
      usedBytes: 12 * GiB,
    })
    expect(memoryBreakdown([], undefined)).toEqual({})
  })

  test('bar segments are proportional and empty input draws nothing', () => {
    expect(barSegments([1, 3])).toEqual([25, 75])
    expect(barSegments([undefined, 0])).toEqual([0, 0])
  })
})

describe('storage rows', () => {
  test('sorts by size, badges state, and keeps unmeasured sizes unknown', () => {
    const rows = storageRows(
      [
        worktree('small'),
        worktree('big', { archived: true }),
        worktree('pending', { kind: 'primary' }),
      ],
      [
        { worktreeId: 'small', state: 'measured', sourceBytes: '10', buildBytes: '0' },
        {
          worktreeId: 'big',
          state: 'measured',
          sourceBytes: String(GiB),
          buildBytes: String(2 * GiB),
        },
        { worktreeId: 'pending', state: 'measuring' },
      ]
    )
    expect(rows.map((row) => row.worktree.id)).toEqual(['big', 'small', 'pending'])
    expect(rows[0]!.totalBytes).toBe(3 * GiB)
    expect(rows[0]!.badges.map((badge) => badge.label)).toContain('Archived')
    expect(rows[2]!.totalBytes).toBeUndefined()
    const totals = storageTotals(rows, [
      {
        id: 'r',
        ownerId: 'o',
        kind: 'screenshot',
        byteLength: '100',
        protected: false,
        observedAt: new Date(0).toISOString(),
      },
    ])
    expect(totals).toMatchObject({ buildBytes: 2 * GiB, retainedBytes: 100, partial: true })
  })
})

describe('clean-up candidates', () => {
  test('pre-selects orphaned Adea servers and archived Adea worktrees only', () => {
    const groups = serverGroups({
      snapshot: snapshot({
        processes: [
          process('p-orphan', { worktreeId: 'wt-gone' }),
          process('p-leak', { worktreeId: 'wt-gone', pid: 4002 }),
        ],
        metrics: [metric('p-leak', 0, 1 * GiB), metric('p-leak', 60_000, 2 * GiB)],
        foreign: [foreign('f-port', { listeningPorts: [4000] }), foreign('f-quiet')],
      }),
      worktrees: [],
      alerts,
    })
    const worktrees = [
      worktree('wt-archived', { archived: true }),
      worktree('wt-active'),
      worktree('wt-external', { archived: true, provenance: 'external', kind: 'external' }),
    ]
    const candidates = cleanupCandidates({
      groups,
      worktrees,
      storage: storageRows(worktrees, []),
      preferences: FALLBACK_PREFERENCES,
    })
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    expect(byId.get('p-orphan')?.preselected).toBe(true)
    // A leaking server is listed but never pre-selected.
    expect(byId.get('p-leak')?.preselected).toBe(false)
    expect(byId.get('wt-archived')?.preselected).toBe(true)
    expect(byId.has('wt-active')).toBe(false)
    expect(byId.has('wt-external')).toBe(false)
    // Foreign rows holding a port are listed, never pre-selected; quiet ones are not listed.
    expect(byId.get('f-port')).toMatchObject({ kind: 'foreign', preselected: false })
    expect(byId.has('f-quiet')).toBe(false)

    const summary = attentionSummary(candidates, groups)
    expect(summary.count).toBe(2)
    expect(summary.leaking.map((row) => row.id)).toEqual(['p-leak'])
  })

  test('an idle server needs CPU history covering the idle window', () => {
    const quiet = [0, 1, 2, 3, 4].map((minute) => metric('p-1', minute * 60_000, 100 * MiB, 0.1))
    const prefs = {
      ...FALLBACK_PREFERENCES,
      cleanup: { ...FALLBACK_PREFERENCES.cleanup, serverIdleSeconds: 240 },
    }
    const groups = serverGroups({
      snapshot: snapshot({ processes: [process('p-1')], metrics: quiet }),
      worktrees: [],
      alerts,
    })
    expect(
      cleanupCandidates({ groups, worktrees: [], storage: [], preferences: prefs })[0]
    ).toMatchObject({
      kind: 'server',
      reason: 'Idle',
      preselected: true,
    })
    const longer = { ...prefs, cleanup: { ...prefs.cleanup, serverIdleSeconds: 3600 } }
    expect(cleanupCandidates({ groups, worktrees: [], storage: [], preferences: longer })).toEqual(
      []
    )
  })
})

describe('helpers', () => {
  test('preference replies are recognised only when complete', () => {
    expect(isResourcePreferences({})).toBe(false)
    expect(
      isResourcePreferences({
        ...FALLBACK_PREFERENCES,
        version: 0,
        updatedAt: new Date(0).toISOString(),
      })
    ).toBe(true)
  })

  test('sparkline points span the box', () => {
    expect(sparklinePoints([0, 10], 72, 20)).toBe('0.0,19.0 72.0,1.0')
    expect(sparklinePoints([], 72, 20)).toBe('')
  })
})
