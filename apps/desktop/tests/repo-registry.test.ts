// Repository registry (#398 follow-up): adopt/authorize/inspect/refresh over
// the durable repo authority. Every suite uses a throwaway data dir, a real
// authorized root bookmark, and a real local git repository — no network (the
// remote probe runs against a local bare "origin").
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DevCommand, DevOperation, Repo, Scope } from '../../../packages/types/src/dev-runtime'
import { decodeDevReply } from '../../../packages/types/src/dev-runtime'
import {
  createOwnerApprovalVerifier,
  type OwnerApproval,
  type OwnerApprovalVerifier,
} from '../shell/src/dev-runtime/authority'
import { registerProjectSessionRuntime } from '../shell/src/dev-runtime/project-session/register'
import { redactRemoteUrl, registerRepoRuntime } from '../shell/src/dev-runtime/repos/register'
import { createRootBookmarkAuthority } from '../shell/src/dev-runtime/roots'
import { createCredentialVault, createInMemoryVaultKeyStore } from '../shell/src/dev-runtime/vault'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const foreignScope: Scope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }

const repoId = '00000000-0000-4000-8000-000000000030'
const projectId = '00000000-0000-4000-8000-000000000020'

let consentSequence = 0
function approval(verifier: OwnerApprovalVerifier, action: string): OwnerApproval {
  const consent: OwnerApproval = {
    method: 'owner_dialog',
    reference: `repo-registry-consent-${++consentSequence}`,
    scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  verifier.recordIssuance(consent, scope, action)
  return consent
}

function git(dir: string, args: string[]): { stdout: string; code: number } {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Adea Tests',
      GIT_AUTHOR_EMAIL: 'adea@example.com',
      GIT_COMMITTER_NAME: 'Adea Tests',
      GIT_COMMITTER_EMAIL: 'adea@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    // `bun test` runs every file on one shared thread: bound every child.
    timeout: 60_000,
  })
  return { stdout: proc.stdout.toString(), code: proc.exitCode ?? 0 }
}

/** A real local git checkout whose origin is a local bare repository, so
 *  `git ls-remote` stays fully offline. origin/HEAD is set explicitly. */
