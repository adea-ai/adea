// Quarantine trash: identity-proven rename and restore, fail-closed trash
// roots, provenance-recorded deletion, and a bounded sweep whose backlog
// persists across page caps and restarts. Donor: Orca worktree-trash.ts (MIT);
// hardened per the Dev Runtime spec.
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTrashSweeper,
  deleteQuarantinedWorktree,
  isTrashEntryName,
  quarantineWorktree,
  restoreWorktreeFromTrash,
  WORKTREE_TRASH_DIR_NAME,
} from '../shell/src/dev-runtime/worktrees/trash'
import { identityOfPath } from '../shell/src/dev-runtime/worktrees/identity'
import { initRepo } from './worktree-fixtures'

const scratchRoots: string[] = []
afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adea-trash-'))
  scratchRoots.push(dir)
  return dir
}

function quarantinable(dir: string, name: string) {
  const repo = initRepo(join(dir, 'repo'))
  const worktree = join(dir, 'worktrees', name)
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, 'file.txt'), 'payload\n')
  const identity = identityOfPath(worktree)
  return { repo, worktree, identity }
}

describe('quarantine rename', () => {
  test('renames into the sibling trash root and proves the moved identity', () => {
    const dir = scratch()
    try {
      const { repo, worktree, identity } = quarantinable(dir, 'feature')
      const moved = quarantineWorktree({
        worktreeId: 'wt-1',
        worktreePath: worktree,
        repoPath: repo,
        expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
      })
      expect(existsSync(worktree)).toBe(false)
      expect(existsSync(join(moved.trashPath, 'file.txt'))).toBe(true)
      expect(isTrashEntryName(moved.entryName)).toBe(true)
      // Provenance record exists beside the entry.
      expect(existsSync(join(moved.trashRoot, `${moved.entryName}.record.json`))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('restores the checkout when registration cleanup fails', () => {
    const dir = scratch()
    try {
      const { repo, worktree, identity } = quarantinable(dir, 'feature')
      const moved = quarantineWorktree({
        worktreeId: 'wt-1',
        worktreePath: worktree,
        repoPath: repo,
        expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
      })
      expect(restoreWorktreeFromTrash(moved.trashPath, worktree)).toBe(true)
      expect(existsSync(join(worktree, 'file.txt'))).toBe(true)
      expect(existsSync(moved.trashPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fails closed on a symlinked trash root instead of deleting in place', () => {
    const dir = scratch()
    try {
      const { repo, worktree, identity } = quarantinable(dir, 'feature')
      const external = join(dir, 'external')
      mkdirSync(external)
      symlinkSync(external, join(dir, 'worktrees', WORKTREE_TRASH_DIR_NAME))
      expect(() =>
        quarantineWorktree({
          worktreeId: 'wt-1',
          worktreePath: worktree,
          repoPath: repo,
          expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
        })
      ).toThrow()
      // The checkout was never destroyed.
      expect(existsSync(join(worktree, 'file.txt'))).toBe(true)
      expect(readdirSync(external)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses an identity that changed before the rename', () => {
    const dir = scratch()
    try {
      const { repo, worktree, identity } = quarantinable(dir, 'feature')
      // Replace the directory wholesale after the identity was observed.
      rmSync(worktree, { recursive: true, force: true })
      mkdirSync(worktree)
      writeFileSync(join(worktree, 'file.txt'), 'payload\n')
      expect(() =>
        quarantineWorktree({
          worktreeId: 'wt-1',
          worktreePath: worktree,
          repoPath: repo,
          expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
        })
      ).toThrow()
      expect(existsSync(join(worktree, 'file.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('deletion re-proves identity and removes the proven entry only', () => {
    const dir = scratch()
    try {
      const { repo, worktree, identity } = quarantinable(dir, 'feature')
      const moved = quarantineWorktree({
        worktreeId: 'wt-1',
        worktreePath: worktree,
        repoPath: repo,
        expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
      })
      expect(
        deleteQuarantinedWorktree({ trashRoot: moved.trashRoot, entryName: moved.entryName })
          .deleted
      ).toBe(true)
      expect(existsSync(moved.trashPath)).toBe(false)
      expect(existsSync(join(moved.trashRoot, `${moved.entryName}.record.json`))).toBe(false)

      // An unrecognized entry name is never a deletion target.
      expect(() =>
        deleteQuarantinedWorktree({ trashRoot: moved.trashRoot, entryName: '../../../etc' })
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('bounded sweep with persisted continuation', () => {
  test('drains every proven entry across page caps and a restart', async () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const entries: Array<{ trashRoot: string; entryName: string }> = []
      for (const name of ['one', 'two', 'three']) {
        const { worktree, identity } = quarantinable(dir, name)
        entries.push(
          quarantineWorktree({
            worktreeId: `wt-${name}`,
            worktreePath: worktree,
            repoPath: repo,
            expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
          })
        )
      }
      const stateFile = join(dir, 'sweep-state.json')
      const sweeper = createTrashSweeper({ stateFile, staleAfterMs: 0 })
      sweeper.beginSweep(entries.map((entry) => entry.trashRoot))
      expect(sweeper.pendingCount()).toBe(3)

      // Page cap 1: three pages, persisted cursor between them.
      expect(sweeper.sweepPage(1)).toMatchObject({ removed: 1, remaining: 2, done: false })
      expect(sweeper.sweepPage(1)).toMatchObject({ removed: 1, remaining: 1, done: false })

      // "Restart": a fresh sweeper instance resumes the persisted backlog.
      const restarted = createTrashSweeper({ stateFile, staleAfterMs: 0 })
      expect(restarted.pendingCount()).toBe(1)
      expect(restarted.sweepPage(1)).toMatchObject({ removed: 1, remaining: 0, done: true })
      expect(restarted.pendingCount()).toBe(0)
      for (const entry of entries) {
        expect(existsSync(join(entry.trashRoot, entry.entryName))).toBe(false)
      }
      expect(existsSync(stateFile)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('never sweeps entries that are not proven ours, and keeps fresh ones', () => {
    const dir = scratch()
    try {
      const repo = initRepo(join(dir, 'repo'))
      const { worktree, identity } = quarantinable(dir, 'feature')
      const moved = quarantineWorktree({
        worktreeId: 'wt-1',
        worktreePath: worktree,
        repoPath: repo,
        expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
      })
      // A stray directory in the trash root is invisible to the sweep.
      mkdirSync(join(moved.trashRoot, 'unrelated-directory'), { recursive: true })
      writeFileSync(join(moved.trashRoot, 'wt-notes.txt'), 'keep\n')

      const sweeper = createTrashSweeper({
        stateFile: join(dir, 'sweep.json'),
        staleAfterMs: 60_000,
      })
      sweeper.beginSweep([moved.trashRoot])
      // The entry is quarantined "now" relative to the real clock and the
      // sweeper demands 60s of staleness: kept, not deleted.
      expect(sweeper.sweepPage(10)).toMatchObject({ removed: 0, failed: 1, remaining: 1 })
      expect(existsSync(moved.trashPath)).toBe(true)
      expect(existsSync(join(moved.trashRoot, 'unrelated-directory'))).toBe(true)
      expect(existsSync(join(moved.trashRoot, 'wt-notes.txt'))).toBe(true)

      // A live worktree directory is never touched by the sweep.
      const live = join(dir, 'worktrees', 'live')
      mkdirSync(live, { recursive: true })
      writeFileSync(join(live, 'keep.txt'), 'x\n')
      sweeper.beginSweep([moved.trashRoot, join(dir, 'worktrees')])
      expect(sweeper.pendingCount()).toBe(1)
      expect(existsSync(join(live, 'keep.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
