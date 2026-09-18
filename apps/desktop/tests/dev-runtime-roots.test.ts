// M10 #34 substrate: the authorized-root (RootBookmark) authority that every
// dev.files.*/dev.git.* operation must validate against before a side effect.
// Fail-closed rules under test: owner approval at mint, canonical identity
// binding, containment, and identity rechecks at use time.
import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import { createAuthorityAudit } from '../shell/src/dev-runtime/audit'
import { createRootBookmarkAuthority } from '../shell/src/dev-runtime/roots'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const otherScope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000099',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const approval = { method: 'owner_dialog', reference: 'consent-1' } as const

function authority(dataDir: string, audit?: ReturnType<typeof createAuthorityAudit>) {
  return createRootBookmarkAuthority({ dataDir, audit })
}

function expectCode(run: () => unknown, code: DevAuthorityError['code']) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DevAuthorityError)
    expect((error as DevAuthorityError).code).toBe(code)
    return
  }
  throw new Error(`expected DevAuthorityError ${code}`)
}

describe('root bookmark authority', () => {
  test('mints only with owner approval evidence', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const root = join(dataDir, 'checkout')
      mkdirSync(root)
      const roots = authority(dataDir)
      expectCode(
        () => roots.mint({ scope, label: 'Repo', kind: 'repository', absolutePath: root }),
        'unauthorized'
      )
      const minted = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: root,
        approval,
      })
      expect(minted.state).toBe('active')
      expect(minted.generation).toBe(1)
      expect(minted.version).toBe(1)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('binds the canonical real path and file identity', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const linkDir = join(dataDir, 'alias')
      const root = join(dataDir, 'real', 'checkout')
      mkdirSync(root, { recursive: true })
      symlinkSync(root, linkDir)
      const roots = authority(dataDir)
      const minted = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: linkDir,
        approval,
      })
      expect(minted.canonicalRoot).toBe(realpathSync(root))
      expect(minted.rootIdentity.inode).toBe(String(statSync(root, { bigint: true }).ino))
      // The unsymlinked spelling of the same directory is the same bookmark.
      const again = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: root,
        approval,
      })
      expect(again.id).toBe(minted.id)
      expect(again.version).toBe(minted.version)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('rejects missing and non-directory roots; dangling links read as missing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const file = join(dataDir, 'notes.txt')
      writeFileSync(file, 'not a root')
      const link = join(dataDir, 'dangling')
      symlinkSync(join(dataDir, 'absent'), link)
      const roots = authority(dataDir)
      expectCode(
        () =>
          roots.mint({
            scope,
            label: 'X',
            kind: 'directory',
            absolutePath: join(dataDir, 'missing'),
            approval,
          }),
        'not_found'
      )
      expectCode(
        () => roots.mint({ scope, label: 'X', kind: 'directory', absolutePath: file, approval }),
        'special_file_rejected'
      )
      expectCode(
        () => roots.mint({ scope, label: 'X', kind: 'directory', absolutePath: link, approval }),
        'not_found'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('rechecks identity at use time and turns replacements stale', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const root = join(dataDir, 'checkout')
      mkdirSync(root)
      const roots = authority(dataDir)
      const minted = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: root,
        approval,
      })
      expect(roots.validate({ scope, bookmarkId: minted.id }).state).toBe('active')

      // Replace the directory: same path, provably different inode. The
      // replacement is allocated while the original still exists, so the two
      // can never share an inode even on inode-reusing filesystems.
      const replacement = join(dataDir, 'replacement')
      mkdirSync(replacement)
      const replacementInode = String(statSync(replacement, { bigint: true }).ino)
      expect(replacementInode).not.toBe(minted.rootIdentity.inode)
      rmSync(root, { recursive: true })
      renameSync(replacement, root)
      expectCode(() => roots.validate({ scope, bookmarkId: minted.id }), 'identity_mismatch')
      expect(roots.list({ scope }).items[0]!.state).toBe('stale')

      // The owner explicitly re-authorizes the same canonical root.
      const refreshed = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: root,
        approval,
      })
      expect(refreshed.id).toBe(minted.id)
      expect(refreshed.state).toBe('active')
      expect(refreshed.rootIdentity.inode).toBe(replacementInode)
      expect(refreshed.generation).toBeGreaterThan(minted.generation)
      expect(roots.validate({ scope, bookmarkId: minted.id }).state).toBe('active')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('fails closed when the root disappears or the bookmark was revoked', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const root = join(dataDir, 'checkout')
      mkdirSync(root)
      const roots = authority(dataDir)
      const minted = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: root,
        approval,
      })

      rmSync(root, { recursive: true })
      expectCode(() => roots.validate({ scope, bookmarkId: minted.id }), 'unauthorized_root')
      expect(roots.list({ scope }).items[0]!.state).toBe('stale')

      mkdirSync(root)
      const refreshed = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: root,
        approval,
      })
      expectCode(
        () => roots.revoke({ scope, bookmarkId: minted.id, expectedVersion: 99 }),
        'stale_version'
      )
      const revoked = roots.revoke({
        scope,
        bookmarkId: minted.id,
        expectedVersion: refreshed.version,
      })
      expect(revoked.state).toBe('revoked')
      expectCode(() => roots.validate({ scope, bookmarkId: minted.id }), 'unauthorized_root')
      // Revocation is idempotent and terminal.
      const repeated = roots.revoke({
        scope,
        bookmarkId: minted.id,
        expectedVersion: revoked.version,
      })
      expect(repeated.version).toBe(revoked.version)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('reads cross-scope access as not found', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const root = join(dataDir, 'checkout')
      mkdirSync(root)
      const roots = authority(dataDir)
      const minted = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: root,
        approval,
      })
      expectCode(() => roots.validate({ scope: otherScope, bookmarkId: minted.id }), 'not_found')
      expect(roots.list({ scope: otherScope }).items).toHaveLength(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('resolves contained paths with immediate revalidation', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const root = join(dataDir, 'checkout')
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
      const roots = authority(dataDir)
      const minted = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: root,
        approval,
      })

      const resolved = roots.resolvePath({
        scope,
        bookmarkId: minted.id,
        relativePath: 'src/index.ts',
      })
      expect(resolved.absolutePath).toBe(join(realpathSync(root), 'src/index.ts'))
      expect(resolved.kind).toBe('file')
      expect(resolved.identity.size).toBe(String(statSync(join(root, 'src/index.ts')).size))

      for (const relativePath of [
        '../escape',
        'src/../../escape',
        '/etc/passwd',
        'src\\escape',
        'a\0b',
        '',
        '.',
        'src/./x',
        'src/../..',
      ]) {
        expectCode(
          () => roots.resolvePath({ scope, bookmarkId: minted.id, relativePath }),
          'path_escape'
        )
      }

      const outside = join(dataDir, 'outside.txt')
      writeFileSync(outside, 'secret')
      symlinkSync(outside, join(root, 'leak.txt'))
      expectCode(
        () => roots.resolvePath({ scope, bookmarkId: minted.id, relativePath: 'leak.txt' }),
        'symlink_rejected'
      )

      // Even a symlink that stays inside the root is rejected: containment is
      // exact-path, not prefix-based.
      const inside = join(root, 'inner.txt')
      writeFileSync(inside, 'also fine')
      symlinkSync(inside, join(root, 'alias.txt'))
      expectCode(
        () => roots.resolvePath({ scope, bookmarkId: minted.id, relativePath: 'alias.txt' }),
        'symlink_rejected'
      )

      expectCode(
        () => roots.resolvePath({ scope, bookmarkId: minted.id, relativePath: 'absent.txt' }),
        'not_found'
      )
      expectCode(
        () => roots.resolvePath({ scope, bookmarkId: minted.id, relativePath: '../outside.txt' }),
        'path_escape'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('lists with kind filters, limits, and opaque cursors', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const roots = authority(dataDir)
      for (const name of ['a', 'b', 'c']) {
        const dir = join(dataDir, name)
        mkdirSync(dir)
        roots.mint({
          scope,
          label: name,
          kind: name === 'c' ? 'repository' : 'directory',
          absolutePath: dir,
          approval,
        })
      }
      expect(roots.list({ scope, kind: 'repository' }).items).toHaveLength(1)
      const page1 = roots.list({ scope, limit: 2 })
      expect(page1.items).toHaveLength(2)
      expect(page1.nextCursor).toBeDefined()
      const page2 = roots.list({ scope, limit: 2, cursor: page1.nextCursor })
      expect(page2.items).toHaveLength(1)
      expect(page2.nextCursor).toBeUndefined()
      expectCode(() => roots.list({ scope, limit: 501 }), 'limit_exceeded')
      expectCode(() => roots.list({ scope, cursor: 'not-a-cursor' }), 'not_found')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('fails closed on a corrupt store and retains the unread record', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const roots = authority(dataDir)
      const dir = join(dataDir, 'checkout')
      mkdirSync(dir)
      roots.mint({ scope, label: 'Repo', kind: 'repository', absolutePath: dir, approval })
      const storeDir = join(dataDir, 'dev-runtime', 'roots')
      writeFileSync(join(storeDir, 'bookmarks.json'), '{"schemaVersion":1,"records":[{"broken":', {
        mode: 0o600,
      })
      expectCode(() => authority(dataDir).list({ scope }), 'corrupt_state')
      const retained = readdirSync(storeDir).find((name) =>
        name.startsWith('bookmarks.json.corrupt-')
      )
      expect(retained).toBeDefined()
      expect(readFileSync(join(storeDir, retained!), 'utf8')).toContain('broken')
      expect(existsSync(join(storeDir, 'bookmarks.json'))).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('keeps private paths and unapproved details out of the audit trail', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-roots-'))
    try {
      const audit = createAuthorityAudit({ file: join(dataDir, 'audit.jsonl') })
      const roots = authority(dataDir, audit)
      const dir = join(dataDir, 'checkout')
      mkdirSync(dir)
      roots.mint({ scope, label: 'Repo', kind: 'repository', absolutePath: dir, approval })
      const trail = readFileSync(join(dataDir, 'audit.jsonl'), 'utf8')
      expect(trail).toContain('root.minted')
      expect(trail.includes(dir)).toBe(false)
      expect(() =>
        audit.append({
          action: 'root.minted',
          subjectId: 'x',
          outcome: 'granted',
          detail: { canonicalRoot: dir },
        })
      ).toThrow('forbidden audit detail')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
