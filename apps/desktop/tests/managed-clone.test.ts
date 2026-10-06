// Remote-only projects (ADR 0011, PR 15): `dev.project.clone` places a
// managed bare clone in owner-only app data, registers it with
// `layout: 'bare_managed'`, and binds it with NO primary worktree record.
// Every suite clones from a local bare "origin" over `file://` — no network.
import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DevCommand, Project, Scope } from '../../../packages/types/src/dev-runtime'
import { decodeDevReply } from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier, type OwnerApproval } from '../shell/src/dev-runtime/authority'
import { registerProjectSessionRuntime } from '../shell/src/dev-runtime/project-session/register'
import {
  admitCloneRemote,
  createManagedCloneAuthority,
} from '../shell/src/dev-runtime/projects/clone'
import {
  ensureManagedWorktreeBase,
  MANAGED_REPOS_DIR,
  proveManagedBareRepo,
} from '../shell/src/dev-runtime/repos/managed'
import { createRepoRegistryStore } from '../shell/src/dev-runtime/repos/registry-store'
import { registerRepoRuntime } from '../shell/src/dev-runtime/repos/register'
import { createRootBookmarkAuthority } from '../shell/src/dev-runtime/roots'
import { createCredentialVault, createInMemoryVaultKeyStore } from '../shell/src/dev-runtime/vault'
import { createWorktreeService } from '../shell/src/dev-runtime/worktrees/service'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const projectId = '00000000-0000-4000-8000-0000000000c1'
const otherProjectId = '00000000-0000-4000-8000-0000000000c2'

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

/** A local bare "origin" with one commit on `main` (plus a `.worktreeinclude`
 *  so the include-copy skip is observable). */
function initOrigin(root: string): string {
  const origin = join(root, 'origin.git')
  mkdirSync(origin)
  git(origin, ['init', '--bare', '-b', 'main'])
  const seed = join(root, 'seed')
  mkdirSync(seed)
  git(seed, ['init', '-b', 'main'])
  git(seed, ['config', 'core.hooksPath', '/dev/null'])
  writeFileSync(join(seed, 'README.md'), '# remote only\n')
  writeFileSync(join(seed, '.worktreeinclude'), '.env.local\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-m', 'initial'])
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', 'origin', 'main'])
  return realpathSync(origin)
}

