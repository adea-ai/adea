// #424 resource-seam adapters, focused host tests: the bounded `ps` process
// sampler, the read-only retained-data projection (terminal checkpoints,
// browser screenshot retention, dependency-template records), and the
// cleanup-policy worktree-facts adapter over the worktree service's durable
// records, leases, and read-only git observation.
//
// The truthfulness bar under test: every adapter reports only what its
// source actually proved — a vanished PID, an unreadable store, or a failed
// git command leaves that fact absent (never a fabricated zero), and the
// cleanup-policy predicates fail closed over absent facts.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Scope, ScreenshotRef } from '../../../packages/types/src/dev-runtime'
import {
  createProcessSampler,
  parseCpuSeconds,
  SAMPLE_MAX_PIDS,
} from '../shell/src/dev-runtime/resources/sample-processes'
import { createRetainedDataProjection } from '../shell/src/dev-runtime/resources/retained-data'
import { createCleanupWorktreeFacts } from '../shell/src/dev-runtime/resources/cleanup-facts'
import { evaluatePredicates } from '../shell/src/dev-runtime/resources/policy'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const TERMINAL_ID = 'a0000000-0000-4000-8000-000000000001'
const NOT_A_TERMINAL_ID = '../escape'

function screenshotRef(overrides: Partial<ScreenshotRef> = {}): ScreenshotRef {
  return {
    id: 'shot-1',
    scope: SCOPE,
    ownerId: 'lane-session-1',
    laneKind: 'task_owned',
    origin: 'http://127.0.0.1:3000',
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    redacted: true,
    contentType: 'image/png',
    byteLength: '2048',
    width: 800,
    height: 600,
    sha256: 'b'.repeat(64),
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('process sampler', () => {
  test('parses one ps observation into cumulative cpu seconds and rss bytes', async () => {
    const calls: string[][] = []
    const sampler = createProcessSampler({
      runPs: async (args) => {
        calls.push([...args])
        return {
          exitCode: 0,
          // `time=` on darwin carries a fractional tail; rss is KiB on both
          // darwin and Linux.
          stdout: '4711 0:02.50 4096\n4712 1-02:03:04 8\n',
          stderr: '',
        }
      },
    })
    const samples = await sampler([4711, 4712])
    expect(calls).toEqual([['-o', 'pid=,time=,rss=', '-p', '4711,4712']])
    expect(samples).toEqual([
      { pid: 4711, cpuSeconds: 2.5, residentBytes: 4 * 1024 * 1024 },
      { pid: 4712, cpuSeconds: 86_400 + 2 * 3600 + 3 * 60 + 4, residentBytes: 8 * 1024 },
    ])
  })

  test('absent pids, unparseable rows, and failed runs stay absent (never zero)', async () => {
    const sampler = createProcessSampler({
      runPs: async () => ({
        // 9999 died between listing and sampling (ps printed no row); the
        // 4713 row is garbage.
        exitCode: 1,
        stdout: '4711 0:00.10 100\n4713 not-a-time x\n',
        stderr: '',
      }),
    })
    const samples = await sampler([4711, 4713, 9999])
    expect(samples).toEqual([{ pid: 4711, cpuSeconds: 0.1, residentBytes: 100 * 1024 }])

    const failed = createProcessSampler({
      runPs: async () => {
        throw new Error('ps vanished')
      },
    })
    expect(await failed([4711])).toEqual([])
  })

  test('dedupes pids and bounds the observation', async () => {
    const calls: string[][] = []
    const sampler = createProcessSampler({
      maxPids: 2,
      runPs: async (args) => {
        calls.push([...args])
        return { exitCode: 0, stdout: '1 0:00.01 1\n2 0:00.01 2\n3 0:00.01 3\n', stderr: '' }
      },
    })
    // Over the bound and duplicated: one bounded observation, deduped.
    const samples = await sampler([3, 1, 1, 2])
    expect(calls).toEqual([['-o', 'pid=,time=,rss=', '-p', '3,1']])
    expect(samples).toEqual([
      { pid: 3, cpuSeconds: 0.01, residentBytes: 3 * 1024 },
      { pid: 1, cpuSeconds: 0.01, residentBytes: 1 * 1024 },
    ])
    expect(SAMPLE_MAX_PIDS).toBe(64)
  })

  test('cpu-time parser handles the darwin and Linux display shapes', () => {
    expect(parseCpuSeconds('0:00')).toBe(0)
    expect(parseCpuSeconds('12:34')).toBe(754)
    expect(parseCpuSeconds('1:02:03')).toBe(3723)
    expect(parseCpuSeconds('0:02.50')).toBe(2.5)
    expect(parseCpuSeconds('2-03:04:05.11')).toBe(2 * 86_400 + 3 * 3600 + 4 * 60 + 5.11)
    expect(parseCpuSeconds('')).toBeUndefined()
    expect(parseCpuSeconds('soon')).toBeUndefined()
    expect(parseCpuSeconds('1:2:3:4')).toBeUndefined()
  })
})

describe('retained-data projection', () => {
  test('accounts terminal checkpoint segments under the runtime root', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retained-'))
    try {
      const sessionDir = join(root, TERMINAL_ID)
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(sessionDir, 'seg-1-0-9.adt'), Buffer.alloc(100))
      writeFileSync(join(sessionDir, 'seg-1-10-19.adt'), Buffer.alloc(50))
      writeFileSync(join(sessionDir, 'unrelated.txt'), Buffer.alloc(10))
      // A non-terminal directory is never reported.
      mkdirSync(join(root, NOT_A_TERMINAL_ID), { recursive: true })
      writeFileSync(join(root, NOT_A_TERMINAL_ID, 'seg-1-0-9.adt'), Buffer.alloc(9_999))
      const project = createRetainedDataProjection({
        scope: SCOPE,
        runtimeRoot: root,
        randomId: (() => {
          let n = 0
          return () => `id-${(n += 1)}`
        })(),
        now: () => 1_000,
      })
      const records = project()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        id: 'id-1',
        ownerId: TERMINAL_ID,
        kind: 'terminal',
        byteLength: '150',
        protected: true,
        observedAt: new Date(1_000).toISOString(),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('accounts screenshot retention and dependency-template records read-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retained-'))
    try {
      const templateRecordsPath = join(root, 'records.json')
      writeFileSync(
        templateRecordsPath,
        JSON.stringify({
          schemaVersion: 1,
          savedAt: '2026-09-20T00:00:00.000Z',
          records: [
            {
              projectId: 'proj-ready',
              state: 'ready',
              totalBytes: 4096,
              fileCount: 12,
            },
            // Building/failed templates hold no promoted bytes yet.
            { projectId: 'proj-building', state: 'building' },
          ],
        })
      )
      const project = createRetainedDataProjection({
        scope: SCOPE,
        screenshots: { list: () => [screenshotRef()] },
        templateRecordsPath,
        randomId: (() => {
          let n = 0
          return () => `id-${(n += 1)}`
        })(),
        now: () => 2_000,
      })
      const records = project()
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({
        ownerId: 'lane-session-1',
        kind: 'screenshot',
        byteLength: '2048',
        protected: false,
        expiresAt: '2026-12-01T00:00:00.000Z',
        scope: SCOPE,
        label: 'task_owned screenshot (image/png)',
      })
      expect(records[1]).toMatchObject({
        ownerId: 'proj-ready',
        kind: 'dependency_template',
        byteLength: '4096',
        protected: false,
        label: 'dependency template (12 files)',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an unreadable store contributes nothing and is never mutated', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-retained-'))
    try {
      const corrupt = join(root, 'corrupt.json')
      writeFileSync(corrupt, '{ this is not json')
      let throwingStore = true
      const project = createRetainedDataProjection({
        scope: SCOPE,
        runtimeRoot: join(root, 'missing-runtime-root'),
        screenshots: {
          list: () => {
            if (throwingStore) throw new Error('store closed')
            return [screenshotRef()]
          },
        },
        templateRecordsPath: corrupt,
        now: () => 3_000,
        randomId: () => 'id-x',
      })
      expect(project()).toEqual([])
      // Recovery of one source is visible on the next pull; the corrupt
      // template file was left exactly as it was (pure read).
      throwingStore = false
      expect(project()).toHaveLength(1)
      expect(Bun.file(corrupt).size > 0).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const RECORD = {
  id: 'wt-1',
  scope: SCOPE,
  projectId: 'proj-1',
  repoId: 'repo-1',
  name: 'wt-1',
  branchRef: 'refs/heads/feature',
  canonicalRoot: '/repo/wt-1',
  provenance: 'adea',
  lifecycle: 'ready',
  archived: false,
  updatedAt: '2026-09-20T00:00:00.000Z',
} as never

function fakeSource(options: {
  record?: ReturnType<typeof structuredClone>
  leaseStates?: string[]
  throwOnGet?: boolean
}) {
  return {
    getWorktree: (_scope: Scope, worktreeId: string) => {
      if (options.throwOnGet) throw new Error('store closed')
      if (!options.record || worktreeId !== 'wt-1') return undefined
      return options.record as never
    },
    leases: {
      list: (worktreeId: string) =>
        (options.leaseStates ?? []).map((state, index) => ({
          lease: { id: `lease-${index}`, worktreeId, state: 'active' },
          effectiveState: state,
          heartbeatAgeMs: 0,
        })),
    },
  }
}

function scriptedGit(rows: Record<string, { exitCode: number; stdout: string }>) {
  const calls: string[][] = []
  return {
    calls,
    runGit: (args: readonly string[]) => {
      calls.push([...args])
      const key = args.join(' ')
      const row = rows[key]
      return row ?? { exitCode: 1, stdout: '' }
    },
  }
}

describe('cleanup worktree facts', () => {
  test('unknown worktrees and unreadable stores return undefined (fail closed)', () => {
    const git = scriptedGit({})
    const facts = createCleanupWorktreeFacts({
      worktrees: fakeSource({ throwOnGet: true }),
      scope: SCOPE,
      runGit: git.runGit,
    })
    expect(facts('wt-1')).toBeUndefined()
    const absent = createCleanupWorktreeFacts({
      worktrees: fakeSource({}),
      scope: SCOPE,
      runGit: git.runGit,
    })
    expect(absent('wt-unknown')).toBeUndefined()
  })

  test('maps clean, pushed, lease, and archive facts onto the policy contract', () => {
    const git = scriptedGit({
      'status --porcelain': { exitCode: 0, stdout: '' },
      'rev-parse --verify --quiet feature@{upstream}': { exitCode: 0, stdout: 'sha' },
      'rev-list --left-right --count feature...feature@{upstream}': {
        exitCode: 0,
        stdout: '0\t3',
      },
    })
    const facts = createCleanupWorktreeFacts({
      worktrees: fakeSource({
        record: structuredClone(RECORD),
        leaseStates: ['active', 'expired'],
      }),
      scope: SCOPE,
      runGit: git.runGit,
      clock: () => new Date('2026-09-21T00:00:00.000Z'),
    })
    const observed = facts('wt-1')
    // Upstream known, ahead 0 → pushed. One live lease (the expired view
    // holds nothing). Not archived.
    expect(observed).toEqual({
      clean: 'true',
      pushed: 'true',
      active_leases: '1',
      archived_seconds: '0',
    })
    expect(git.calls[0]).toEqual(['status', '--porcelain'])
    // The matched policy contract: clean and pushed are satisfied; the one
    // live lease keeps `no_active_leases` blocked (truthful, not fabricated).
    const evaluation = evaluatePredicates([{ kind: 'clean' }, { kind: 'pushed' }], observed ?? {})
    expect(evaluation.matched).toBe(true)
    const leased = evaluatePredicates([{ kind: 'no_active_leases' }], observed ?? {})
    expect(leased.matched).toBe(false)
    expect(leased.blockers[0]).toMatchObject({ code: 'leased' })
  })

  test('a dirty tree, unpushed branch, and archived-at timestamp are observed truthfully', () => {
    const git = scriptedGit({
      'status --porcelain': { exitCode: 0, stdout: ' M file\n' },
      'rev-parse --verify --quiet feature@{upstream}': { exitCode: 1, stdout: '' },
      'rev-list --count feature --not --remotes': { exitCode: 0, stdout: '2' },
    })
    const facts = createCleanupWorktreeFacts({
      worktrees: fakeSource({
        record: {
          ...structuredClone(RECORD),
          archived: true,
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
        leaseStates: ['suspect'],
      }),
      scope: SCOPE,
      runGit: git.runGit,
      clock: () => new Date('2026-09-20T01:00:00.000Z'),
    })
    const observed = facts('wt-1')
    expect(observed).toEqual({
      clean: 'false',
      pushed: 'false',
      active_leases: '1',
      archived_seconds: '3600',
    })
    const evaluation = evaluatePredicates([{ kind: 'archived_for', seconds: 3600 }], observed ?? {})
    expect(evaluation.matched).toBe(true)
    const stricter = evaluatePredicates([{ kind: 'archived_for', seconds: 3601 }], observed ?? {})
    expect(stricter.matched).toBe(false)
  })

  test('a failed git command or missing branch leaves the fact absent, never false-positive', () => {
    const git = scriptedGit({
      // status fails outright.
      'status --porcelain': { exitCode: 128, stdout: '' },
    })
    const facts = createCleanupWorktreeFacts({
      worktrees: fakeSource({ record: structuredClone(RECORD), leaseStates: [] }),
      scope: SCOPE,
      runGit: git.runGit,
    })
    const observed = facts('wt-1')
    // No `clean` and no `pushed`: unprovable, so the predicates fail closed.
    expect(observed).toEqual({ active_leases: '0', archived_seconds: '0' })
    const evaluation = evaluatePredicates([{ kind: 'clean' }, { kind: 'pushed' }], observed ?? {})
    expect(evaluation.matched).toBe(false)
    expect(evaluation.blockers.map((blocker) => blocker.code)).toEqual(['dirty', 'unpushed'])

    const branchless = createCleanupWorktreeFacts({
      worktrees: fakeSource({
        record: { ...structuredClone(RECORD), branchRef: undefined },
        leaseStates: [],
      }),
      scope: SCOPE,
      runGit: (args) => {
        // `clean` observation is still attempted (it is branch-independent);
        // any push-state probe would be a bug.
        if (args[0] === 'status') return { exitCode: 0, stdout: '' }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      },
    })
    const branchlessFacts = branchless('wt-1')
    // Push state is unprovable without a branch ref (absent); the working
    // tree clean fact is still observed.
    expect(branchlessFacts?.['pushed']).toBeUndefined()
    expect(branchlessFacts?.['clean']).toBe('true')
  })
})
