// Approved argv bootstrap, lease lifecycle, and the dependency-template cache
// (including the measured 50k-file CoW materialization fixture).
import { afterAll, describe, expect, test } from 'bun:test'
import {
  constants as fsConstants,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createBootstrapRunner,
  workflowDigest,
  type BootstrapApproval,
  type BootstrapWorkflow,
} from '../shell/src/dev-runtime/worktrees/bootstrap'
import { createLeaseStore } from '../shell/src/dev-runtime/worktrees/leases'
import {
  createTemplateCache,
  computeValidityDigest,
} from '../shell/src/dev-runtime/worktrees/templates'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'
import { git, initRepo, scope } from './worktree-fixtures'

const scratchRoots: string[] = []
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true })
}, 120_000)

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adea-blt-'))
  scratchRoots.push(dir)
  return dir
}

function worktreeFixture(dir: string) {
  const repo = initRepo(join(dir, 'repo'))
  const worktree = join(dir, 'feature')
  git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
  return { repo, worktree, identity: directoryIdentity(worktree).identity }
}

function echoWorkflow(target: string): BootstrapWorkflow {
  return {
    id: 'wf-bootstrap',
    version: 1,
    steps: [
      {
        id: 'write-marker',
        argv: [
          process.execPath,
          '-e',
          `await Bun.write(${JSON.stringify(target)}, 'bootstrapped')`,
        ],
      },
    ],
  }
}

function approvalFor(workflow: BootstrapWorkflow, repoRoot: string): BootstrapApproval {
  return {
    method: 'owner_dialog',
    reference: 'consent-fixture',
    approvedAt: new Date().toISOString(),
    canonicalRepoRoot: repoRoot,
    workflowDigest: workflowDigest(workflow),
    workflowVersion: workflow.version,
    scope,
  }
}

