import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectReport,
  dockerResourceInventory,
  isPrimaryWorktreePath,
  planWorktrees,
  worktreesOf,
} from './dev-resource-reuse-report.mjs'
import { REUSE_DECISION, REUSE_REFUSAL } from './dev-resource-reuse.mjs'

const temporaryDirectories: string[] = []

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'adea-reuse-safety-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function claimedLease(worktree: string) {
  return {
    version: 1,
    runId: 'active-run',
    identity: { worktree, label: 'test-project' },
    owner: { pid: 123, hostname: 'test-host' },
    state: 'claimed',
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('reuse safety against path aliases and incomplete inventory', () => {
  test('a lease through a symlink aliases the physical checkout and protects it', () => {
    const root = temporaryDirectory()
    const primary = join(root, 'primary')
    const alias = join(root, 'primary-alias')
    mkdirSync(primary)
    symlinkSync(primary, alias, 'dir')

    expect(isPrimaryWorktreePath(alias, primary)).toBe(true)
    const [plan] = planWorktrees(
      [
        {
          path: alias,
          physicalPath: primary,
          physicalPathResolved: true,
          localChanges: false,
          published: true,
          origin: { fresh: true, containsHead: true },
        },
      ],
      [claimedLease(primary)],
      { isProcessAlive: () => true, host: 'test-host' }
    )

    expect(plan?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan?.plan.reasons).toContain(REUSE_REFUSAL.owned)
    expect(plan?.plan.evidence.matchingLeases.map((lease) => lease.runId)).toEqual(['active-run'])
  })

  test('an unresolved lease path makes every checkout uncertain', () => {
    const root = temporaryDirectory()
    const path = join(root, 'checkout')
    mkdirSync(path)
    const [plan] = planWorktrees(
      [
        {
          path,
          physicalPath: path,
          physicalPathResolved: true,
          localChanges: false,
          published: true,
          origin: { fresh: true, containsHead: true },
        },
      ],
      [claimedLease(join(root, 'missing-checkout'))],
      { isProcessAlive: () => false, host: 'test-host' }
    )

    expect(plan?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(plan?.plan.reasons).toContain(REUSE_REFUSAL.uncertainLeaseEvidence)
  })

  test('Docker listing errors are retained as incomplete inventory', () => {
    const inventory = dockerResourceInventory(() => ({
      status: 1,
      stdout: '',
      stderr: 'daemon unavailable',
    }))

    expect(inventory.resources).toEqual([])
    expect(inventory.errors.map((error) => error.source)).toEqual([
      'docker containers',
      'docker volumes',
    ])
    const { report } = collectReport({
      leaseDir: temporaryDirectory(),
      dockerResources: inventory.resources,
      inventoryErrors: inventory.errors,
    })
    expect(report.inventoryComplete).toBe(false)
    expect(report.preservation.ok).toBe(false)
  })

  test('a failed Git worktree listing is an inventory error', () => {
    const repo = temporaryDirectory()
    let calls = 0
    const inventory = worktreesOf(repo, {
      runCommand: () => {
        calls += 1
        return { status: 128, stdout: '', stderr: 'not a repository' }
      },
    })

    expect(calls).toBe(1)
    expect(inventory.worktrees).toEqual([])
    expect(inventory.inventoryError?.source).toBe('git worktree list')
  })
})
