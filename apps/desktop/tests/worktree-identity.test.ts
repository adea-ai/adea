// Admin-fingerprint and gitdir-proof behavior. Ported from Orca
// `repo-worktree-admin-fingerprint.test.ts` and
// `worktree-removal-safety.test.ts` fixtures (MIT) plus Adea hardening.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import {
  directoryIdentity,
  identityOfPath,
  isDangerousCleanupPath,
  proveWorktreeRegistration,
  readRepoWorktreeAdminFingerprint,
  sameIdentity,
} from '../shell/src/dev-runtime/worktrees/identity'
import { git, initRepo } from './worktree-fixtures'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'adea-worktree-identity-'))
}

describe('readRepoWorktreeAdminFingerprint', () => {
  test('is null when the path is not a git repository', async () => {
    const dir = scratch()
    try {
      expect(await readRepoWorktreeAdminFingerprint(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is stable across no-op reads', async () => {
    const dir = scratch()
    try {
      initRepo(dir)
      const first = await readRepoWorktreeAdminFingerprint(dir)
      const second = await readRepoWorktreeAdminFingerprint(dir)
      expect(first).not.toBeNull()
      expect(first).toBe(second)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('moves when a linked worktree is added or removed', async () => {
    const dir = scratch()
    try {
      initRepo(dir)
      const base = await readRepoWorktreeAdminFingerprint(dir)
      const worktree = join(dir, 'feature')
      git(dir, ['worktree', 'add', worktree, '-b', 'feature'])
      const afterAdd = await readRepoWorktreeAdminFingerprint(dir)
      expect(afterAdd).not.toBe(base)

      git(dir, ['worktree', 'remove', worktree])
      const afterRemove = await readRepoWorktreeAdminFingerprint(dir)
      expect(afterRemove).not.toBe(afterAdd)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('moves when a linked worktree commits (HEAD symref tip)', async () => {
    const dir = scratch()
    try {
      initRepo(dir)
      const worktree = join(dir, 'feature')
      git(dir, ['worktree', 'add', worktree, '-b', 'feature'])
      const before = await readRepoWorktreeAdminFingerprint(dir)
      writeFileSync(join(worktree, 'file.txt'), 'change\n')
      git(worktree, ['add', '.'])
      git(worktree, ['commit', '-m', 'work'])
      const after = await readRepoWorktreeAdminFingerprint(dir)
      expect(after).not.toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('detects an externally deleted worktree directory via the prunable probe', async () => {
    const dir = scratch()
    try {
      initRepo(dir)
      const worktree = join(dir, 'feature')
      git(dir, ['worktree', 'add', worktree, '-b', 'feature'])
      const before = await readRepoWorktreeAdminFingerprint(dir)
      rmSync(worktree, { recursive: true, force: true })
      const after = await readRepoWorktreeAdminFingerprint(dir)
      expect(after).not.toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reflects a packed ref tip move via the packed-refs stamp', async () => {
    const dir = scratch()
    try {
      initRepo(dir)
      git(dir, ['pack-refs', '--all'])
      const before = await readRepoWorktreeAdminFingerprint(dir)
      writeFileSync(join(dir, 'more.txt'), 'x\n')
      git(dir, ['add', '.'])
      git(dir, ['commit', '-m', 'second'])
      git(dir, ['pack-refs', '--all'])
      const after = await readRepoWorktreeAdminFingerprint(dir)
      expect(after).not.toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gitdir backlink proof', () => {
  test('proves a created worktree and refuses after admin-entry loss', async () => {
    const dir = scratch()
    try {
      initRepo(dir)
      const worktree = join(dir, 'feature')
      git(dir, ['worktree', 'add', worktree, '-b', 'feature'])
      const proof = await proveWorktreeRegistration(worktree)
      expect(proof).not.toBeNull()
      // The git common dir is the shared admin root (the primary `.git`),
      // reported by git in its own resolved spelling (/private/var on macOS).
      expect(proof!.commonDir).toBe(realpathSync(join(dir, '.git')))

      // Orphan simulation: destroy the admin entry; the checkout's backlink
      // can no longer be proven.
      rmSync(join(dir, '.git', 'worktrees', 'feature'), { recursive: true, force: true })
      expect(await proveWorktreeRegistration(worktree)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not treat the primary checkout as a linked worktree', async () => {
    const dir = scratch()
    try {
      initRepo(dir)
      expect(await proveWorktreeRegistration(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('directoryIdentity binds device+inode and detects replacement', () => {
    const dir = scratch()
    try {
      const inner = join(dir, 'wt')
      mkdirSync(inner)
      const first = directoryIdentity(inner)
      expect(sameIdentity(first.identity, first.identity)).toBe(true)

      // Replace the directory wholesale (delete + recreate).
      rmSync(inner, { recursive: true, force: true })
      mkdirSync(inner)
      const second = directoryIdentity(inner)
      expect(sameIdentity(first.identity, second.identity)).toBe(false)
      expect(identityOfPath(inner).inode).toBe(second.identity.inode)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isDangerousCleanupPath', () => {
  const repo = join(tmpdir(), 'some-repo')

  test('refuses the repo itself, roots, home ancestors, and home shapes', () => {
    expect(isDangerousCleanupPath('', repo)).toBe(true)
    expect(isDangerousCleanupPath('   ', repo)).toBe(true)
    expect(isDangerousCleanupPath(repo, repo)).toBe(true)
    expect(isDangerousCleanupPath('/', repo)).toBe(true)
    expect(isDangerousCleanupPath(homedir(), repo)).toBe(true)
    // A parent of the repo can never be a worktree cleanup.
    expect(isDangerousCleanupPath('/Users', repo)).toBe(true)
  })

  test('allows an ordinary sibling worktree path', () => {
    expect(isDangerousCleanupPath(join(tmpdir(), 'some-repo-worktrees', 'feature'), repo)).toBe(
      false
    )
  })
})