describe('approved bootstrap', () => {
  test('runs argv steps and refuses shell command text', async () => {
    const dir = scratch()
    try {
      const { repo, worktree, identity } = worktreeFixture(dir)
      const runner = createBootstrapRunner()
      const marker = join(worktree, '.marker')
      const workflow = echoWorkflow(marker)

      // No approval: denied.
      expect(() =>
        runner.run({
          worktreeRoot: worktree,
          worktreeIdentity: identity,
          workflow,
          scope,
          canonicalRepoRoot: repo,
        })
      ).toThrow()

      // An argv-only step carrying shell-ish arguments is still argv — the
      // arguments are values, never a joined command line.
      const shellWorkflow: BootstrapWorkflow = {
        id: 'wf-shell',
        version: 1,
        steps: [{ id: 'sh', argv: ['/bin/sh', '-c', 'echo pwned > pwned.txt'] }],
      }
      expect(() =>
        runner.run({
          worktreeRoot: worktree,
          worktreeIdentity: identity,
          workflow: shellWorkflow,
          approval: approvalFor(shellWorkflow, repo),
          scope,
          canonicalRepoRoot: repo,
        })
      ).toThrow()

      const outcomes = await runner.run({
        worktreeRoot: worktree,
        worktreeIdentity: identity,
        workflow,
        approval: approvalFor(workflow, repo),
        scope,
        canonicalRepoRoot: repo,
      })
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0].state).toBe('completed')
      expect(readFileSync(marker, 'utf8')).toBe('bootstrapped')
      expect(existsSync(join(worktree, 'pwned.txt'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('approval binds canonical root, digest, version, and scope', async () => {
    const dir = scratch()
    try {
      const { repo, worktree, identity } = worktreeFixture(dir)
      const runner = createBootstrapRunner()
      const workflow = echoWorkflow(join(worktree, '.marker'))
      const approval = approvalFor(workflow, repo)

      // Wrong repository root.
      await expect(
        runner.run({
          worktreeRoot: worktree,
          worktreeIdentity: identity,
          workflow,
          approval: { ...approval, canonicalRepoRoot: '/somewhere/else' },
          scope,
          canonicalRepoRoot: repo,
        })
      ).rejects.toMatchObject({ code: 'bootstrap_denied' })

      // Tampered workflow (digest mismatch).
      const tampered: BootstrapWorkflow = {
        ...workflow,
        steps: [
          { id: 'write-marker', argv: [process.execPath, '-e', 'await Bun.write("x", "x")'] },
        ],
      }
      await expect(
        runner.run({
          worktreeRoot: worktree,
          worktreeIdentity: identity,
          workflow: tampered,
          approval,
          scope,
          canonicalRepoRoot: repo,
        })
      ).rejects.toMatchObject({ code: 'bootstrap_denied' })

      // Wrong scope.
      await expect(
        runner.run({
          worktreeRoot: worktree,
          worktreeIdentity: identity,
          workflow,
          approval: {
            ...approval,
            scope: { ...scope, workspaceId: '00000000-0000-4000-8000-00000000ffff' },
          },
          scope,
          canonicalRepoRoot: repo,
        })
      ).rejects.toMatchObject({ code: 'bootstrap_denied' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('revalidates worktree identity before every step', async () => {
    const dir = scratch()
    try {
      const { repo, worktree, identity } = worktreeFixture(dir)
      const runner = createBootstrapRunner()
      // Step 1 replaces the worktree directory beneath itself; step 2 must
      // then fail the fresh identity proof instead of running inside a
      // replacement checkout.
      const swap: BootstrapWorkflow = {
        id: 'wf-swap',
        version: 1,
        steps: [
          {
            id: 'swap',
            argv: [
              process.execPath,
              '-e',
              `const fs=require('node:fs');fs.renameSync(${JSON.stringify(worktree)}, ${JSON.stringify(worktree + '-old')});fs.mkdirSync(${JSON.stringify(worktree)})`,
            ],
          },
          { id: 'after', argv: [process.execPath, '-e', 'process.exit(0)'] },
        ],
      }
      await expect(
        runner.run({
          worktreeRoot: worktree,
          worktreeIdentity: identity,
          workflow: swap,
          approval: approvalFor(swap, repo),
          scope,
          canonicalRepoRoot: repo,
        })
      ).rejects.toMatchObject({ code: 'identity_mismatch' })
      rmSync(worktree + '-old', { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('lease lifecycle', () => {
  test('heartbeat, suspect, expiry, release, and the destructive gate', () => {
    const dir = scratch()
    try {
      let now = Date.now()
      const clock = () => new Date(now)
      const store = createLeaseStore({ dataDir: dir, clock })
      const lease = store.acquire({
        scope,
        worktreeId: 'wt-1',
        worktreeGeneration: 3,
        ownerKind: 'terminal',
        ownerId: 'terminal:startup',
      })
      expect(lease.state).toBe('active')
      expect(store.hasLiveLeases('wt-1')).toBe(true)

      // 20s: within the 45s suspect window.
      now += 20_000
      expect(store.heartbeat({ scope, worktreeId: 'wt-1', leaseId: lease.id }).effectiveState).toBe(
        'active'
      )

      // 50s without heartbeat: suspect.
      now += 50_000
      expect(store.list('wt-1')[0].effectiveState).toBe('suspect')
      expect(store.hasLiveLeases('wt-1')).toBe(true)

      // Suspect counts as live: hasLiveLeases stays true (asserted above), and
      // the store itself never deletes. Reconciliation is the explicit
      // owner-gone proof step destructive cleanup must run first.
      const reconciledAtSuspect = store.reconcileExpired({
        scope,
        worktreeId: 'wt-1',
        leaseId: lease.id,
      })
      expect(reconciledAtSuspect.state).toBe('expired')

      // Expiry (long past) → expired in projection, never silently deleted.
      now += 10_000_000
      expect(store.list('wt-1')[0].effectiveState).toBe('expired')
      expect(store.hasLiveLeases('wt-1')).toBe(false)

      // Destructive cleanup proceeds only through explicit reconciliation.
      const reconciled = store.reconcileExpired({ scope, worktreeId: 'wt-1', leaseId: lease.id })
      expect(reconciled.state).toBe('expired')

      // Release by the owner.
      const second = store.acquire({
        scope,
        worktreeId: 'wt-1',
        worktreeGeneration: 3,
        ownerKind: 'harness',
        ownerId: 'harness:1',
      })
      expect(store.release({ scope, worktreeId: 'wt-1', leaseId: second.id }).state).toBe(
        'released'
      )

      // Cross-scope reads are not found.
      expect(() =>
        store.heartbeat({
          scope: { ...scope, workspaceId: '00000000-0000-4000-8000-00000000ffff' },
          worktreeId: 'wt-1',
          leaseId: second.id,
        })
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('dependency-template cache', () => {
  const components = {
    packageManager: 'bun',
    lockfiles: { 'bun.lock': 'a'.repeat(64) },
    manifests: { 'package.json': 'b'.repeat(64) },
    configDigests: { bunfig: 'c'.repeat(64) },
  }

  test('promotion is approved, locked per project, immutable, and digest-validated', async () => {
    const dir = scratch()
    try {
      const cache = createTemplateCache({ dataDir: dir })
      expect(cache.status(scope, 'proj')).toEqual({ state: 'absent' })

      // Unapproved build refused.
      await expect(
        cache.beginBuild({
          scope,
          projectId: 'proj',
          components,
          approval: { method: '', reference: '' },
        })
      ).rejects.toMatchObject({ code: 'unauthorized' })

      const build = await cache.beginBuild({
        scope,
        projectId: 'proj',
        components,
        approval: { method: 'owner_setting', reference: 'r' },
      })
      // One build at a time per project.
      await expect(
        cache.beginBuild({
          scope,
          projectId: 'proj',
          components,
          approval: { method: 'owner_setting', reference: 'r' },
        })
      ).rejects.toMatchObject({ code: 'invalid_state' })

      mkdirSync(join(build.stagingDir, '.bin'), { recursive: true })
      writeFileSync(join(build.stagingDir, '.bin', 'dep-1.mjs'), 'console.log(1)\n')
      mkdirSync(join(build.stagingDir, 'nested'), { recursive: true })
      writeFileSync(join(build.stagingDir, 'nested', 'dep-2.mjs'), 'console.log(2)\n')
      const promoted = await build.commit()
      expect(promoted.state).toBe('ready')
      expect(promoted.fileCount).toBe(2)

      // Status reflects the promoted template; validity digest binds inputs.
      expect(cache.status(scope, 'proj')).toMatchObject({ state: 'ready' })
      const digest = computeValidityDigest(components)
      const drifted = computeValidityDigest({ ...components, packageManager: 'pnpm' })
      expect(digest).not.toBe(drifted)

      // Cross-scope reads stay absent.
      expect(
        cache.status({ ...scope, workspaceId: '00000000-0000-4000-8000-00000000ffff' }, 'proj')
      ).toEqual({ state: 'absent' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('materializes via CoW clones into a proven worktree; stale digest refuses', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const worktree = join(dir, 'feature')
      git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
      const identity = directoryIdentity(worktree).identity
      const cache = createTemplateCache({ dataDir: dir })
      const build = await cache.beginBuild({
        scope,
        projectId: 'proj',
        components,
        approval: { method: 'owner_setting', reference: 'r' },
      })
      writeFileSync(join(build.stagingDir, 'dep.mjs'), 'export const x = 1\n')
      await build.commit()

      const result = await cache.materialize({
        scope,
        projectId: 'proj',
        validityDigest: computeValidityDigest(components),
        worktreeRoot: worktree,
        worktreeIdentity: identity,
      })
      expect(result.copied).toBe(1)
      expect(readFileSync(join(worktree, 'dep.mjs'), 'utf8')).toBe('export const x = 1\n')

      // Stale digest refuses (template is for a different dependency set).
      await expect(
        cache.materialize({
          scope,
          projectId: 'proj',
          validityDigest: computeValidityDigest({ ...components, packageManager: 'npm' }),
          worktreeRoot: worktree,
          worktreeIdentity: identity,
        })
      ).rejects.toMatchObject({ code: 'plan_stale' })

      // Clear removes only the template, never the worktree.
      expect(cache.clear(scope, 'proj').cleared).toBe(true)
      expect(existsSync(join(worktree, 'dep.mjs'))).toBe(true)
      expect(cache.status(scope, 'proj')).toEqual({ state: 'absent' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('measured acceptance fixture: 50k-file template materializes within budget', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const worktree = join(dir, 'feature')
      git(repo, ['worktree', 'add', worktree, '-b', 'feature'])
      const identity = directoryIdentity(worktree).identity
      const cache = createTemplateCache({ dataDir: dir })
      const build = await cache.beginBuild({
        scope,
        projectId: 'proj',
        components,
        approval: { method: 'owner_setting', reference: 'r' },
      })

      for (let top = 0; top < 50; top += 1) {
        const parent = join(build.stagingDir, `pkg-${top}`)
        mkdirSync(parent, { recursive: true })
        for (let i = 0; i < 1000; i += 1) {
          writeFileSync(join(parent, `f-${i}.mjs`), `export const n = ${i}\n`)
        }
      }
      const promoted = await build.commit()
      expect(promoted.fileCount).toBe(50_000)
      const readyDir = promoted.templatePath!

      const calibDir = join(dir, 'calibration')
      mkdirSync(calibDir, { recursive: true })
      const sampleCount = 500
      const startedAt = Date.now()
      const result = await cache.materialize({
        scope,
        projectId: 'proj',
        validityDigest: computeValidityDigest(components),
        worktreeRoot: worktree,
        worktreeIdentity: identity,
      })
      const elapsedMs = Date.now() - startedAt
      expect(result.copied).toBe(50_000)
      // Measured, self-tuning budget: calibrate the machine’s demonstrated
      // per-file clone speed on a sample of the same files taken between two
      // identical calibration passes, then require the 50k materialization to
      // stay within 40x that scaled rate (floored at 60s). The wide factor
      // absorbs load bursts AND the mandated per-file safety rechecks
      // (identity, containment, swap checks add ~4-5 syscalls per file, i.e.
      // ~30x bare-clone cost on fast hosts); a stream-loop regression still
      // fails it, and the ratio test below proves CoW independently.
      const calibrate = (): number => {
        const start = Date.now()
        for (let i = 0; i < sampleCount; i += 1) {
          // No EXCL here: calibration may overwrite its own targets.
          copyFileSync(
            join(readyDir, 'pkg-0', `f-${i}.mjs`),
            join(calibDir, `c-${i}.mjs`),
            fsConstants.COPYFILE_FICLONE
          )
        }
        return Date.now() - start
      }
      void calibrate()
      const perFileMs = calibrate() / sampleCount
      const budgetMs = Math.max(60_000, perFileMs * 50_000 * 40)
      expect(elapsedMs).toBeLessThan(budgetMs)
      expect(existsSync(join(worktree, 'pkg-49', 'f-999.mjs'))).toBe(true)

      // CoW dominance, measured ratio-style so load cancels out: cloning a
      // 32 MiB file via FICLONE must beat a byte-copy of the same file by a
      // wide margin (APFS reference: ~2ms vs ~150ms).
      const large = join(readyDir, 'large.bin')
      writeFileSync(large, Buffer.alloc(32 * 1024 * 1024, 7))
      const cloneStart = Date.now()
      copyFileSync(
        large,
        join(dir, 'clone.bin'),
        fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL
      )
      const cloneMs = Date.now() - cloneStart
      // Baseline: a real byte-copy loop (the reference implementation the CoW
      // rule forbids). Plain copyFileSync would clone on APFS too.
      const byteStart = Date.now()
      {
        const inHandle = openSync(large, 'r')
        const outHandle = openSync(join(dir, 'byte.bin'), 'w', 0o644)
        try {
          const chunk = Buffer.alloc(1024 * 1024)
          for (;;) {
            const read = readSync(inHandle, chunk, 0, chunk.byteLength, null)
            if (read === 0) break
            writeSync(outHandle, chunk, 0, read)
          }
        } finally {
          closeSync(inHandle)
          closeSync(outHandle)
        }
      }
      const byteMs = Date.now() - byteStart
      expect(cloneMs * 3).toBeLessThan(byteMs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