let consentSequence = 0
function fixture(options: { limits?: { timeoutMs?: number; maxBytes?: number } } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adea-managed-clone-')))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { mode: 0o700 })
  const origin = initOrigin(root)
  const verifier = createOwnerApprovalVerifier({ dataDir })
  const approval = (action: string): OwnerApproval => {
    const consent: OwnerApproval = {
      method: 'owner_dialog',
      reference: `managed-clone-consent-${++consentSequence}`,
      scope,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    verifier.recordIssuance(consent, scope, action)
    return consent
  }
  const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
  const vault = createCredentialVault({
    dataDir,
    approvalVerifier: verifier,
    credentialStore: createInMemoryVaultKeyStore(),
  })
  const credential = vault.enroll({
    scope,
    label: 'GitHub token',
    host: 'github.com',
    kind: 'github_token',
    secret: 'secret-token-value',
    approval: approval('enroll a credential'),
  })
  const service = createWorktreeService({ dataDir, runtimeNodeId: scope.runtimeNodeId, roots })
  const providers = new Map<string, (command: DevCommand) => unknown>()
  const authority = {
    registerCommandProvider(operation: string, provider: (command: DevCommand) => unknown) {
      providers.set(operation, provider)
    },
  }
  const clones = createManagedCloneAuthority({
    dataDir,
    scope,
    worktreeService: service,
    ...(options.limits ? { limits: options.limits } : {}),
  })
  const projectSession = registerProjectSessionRuntime({
    authority,
    dataDir,
    scope,
    managedUnbind: clones.prepareUnbind,
  })
  clones.registerCloneProvider({
    authority,
    projectSession,
    resolveCredentialRef: (credentialRefId) => {
      const record = vault.get({ scope, credentialRefId })
      return { id: record.id, host: record.host, state: record.state }
    },
  })
  const managedRoot = join(realpathSync(dataDir), MANAGED_REPOS_DIR)
  return {
    root,
    dataDir,
    origin,
    service,
    roots,
    credential,
    managedRoot,
    registry: createRepoRegistryStore(dataDir),
    projectSession,
    run(operation: string, body: Record<string, unknown>, resource?: DevCommand['resource']) {
      const provider = providers.get(operation)
      if (!provider) throw new Error(`no provider for ${operation}`)
      return Promise.resolve(provider(command(operation, body, resource)))
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function command(
  operation: string,
  body: Record<string, unknown>,
  resource?: DevCommand['resource']
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-0000000000d0',
    nonce: 'test-nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope,
    capabilities: [],
    ...(resource ? { resource } : {}),
    body,
  } as DevCommand
}

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return String((error as { code?: unknown }).code ?? error)
  }
  return 'no refusal'
}

type Fixture = ReturnType<typeof fixture>

async function cloneProject(f: Fixture, body: Record<string, unknown> = {}): Promise<Project> {
  const reply = await f.run('dev.project.clone', {
    projectId,
    remoteUrl: `file://${f.origin}`,
    mode: 'managed',
    ...body,
  })
  // The success reply decodes through the strict `Project` decoder.
  const decoded = decodeDevReply({
    schemaVersion: 1,
    operation: 'dev.project.clone',
    requestId: '00000000-0000-4000-8000-0000000000d1',
    ok: true,
    value: reply,
    observedAt: new Date().toISOString(),
  })
  if (!decoded.ok) throw new Error('clone reply did not decode')
  return decoded.value as Project
}

function managedRepo(f: Fixture) {
  const records = f.registry.load()
  expect(records).toHaveLength(1)
  return records[0]!
}

describe('dev.project.clone (remote-only projects)', () => {
  test('clones --bare into the owner-only managed root with no primary record', async () => {
    const f = fixture()
    try {
      const project = await cloneProject(f)
      const repo = managedRepo(f)
      expect(repo).toMatchObject({
        kind: 'git',
        layout: 'bare_managed',
        lifecycle: 'ready',
        canonicalRoot: join(f.managedRoot, `${repo.id}.git`),
        fetchRemote: 'origin',
        defaultRef: 'refs/heads/main',
        projectIds: [projectId],
        version: 1,
      })
      expect(repo.rootBookmarkId).toBeUndefined()
      // The binding names the managed clone and no bookmark.
      expect(project).toMatchObject({
        id: projectId,
        repoIds: [repo.id],
        repos: [{ repoId: repo.id, canonicalRoot: repo.canonicalRoot, layout: 'bare_managed' }],
        defaultBaseRef: 'origin/main',
        lifecycle: 'ready',
      })
      // Owner-only on disk, bare, with remote-tracking refs for worktrees.
      expect(lstatSync(f.managedRoot).mode & 0o777).toBe(0o700)
      expect(lstatSync(repo.canonicalRoot).mode & 0o777).toBe(0o700)
      expect(git(repo.canonicalRoot, ['config', '--bool', 'core.bare']).stdout.trim()).toBe('true')
      expect(
        git(repo.canonicalRoot, ['rev-parse', '--verify', 'refs/remotes/origin/main']).code
      ).toBe(0)
      expect(existsSync(join(repo.canonicalRoot, '.git'))).toBe(false)
      // No primary checkout: a remote-only project has worktrees only.
      expect(f.service.listWorktrees({ scope, repoId: repo.id })).toHaveLength(0)
      expect(await f.service.ensurePrimaryWorktree({ scope, repoId: repo.id })).toBeUndefined()
      expect(f.service.listWorktrees({ scope, repoId: repo.id })).toHaveLength(0)
      // Nothing is left behind in the managed root but the clone itself.
      expect(readdirSync(f.managedRoot)).toEqual([`${repo.id}.git`])
      expect(
        await proveManagedBareRepo({
          dataDir: f.dataDir,
          canonicalRoot: repo.canonicalRoot,
          repoId: repo.id,
          expectedIdentity: repo.rootIdentity,
        })
      ).toMatchObject({ device: repo.rootIdentity.device, inode: repo.rootIdentity.inode })
    } finally {
      f.cleanup()
    }
  })

  test('creates, lists, and cleans managed worktrees under the managed worktree root', async () => {
    const f = fixture()
    try {
      await cloneProject(f)
      const repo = managedRepo(f)
      const base = ensureManagedWorktreeBase(f.dataDir, repo.id)
      expect(base).toBe(join(realpathSync(f.dataDir), 'dev-runtime', 'managed-worktrees', repo.id))
      expect(lstatSync(base).mode & 0o777).toBe(0o700)

      // A base dir anywhere else is refused, even an authorized-looking one.
      const elsewhere = join(f.root, 'elsewhere')
      mkdirSync(elsewhere)
      expect(
        await codeOf(() =>
          f.service.createWorktree({
            scope,
            repoId: repo.id,
            projectId,
            baseRef: 'origin/main',
            worktreeBaseDir: elsewhere,
          })
        )
      ).toBe('unauthorized_root')

      const created = await f.service.createWorktree({
        scope,
        repoId: repo.id,
        projectId,
        baseRef: 'origin/main',
        worktreeBaseDir: base,
        includeApprovals: ['.env.local'],
      })
      const worktree = created.worktree
      expect(worktree.kind).toBe('managed')
      expect(worktree.canonicalRoot).toBe(join(base, created.name))
      expect(existsSync(join(worktree.canonicalRoot, 'README.md'))).toBe(true)
      // No primary working tree: include copy is reported as skipped.
      expect(created.includeCopy).toEqual({ copied: [], skipped: 'no_primary_working_tree' })
      expect(f.service.listWorktrees({ scope, repoId: repo.id }).map((entry) => entry.id)).toEqual([
        worktree.id,
      ])
      // Discovery handles the bare common dir (the bare entry plus ours).
      expect((await f.service.refreshRepo({ scope, repoId: repo.id })).degraded).toBe(false)

      git(repo.canonicalRoot, ['branch', '--set-upstream-to=origin/main', `adea/${created.name}`])
      const lease = f.service.leases.list(worktree.id)[0]!
      f.service.leases.release({ scope, worktreeId: worktree.id, leaseId: lease.lease.id })
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: worktree.id,
        expectedGeneration: worktree.generation,
        selectedSteps: ['quarantine_worktree', 'unregister_worktree', 'delete_quarantine'],
      })
      expect(plan.blockers).toHaveLength(0)
      const result = await f.service.commitCleanup({ scope, plan, digest: plan.digest })
      expect(result.state).toBe('completed')
      expect(existsSync(worktree.canonicalRoot)).toBe(false)
      expect(git(repo.canonicalRoot, ['worktree', 'list', '--porcelain']).stdout).not.toContain(
        worktree.canonicalRoot
      )
      // The bare clone itself is untouched by worktree cleanup.
      expect(existsSync(join(repo.canonicalRoot, 'HEAD'))).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  test('unbind refuses while a worktree is live, then quarantines and deletes the clone', async () => {
    const f = fixture()
    try {
      const project = await cloneProject(f)
      const repo = managedRepo(f)
      const created = await f.service.createWorktree({
        scope,
        repoId: repo.id,
        projectId,
        baseRef: 'origin/main',
        worktreeBaseDir: ensureManagedWorktreeBase(f.dataDir, repo.id),
      })
      const resource = { kind: 'project', id: projectId, generation: project.version } as const
      const unbind = () =>
        f.run('dev.project.unbind', { projectId, expectedVersion: project.version }, resource)

      // Ordering: the clone outlives every worktree; nothing moves on refusal.
      expect(await codeOf(unbind)).toBe('cleanup_blocked')
      expect(existsSync(repo.canonicalRoot)).toBe(true)
      expect(existsSync(created.worktree.canonicalRoot)).toBe(true)
      expect(await f.run('dev.project.list', {})).toMatchObject({ items: [{ id: projectId }] })

      git(repo.canonicalRoot, ['branch', '--set-upstream-to=origin/main', `adea/${created.name}`])
      const lease = f.service.leases.list(created.worktree.id)[0]!
      f.service.leases.release({ scope, worktreeId: created.worktree.id, leaseId: lease.lease.id })
      const plan = await f.service.planCleanup({
        scope,
        worktreeId: created.worktree.id,
        expectedGeneration: created.worktree.generation,
        selectedSteps: ['quarantine_worktree', 'unregister_worktree', 'delete_quarantine'],
      })
      await f.service.commitCleanup({ scope, plan, digest: plan.digest })

      expect(await unbind()).toMatchObject({ id: projectId })
      expect(existsSync(repo.canonicalRoot)).toBe(false)
      expect(f.registry.load()).toHaveLength(0)
      expect(await f.run('dev.project.list', {})).toMatchObject({ items: [] })
      // Only the empty owner-only trash root remains in the managed root.
      const left = readdirSync(f.managedRoot)
      expect(left.filter((name) => name !== '.adea-worktree-trash')).toEqual([])
      expect(readdirSync(join(f.managedRoot, '.adea-worktree-trash'))).toEqual([])
    } finally {
      f.cleanup()
    }
  })

  test('unbind of a replaced clone refuses and keeps the binding', async () => {
    const f = fixture()
    try {
      const project = await cloneProject(f)
      const repo = managedRepo(f)
      // Swap the directory for a different bare repo at the same path.
      renameSync(repo.canonicalRoot, `${repo.canonicalRoot}-moved`)
      mkdirSync(repo.canonicalRoot, { mode: 0o700 })
      git(repo.canonicalRoot, ['init', '--bare'])
      chmodSync(repo.canonicalRoot, 0o700)
      const resource = { kind: 'project', id: projectId, generation: project.version } as const
      expect(
        await codeOf(() =>
          f.run('dev.project.unbind', { projectId, expectedVersion: project.version }, resource)
        )
      ).toBe('identity_mismatch')
      expect(existsSync(join(repo.canonicalRoot, 'HEAD'))).toBe(true)
      expect(await f.run('dev.project.list', {})).toMatchObject({ items: [{ id: projectId }] })
    } finally {
      f.cleanup()
    }
  })

  test('refuses unsafe remotes, mismatched credentials, and bound project ids before cloning', async () => {
    const f = fixture()
    try {
      for (const remoteUrl of [
        'http://example.com/repo.git',
        'ext::sh -c touch% /tmp/pwned',
        '-uhelp',
        'https://token@github.com/owner/repo.git',
        'https://user:secret@github.com/owner/repo.git',
        '/absolute/path/repo.git',
        'git@github.com:owner/repo.git --upload-pack=evil',
      ])
        expect(
          await codeOf(() => f.run('dev.project.clone', { projectId, remoteUrl, mode: 'managed' }))
        ).toBe('invalid_state')
      expect(admitCloneRemote('git@github.com:owner/repo.git')).toBe('ssh')
      expect(admitCloneRemote('ssh://git@github.com/owner/repo.git')).toBe('ssh')
      expect(admitCloneRemote('https://github.com/owner/repo.git')).toBe('https')

      // The credential host must equal the remote host; unknown refs refuse.
      expect(
        await codeOf(() =>
          f.run('dev.project.clone', {
            projectId,
            remoteUrl: 'https://gitlab.com/owner/repo.git',
            mode: 'managed',
            credentialRefId: f.credential.id,
          })
        )
      ).toBe('identity_mismatch')
      expect(
        await codeOf(() =>
          f.run('dev.project.clone', {
            projectId,
            remoteUrl: 'https://github.com/owner/repo.git',
            mode: 'managed',
            credentialRefId: '00000000-0000-4000-8000-0000000000ff',
          })
        )
      ).toBe('not_found')
      // The decoder refuses any other mode and a resource binding refuses.
      expect(
        await codeOf(() =>
          f.run('dev.project.clone', { projectId, remoteUrl: `file://${f.origin}`, mode: 'mirror' })
        )
      ).not.toBe('no refusal')
      expect(
        await codeOf(() =>
          f.run(
            'dev.project.clone',
            { projectId, remoteUrl: `file://${f.origin}`, mode: 'managed' },
            { kind: 'project', id: projectId, generation: 1 }
          )
        )
      ).toBe('identity_mismatch')
      // Nothing was created for any refusal.
      expect(existsSync(f.managedRoot)).toBe(false)

      await cloneProject(f)
      expect(await codeOf(() => cloneProject(f))).toBe('identity_mismatch')
      expect(f.registry.load()).toHaveLength(1)
    } finally {
      f.cleanup()
    }
  })

  test('typed transport, size, and base-ref failures leave no clone behind', async () => {
    const f = fixture()
    try {
      expect(
        await codeOf(() =>
          f.run('dev.project.clone', {
            projectId,
            remoteUrl: `file://${join(f.root, 'missing.git')}`,
            mode: 'managed',
          })
        )
      ).toMatch(/^(not_found|remote_unavailable)$/)
      expect(
        await codeOf(() => cloneProject(f, { defaultBaseRef: 'refs/heads/does-not-exist' }))
      ).toBe('base_not_found')
      const leftovers = readdirSync(f.managedRoot).filter((name) => name !== '.adea-worktree-trash')
      expect(leftovers).toEqual([])
      expect(f.registry.load()).toHaveLength(0)
      expect(await f.run('dev.project.list', {})).toMatchObject({ items: [] })
    } finally {
      f.cleanup()
    }

    const small = fixture({ limits: { maxBytes: 1 } })
    try {
      expect(await codeOf(() => cloneProject(small))).toBe('limit_exceeded')
      expect(
        readdirSync(small.managedRoot).filter((name) => name !== '.adea-worktree-trash')
      ).toEqual([])
      expect(small.registry.load()).toHaveLength(0)
    } finally {
      small.cleanup()
    }

    // The wall-clock budget kills the clone and types the failure.
    const slow = fixture({ limits: { timeoutMs: 1 } })
    try {
      expect(await codeOf(() => cloneProject(slow))).toBe('timeout')
      expect(
        readdirSync(slow.managedRoot).filter((name) => name !== '.adea-worktree-trash')
      ).toEqual([])
    } finally {
      slow.cleanup()
    }
  })
})

describe('the repository registry proves managed clones without a bookmark', () => {
  test('adopt refuses; inspect/refresh run the managed proof and keep the layout', async () => {
    const f = fixture()
    try {
      await cloneProject(f)
      const repo = managedRepo(f)
      const runtime = registerRepoRuntime({
        authority: { registerCommandProvider() {} },
        dataDir: f.dataDir,
        scope,
        validateRootBookmark: () => {
          throw new Error('a managed clone never resolves a bookmark')
        },
        resolveCredentialRef: () => {
          throw new Error('no credential is used here')
        },
        findRepoBindings: (candidate) => f.projectSession.findRepoBindings(candidate),
      })
      const call = (operation: string, body: Record<string, unknown>, version: number) =>
        Promise.resolve(
          (runtime.providers as Record<string, (command: DevCommand) => unknown>)[operation]!(
            command(operation, body, { kind: 'repository', id: repo.id, generation: version })
          )
        )
      // Managed bindings are not bookmark bindings.
      expect(f.projectSession.findRepoBindings(repo.id)).toEqual([])
      expect(
        await codeOf(() =>
          call(
            'dev.repo.adopt',
            { repoId: repo.id, rootBookmarkId: projectId, expectedVersion: 1 },
            1
          )
        )
      ).toBe('invalid_state')
      const inspected = (await call('dev.repo.inspect', { repoId: repo.id, refresh: true }, 1)) as {
        repo: { layout?: string; kind: string }
      }
      expect(inspected.repo).toMatchObject({ kind: 'git', layout: 'bare_managed' })
      const refreshed = (await call(
        'dev.repo.refresh',
        { repoId: repo.id, expectedVersion: 1 },
        1
      )) as { layout?: string; lifecycle: string }
      expect(refreshed).toMatchObject({ layout: 'bare_managed', lifecycle: 'ready' })
      expect(managedRepo(f).rootBookmarkId).toBeUndefined()
      // A replaced clone fails the managed proof instead of being re-adopted.
      renameSync(repo.canonicalRoot, `${repo.canonicalRoot}-moved`)
      mkdirSync(repo.canonicalRoot, { mode: 0o700 })
      git(repo.canonicalRoot, ['init', '--bare'])
      chmodSync(repo.canonicalRoot, 0o700)
      const version = managedRepo(f).version
      expect(
        await codeOf(() =>
          call('dev.repo.refresh', { repoId: repo.id, expectedVersion: version }, version)
        )
      ).toBe('identity_mismatch')
    } finally {
      f.cleanup()
    }
  })
})

describe('bare repositories outside the managed layout stay refused', () => {
  test('a user bare repository is never registered or used', async () => {
    const f = fixture()
    try {
      const workspace = join(f.root, 'workspace')
      mkdirSync(workspace)
      const verifier = createOwnerApprovalVerifier({ dataDir: f.dataDir })
      const roots = createRootBookmarkAuthority({ dataDir: f.dataDir, approvalVerifier: verifier })
      const consent: OwnerApproval = {
        method: 'owner_dialog',
        reference: `managed-clone-consent-${++consentSequence}`,
        scope,
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      verifier.recordIssuance(consent, scope, 'authorize a root bookmark')
      const bookmark = roots.mint({
        scope,
        label: 'Workspace',
        kind: 'directory',
        absolutePath: workspace,
        approval: consent,
      })
      const service = createWorktreeService({
        dataDir: f.dataDir,
        runtimeNodeId: scope.runtimeNodeId,
        roots,
      })
      const userBare = join(workspace, 'user.git')
      mkdirSync(userBare)
      git(userBare, ['init', '--bare'])
      expect(
        await codeOf(() =>
          service.registerRepo({
            scope,
            projectId: otherProjectId,
            absolutePath: userBare,
            bookmarkId: bookmark.id,
          })
        )
      ).toBe('not_git_repo')
    } finally {
      f.cleanup()
    }
  })

  test('a forged bare_managed record outside the managed root is refused', async () => {
    const f = fixture()
    try {
      await cloneProject(f)
      const repo = managedRepo(f)
      const forgedRoot = join(f.root, 'forged.git')
      mkdirSync(forgedRoot, { mode: 0o700 })
      git(forgedRoot, ['init', '--bare'])
      chmodSync(forgedRoot, 0o700)
      const forgedId = '00000000-0000-4000-8000-0000000000e1'
      const identity = lstatSync(forgedRoot, { bigint: true })
      f.registry.upsert({
        ...repo,
        id: forgedId,
        canonicalRoot: forgedRoot,
        rootIdentity: {
          device: String(identity.dev),
          inode: String(identity.ino),
          mtimeNs: '0',
          size: '0',
        },
        projectIds: [otherProjectId],
      })
      expect(
        await codeOf(() =>
          f.service.createWorktree({
            scope,
            repoId: forgedId,
            projectId: otherProjectId,
            baseRef: 'HEAD',
            worktreeBaseDir: ensureManagedWorktreeBase(f.dataDir, forgedId),
          })
        )
      ).toBe('unauthorized_root')
      // A bare repo planted inside the managed root under a non-managed name
      // refuses too, as does an escape spelling through `..`.
      for (const canonicalRoot of [
        join(f.managedRoot, 'planted.git'),
        join(f.managedRoot, '..', `${forgedId}.git`),
      ])
        expect(
          await codeOf(() => proveManagedBareRepo({ dataDir: f.dataDir, canonicalRoot }))
        ).toMatch(/^(unauthorized_root|path_escape)$/)
    } finally {
      f.cleanup()
    }
  })

  test('symlinked or widened managed roots and symlinked clones fail closed', async () => {
    const f = fixture()
    try {
      await cloneProject(f)
      const repo = managedRepo(f)
      const proof = () =>
        proveManagedBareRepo({
          dataDir: f.dataDir,
          canonicalRoot: repo.canonicalRoot,
          repoId: repo.id,
          expectedIdentity: repo.rootIdentity,
        })

      // A group/other-readable managed root is not owner-only.
      chmodSync(f.managedRoot, 0o755)
      expect(await codeOf(proof)).toBe('dangerous_path')
      chmodSync(f.managedRoot, 0o700)
      expect(await codeOf(proof)).toBe('no refusal')

      // The clone replaced by a symlink to a bare repo elsewhere.
      const outside = join(f.root, 'outside.git')
      renameSync(repo.canonicalRoot, outside)
      symlinkSync(outside, repo.canonicalRoot)
      expect(await codeOf(proof)).toBe('symlink_rejected')
      rmSync(repo.canonicalRoot)
      renameSync(outside, repo.canonicalRoot)
      expect(await codeOf(proof)).toBe('no refusal')

      // The managed root itself swapped for a symlink.
      const realRoot = `${f.managedRoot}-real`
      renameSync(f.managedRoot, realRoot)
      symlinkSync(realRoot, f.managedRoot)
      expect(await codeOf(proof)).toBe('dangerous_path')
      expect(
        await codeOf(() =>
          f.service.createWorktree({
            scope,
            repoId: repo.id,
            projectId,
            baseRef: 'origin/main',
            worktreeBaseDir: ensureManagedWorktreeBase(f.dataDir, repo.id),
          })
        )
      ).toBe('dangerous_path')
    } finally {
      f.cleanup()
    }
  })
})