function initRepoWithOrigin(workspace: string): string {
  const origin = realpathSync(mkdtempSync(join(workspace, 'origin-')))
  git(origin, ['init', '--bare', '-b', 'main'])
  const checkout = realpathSync(mkdtempSync(join(workspace, 'checkout-')))
  git(checkout, ['init', '-b', 'main'])
  git(checkout, ['config', 'user.email', 'adea@example.com'])
  git(checkout, ['config', 'user.name', 'Adea Tests'])
  git(checkout, ['config', 'core.hooksPath', '/dev/null'])
  writeFileSync(join(checkout, 'README.md'), '# fixture\n')
  git(checkout, ['add', '.'])
  git(checkout, ['commit', '-m', 'initial'])
  git(checkout, ['remote', 'add', 'origin', origin])
  git(checkout, ['push', '-u', 'origin', 'main'])
  git(checkout, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  return checkout
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'adea-repo-registry-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const checkout = initRepoWithOrigin(realpathSync(workspace))

  const verifier = createOwnerApprovalVerifier({ dataDir })
  const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
  const bookmark = roots.mint({
    scope,
    label: 'Workspace',
    kind: 'repository',
    absolutePath: workspace,
    approval: approval(verifier, 'authorize a root bookmark'),
  })
  const vault = createCredentialVault({
    dataDir,
    approvalVerifier: verifier,
    // Deterministic environments never touch the OS keychain.
    credentialStore: createInMemoryVaultKeyStore(),
  })
  const credential = vault.enroll({
    scope,
    label: 'GitHub token',
    host: 'github.com',
    kind: 'github_token',
    secret: 'secret-token-value',
    approval: approval(verifier, 'enroll a credential'),
  })

  // A real project/session register supplies the import-minted bindings.
  const projectSession = registerProjectSessionRuntime({
    authority: { registerCommandProvider() {} },
    dataDir,
    scope,
  })
  projectSession.upsertProject({
    id: projectId,
    scope,
    name: 'Adea',
    groupIds: [],
    repoIds: [repoId],
    repos: [{ repoId, rootBookmarkId: bookmark.id, canonicalRoot: checkout }],
    lifecycle: 'ready',
    version: 1,
  })

  const runtime = registerRepoRuntime({
    authority: { registerCommandProvider() {} },
    dataDir,
    scope,
    validateRootBookmark: (bookmarkId) => ({
      canonicalRoot: roots.validate({ scope, bookmarkId }).canonicalRoot,
    }),
    resolveCredentialRef: (credentialRefId) => {
      const record = vault.get({ scope, credentialRefId })
      return { id: record.id, host: record.host, state: record.state }
    },
    findRepoBindings: (candidate) => projectSession.findRepoBindings(candidate),
  })

  /** Add another project binding for a repo id (import-mints one per
   *  project), possibly naming a canonical root outside the bookmark. */
  function addBinding(
    bindingRepoId: string,
    canonicalRoot: string,
    bindingProjectId = '00000000-0000-4000-8000-000000000021'
  ): void {
    projectSession.upsertProject({
      id: bindingProjectId,
      scope,
      name: 'Extra',
      groupIds: [],
      repoIds: [bindingRepoId],
      repos: [{ repoId: bindingRepoId, rootBookmarkId: bookmark.id, canonicalRoot }],
      lifecycle: 'ready',
      version: 1,
    })
  }

  return {
    root,
    dataDir,
    workspace,
    checkout,
    roots,
    vault,
    verifier,
    credential,
    bookmarkId: bookmark.id,
    runtime,
    addBinding,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type Fixture = ReturnType<typeof fixture>

function provider(
  fix: Fixture,
  operation: DevOperation
): (command: DevCommand) => Promise<unknown> {
  const handler = fix.runtime.providers[operation]
  if (!handler) throw new Error(`provider missing for ${operation}`)
  return handler as (command: DevCommand) => Promise<unknown>
}

function repoCommand(
  operation: DevOperation,
  body: Record<string, unknown>,
  version: number,
  commandScope: Scope = scope
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-0000000000c0',
    nonce: 'test-nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope: commandScope,
    capabilities: [],
    resource: {
      kind: 'repository',
      id: (body.repoId as string) ?? repoId,
      generation: version,
    },
    body,
  } as DevCommand
}

async function adopt(fix: Fixture, version = 1, rootBookmarkId = fix.bookmarkId): Promise<Repo> {
  return (await provider(
    fix,
    'dev.repo.adopt'
  )(
    repoCommand('dev.repo.adopt', { repoId, rootBookmarkId, expectedVersion: version }, version)
  )) as Repo
}

/** Providers may throw synchronously; the thunk normalizes both shapes. */
async function expectCode(run: () => unknown, code: string): Promise<void> {
  try {
    await run()
  } catch (error) {
    const candidate = error as { code?: unknown }
    if (candidate && typeof candidate === 'object' && candidate.code === code) return
    throw new Error(`expected ${code}, got ${String(error)}`, { cause: error })
  }
  throw new Error(`expected refusal ${code}`)
}

describe('repository registry (dev.repo.*)', () => {
  test('adopt proves identity, containment, and canonical git facts durably', async () => {
    const fix = fixture()
    try {
      const repo = await adopt(fix)
      expect(repo.id).toBe(repoId)
      expect(repo.kind).toBe('git')
      expect(repo.lifecycle).toBe('ready')
      expect(repo.version).toBe(1)
      expect(repo.canonicalRoot).toBe(fix.checkout)
      // The remote is redacted. The fixture's origin is a local path, so no
      // host can be proven and it redacts to `unknown` — and no credential
      // material ever reaches the DTO (the URL unit test covers host parsing).
      expect(repo.remote).toBeDefined()
      expect(repo.remote?.host).toBe('unknown')
      expect(repo.remote?.provider).toBe('other')
      expect(JSON.stringify(repo)).not.toContain('secret')
      // origin/HEAD proves the default ref through the local bare remote.
      expect(repo.defaultRef).toBe('refs/heads/main')
      expect(repo.projectIds).toEqual([projectId])
      expect(repo.gitCommonDirIdentity).toBeDefined()

      // The success reply decodes through the strict registry decoder.
      const reply = decodeDevReply({
        schemaVersion: 1,
        operation: 'dev.repo.adopt',
        requestId: '00000000-0000-4000-8000-0000000000c1',
        ok: true,
        value: repo,
        observedAt: new Date().toISOString(),
      })
      expect(reply.ok).toBe(true)
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('adopt refuses an unknown repo, a stale version, and a foreign scope', async () => {
    const fix = fixture()
    try {
      await expectCode(
        () =>
          provider(
            fix,
            'dev.repo.adopt'
          )(
            repoCommand(
              'dev.repo.adopt',
              {
                repoId: '00000000-0000-4000-8000-0000000000aa',
                rootBookmarkId: fix.bookmarkId,
                expectedVersion: 1,
              },
              1
            )
          ),
        'not_found'
      )
      await expectCode(
        () =>
          provider(
            fix,
            'dev.repo.adopt'
          )(
            repoCommand(
              'dev.repo.adopt',
              { repoId, rootBookmarkId: fix.bookmarkId, expectedVersion: 3 },
              3
            )
          ),
        'stale_version'
      )
      await expectCode(
        () =>
          provider(
            fix,
            'dev.repo.adopt'
          )(
            repoCommand(
              'dev.repo.adopt',
              { repoId, rootBookmarkId: fix.bookmarkId, expectedVersion: 1 },
              1,
              foreignScope
            )
          ),
        'unauthorized'
      )
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('adopt refuses a binding outside the authorized root before any write', async () => {
    const fix = fixture()
    try {
      // Import-style binding whose canonical root escaped the bookmark: the
      // containment proof must refuse and leave no durable record behind.
      const escapeId = '00000000-0000-4000-8000-000000000031'
      const outside = mkdtempSync(join(tmpdir(), 'adea-repo-escape-'))
      try {
        fix.addBinding(escapeId, realpathSync(outside))
        await expectCode(
          () =>
            provider(
              fix,
              'dev.repo.adopt'
            )(
              repoCommand(
                'dev.repo.adopt',
                { repoId: escapeId, rootBookmarkId: fix.bookmarkId, expectedVersion: 1 },
                1
              )
            ),
          'unauthorized_root'
        )
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('inspect reports read-only facts and refuses unadopted repos', async () => {
    const fix = fixture()
    try {
      await expectCode(
        () => provider(fix, 'dev.repo.inspect')(repoCommand('dev.repo.inspect', { repoId }, 1)),
        'invalid_state'
      )

      const repo = await adopt(fix)
      const inspection = (await provider(
        fix,
        'dev.repo.inspect'
      )(repoCommand('dev.repo.inspect', { repoId }, repo.version))) as {
        repo: Repo
        headRef?: string
        headSha?: string
        dirty: boolean
      }
      expect(inspection.repo.version).toBe(repo.version)
      expect(inspection.dirty).toBe(false)
      expect(inspection.headRef).toBe('refs/heads/main')
      expect(inspection.headSha).toMatch(/^[0-9a-f]{40}$/)

      // A dirty worktree reports dirty without mutating the record.
      writeFileSync(join(fix.checkout, 'scratch.txt'), 'dirty\n')
      const dirty = (await provider(
        fix,
        'dev.repo.inspect'
      )(repoCommand('dev.repo.inspect', { repoId }, repo.version))) as {
        dirty: boolean
        repo: Repo
      }
      expect(dirty.dirty).toBe(true)
      expect(dirty.repo.version).toBe(repo.version)

      // A stale resource generation refuses at the provider boundary.
      await expectCode(
        () =>
          provider(
            fix,
            'dev.repo.inspect'
          )(repoCommand('dev.repo.inspect', { repoId }, repo.version + 5)),
        'stale_generation'
      )
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('authorize binds a matching credential and refuses foreign hosts', async () => {
    const fix = fixture()
    try {
      // Point origin at github.com so the credential host can match.
      git(fix.checkout, ['config', 'remote.origin.url', 'https://github.com/adea/adea.git'])
      const repo = (await provider(
        fix,
        'dev.repo.authorize'
      )(
        repoCommand(
          'dev.repo.authorize',
          { repoId, credentialRefId: fix.credential.id, expectedVersion: 1 },
          1
        )
      )) as Repo
      expect(repo.lifecycle).toBe('ready')
      expect(repo.remote?.host).toBe('github.com')
      expect(repo.version).toBe(1)

      // A credential bound to another host is an identity mismatch and the
      // record is left untouched.
      const other = fix.vault.enroll({
        scope,
        label: 'GitLab token',
        host: 'gitlab.com',
        kind: 'git_https',
        secret: 'other-secret',
        approval: approval(fix.verifier, 'enroll a credential'),
      })
      await expectCode(
        () =>
          provider(
            fix,
            'dev.repo.authorize'
          )(
            repoCommand(
              'dev.repo.authorize',
              { repoId, credentialRefId: other.id, expectedVersion: repo.version },
              repo.version
            )
          ),
        'identity_mismatch'
      )

      // An unknown credential reference refuses.
      await expectCode(
        () =>
          provider(
            fix,
            'dev.repo.authorize'
          )(
            repoCommand(
              'dev.repo.authorize',
              {
                repoId,
                credentialRefId: '00000000-0000-4000-8000-0000000000bb',
                expectedVersion: repo.version,
              },
              repo.version
            )
          ),
        'not_found'
      )
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('refresh re-proves a reachable remote and degrades to stale offline', async () => {
    const fix = fixture()
    try {
      const adopted = await adopt(fix)
      // The local bare origin is reachable: refresh stays ready, and since
      // no fact moved, the version does not advance.
      const unchanged = (await provider(
        fix,
        'dev.repo.refresh'
      )(
        repoCommand(
          'dev.repo.refresh',
          { repoId, expectedVersion: adopted.version },
          adopted.version
        )
      )) as Repo
      expect(unchanged.lifecycle).toBe('ready')
      expect(unchanged.version).toBe(adopted.version)

      // Point origin at an unreachable path: the probe fails typed and the
      // durable record degrades to `stale` (version bump, still truthful).
      git(fix.checkout, [
        'config',
        'remote.origin.url',
        'file:///adea-repo-registry-unreachable.git',
      ])
      const stale = (await provider(
        fix,
        'dev.repo.refresh'
      )(
        repoCommand(
          'dev.repo.refresh',
          { repoId, expectedVersion: unchanged.version },
          unchanged.version
        )
      )) as Repo
      expect(stale.lifecycle).toBe('stale')
      expect(stale.version).toBe(unchanged.version + 1)

      // A stale version refuses before the record is touched.
      await expectCode(
        () =>
          provider(
            fix,
            'dev.repo.refresh'
          )(repoCommand('dev.repo.refresh', { repoId, expectedVersion: 99 }, 99)),
        'stale_version'
      )
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('refresh marks the record unavailable when the checkout vanishes', async () => {
    const fix = fixture()
    try {
      const adopted = await adopt(fix)
      rmSync(fix.checkout, { recursive: true, force: true })
      const unavailable = (await provider(
        fix,
        'dev.repo.refresh'
      )(
        repoCommand(
          'dev.repo.refresh',
          { repoId, expectedVersion: adopted.version },
          adopted.version
        )
      )) as Repo
      expect(unavailable.lifecycle).toBe('unavailable')
      // Inspect now reports the same truth read-only.
      const inspection = (await provider(
        fix,
        'dev.repo.inspect'
      )(repoCommand('dev.repo.inspect', { repoId }, unavailable.version))) as {
        repo: Repo
        dirty: boolean
      }
      expect(inspection.repo.lifecycle).toBe('unavailable')
      expect(inspection.dirty).toBe(false)
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('redacted remotes preserve namespace paths and parse scp-like urls', () => {
    expect(redactRemoteUrl('https://user:token@github.com/adea/adea.git')).toEqual({
      provider: 'github',
      host: 'github.com',
      ownerPath: 'adea/adea',
      displayUrl: 'https://github.com/adea/adea',
    })
    expect(redactRemoteUrl('git@gitlab.com:group/sub/repo.git')).toEqual({
      provider: 'gitlab',
      host: 'gitlab.com',
      ownerPath: 'group/sub/repo',
      displayUrl: 'gitlab.com:group/sub/repo',
    })
    expect(redactRemoteUrl('https://git.example.com/adea.git').provider).toBe('other')
    // A hostless URL redacts to an `unknown` host instead of fabricating one.
    expect(redactRemoteUrl('file:///adea/unreachable.git').host).toBe('unknown')
  })
})
