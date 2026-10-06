// Auto-adopt (owner request): a project bound by import or creation joins
// the repository registry without the manual Repositories-panel Adopt step.
// Covers the policy unit (archived exclusion, best-effort failure fallback,
// fire-and-forget ordering), the registry seam (`adoptUnadopted` reuses the
// exact `dev.repo.adopt` proof; an existing record is left untouched, so no
// re-adopt loop), and the project register's `onProjectBound` hook (fires
// once per binding event, contains a synchronous throw, never blocks the
// reply). Removal semantics are covered in repo-registry.test.ts.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  DevCommand,
  DevOperation,
  Project,
  Repo,
  Scope,
} from '../../../packages/types/src/dev-runtime'
import {
  createOwnerApprovalVerifier,
  type OwnerApproval,
  type OwnerApprovalVerifier,
} from '../shell/src/dev-runtime/authority'
import { registerProjectSessionRuntime } from '../shell/src/dev-runtime/project-session/register'
import { autoAdoptBindings } from '../shell/src/dev-runtime/repos/auto-adopt'
import { registerRepoRuntime } from '../shell/src/dev-runtime/repos/register'
import { createRootBookmarkAuthority } from '../shell/src/dev-runtime/roots'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

let consentSequence = 0
function approval(verifier: OwnerApprovalVerifier, action: string): OwnerApproval {
  const consent: OwnerApproval = {
    method: 'owner_dialog',
    reference: `auto-adopt-consent-${++consentSequence}`,
    scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  verifier.recordIssuance(consent, scope, action)
  return consent
}

function git(dir: string, args: string[]): void {
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
  if ((proc.exitCode ?? 0) !== 0) throw new Error(`git ${args.join(' ')} failed`)
}

function command(
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-0000000000c0',
    nonce: 'test-nonce',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope,
    capabilities: [],
    ...(resource ? { resource } : {}),
    body,
  } as DevCommand
}

/** Providers may throw synchronously; the thunk normalizes both shapes. */
async function errorCode(run: () => unknown): Promise<string | undefined> {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('auto-adopt policy (archived exclusion, best-effort, non-blocking)', () => {
  test('an archived project is ignored entirely: no adoption is attempted', () => {
    const attempted: string[] = []
    autoAdoptBindings({ lifecycle: 'archived', repoIds: ['r1', 'r2'] }, async (repoId) => {
      attempted.push(repoId)
    })
    expect(attempted).toEqual([])
  })

  test('a refused adoption never stops the remaining bindings, and nothing throws', async () => {
    const attempted: string[] = []
    autoAdoptBindings({ lifecycle: 'ready', repoIds: ['r1', 'r2', 'r3'] }, async (repoId) => {
      attempted.push(repoId)
      if (repoId === 'r1') throw new Error('vanished checkout')
    })
    // The work is fire-and-forget: give the microtask queue a beat.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(attempted).toEqual(['r1', 'r2', 'r3'])
  })

  test('a slow adoption cannot block the caller: the function returns at once', () => {
    let release: (() => void) | undefined
    const hung = new Promise(() => {
      release = () => {}
    })
    const started = Date.now()
    autoAdoptBindings({ lifecycle: 'ready', repoIds: ['r1'] }, () => hung)
    expect(Date.now() - started).toBeLessThan(1_000)
    release?.()
  })
})

describe('adoptUnadopted seam (the exact dev.repo.adopt proof, no fork)', () => {
  function seamFixture() {
    const root = mkdtempSync(join(tmpdir(), 'adea-auto-adopt-'))
    const dataDir = join(root, 'data')
    const workspace = realpathSync(mkdtempSync(join(root, 'ws-')))
    const checkout = join(workspace, 'app')
    mkdirSync(checkout)
    git(checkout, ['init', '-b', 'main'])
    git(checkout, ['config', 'core.hooksPath', '/dev/null'])
    writeFileSync(join(checkout, 'README.md'), '# fixture\n')
    git(checkout, ['add', '.'])
    git(checkout, ['commit', '-m', 'initial'])

    const verifier = createOwnerApprovalVerifier({ dataDir })
    const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
    // The bookmark names the checkout itself: an import binds the bookmark's
    // canonical root, so the proven kind must be a git repository.
    const bookmark = roots.mint({
      scope,
      label: 'Checkout',
      kind: 'repository',
      absolutePath: checkout,
      approval: approval(verifier, 'authorize a root bookmark'),
    })

    const projectSession = registerProjectSessionRuntime({
      authority: { registerCommandProvider() {} },
      dataDir,
      scope,
      resolveImportRoot: (bookmarkId) => ({
        canonicalRoot: roots.validate({ scope, bookmarkId }).canonicalRoot,
      }),
    })
    const importProvider = projectSession.providers['dev.project.import']! as (
      command: DevCommand
    ) => Project
    const bindProject = (projectId: string): Project =>
      importProvider(command('dev.project.import', { projectId, rootBookmarkId: bookmark.id }))

    const runtime = registerRepoRuntime({
      authority: { registerCommandProvider() {} },
      dataDir,
      scope,
      validateRootBookmark: (bookmarkId) => ({
        canonicalRoot: roots.validate({ scope, bookmarkId }).canonicalRoot,
      }),
      resolveCredentialRef: () => {
        throw new Error('no credentials in this fixture')
      },
      findRepoBindings: (repoId) => projectSession.findRepoBindings(repoId),
    })

    return {
      root,
      checkout,
      bookmarkId: bookmark.id,
      projectSession,
      runtime,
      bindProject,
      listRepos(): readonly Repo[] {
        const list = runtime.providers['dev.repo.list']! as (command: DevCommand) => {
          items: Repo[]
        }
        return list(command('dev.repo.list', {})).items
      },
      cleanup() {
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  test('an import-minted binding adopts at version 1 without a manual command', async () => {
    const fix = seamFixture()
    try {
      const project = fix.bindProject('00000000-0000-4000-8000-0000000000a1')
      const repoId = project.repoIds[0]!
      const adopted = await fix.runtime.adoptUnadopted(repoId)
      expect(adopted).toBeDefined()
      expect(adopted?.id).toBe(repoId)
      expect(adopted?.kind).toBe('git')
      expect(adopted?.lifecycle).toBe('ready')
      expect(adopted?.version).toBe(1)
      expect(adopted?.canonicalRoot).toBe(fix.checkout)
      // The list now serves the record: the sidebar's provider rows can join it.
      expect(fix.listRepos().map((entry) => entry.id)).toEqual([repoId])
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('a repository with a durable record is left untouched: no re-proof, no version bump', async () => {
    const fix = seamFixture()
    try {
      const project = fix.bindProject('00000000-0000-4000-8000-0000000000a2')
      const repoId = project.repoIds[0]!
      const first = await fix.runtime.adoptUnadopted(repoId)
      expect(first?.version).toBe(1)
      const second = await fix.runtime.adoptUnadopted(repoId)
      expect(second).toBeUndefined()
      expect(fix.listRepos()).toHaveLength(1)
      expect(fix.listRepos()[0]?.version).toBe(1)
    } finally {
      fix.cleanup()
    }
  }, 60_000)

  test('a bound id with no binding refuses not_found (the honest fallback)', async () => {
    const fix = seamFixture()
    try {
      const code = await errorCode(() =>
        fix.runtime.adoptUnadopted('00000000-0000-4000-8000-0000000000a3')
      )
      expect(code).toBe('not_found')
      expect(fix.listRepos()).toHaveLength(0)
    } finally {
      fix.cleanup()
    }
  }, 60_000)
})

describe('onProjectBound hook (one fire per binding event, never blocking)', () => {
  function hookFixture(onProjectBound: (project: Project) => void) {
    const root = mkdtempSync(join(tmpdir(), 'adea-auto-adopt-hook-'))
    const dataDir = join(root, 'data')
    const workspace = realpathSync(mkdtempSync(join(root, 'ws-')))
    const checkout = join(workspace, 'app')
    mkdirSync(checkout)
    git(checkout, ['init', '-b', 'main'])
    git(checkout, ['config', 'core.hooksPath', '/dev/null'])
    writeFileSync(join(checkout, 'README.md'), '# fixture\n')
    git(checkout, ['add', '.'])
    git(checkout, ['commit', '-m', 'initial'])

    const verifier = createOwnerApprovalVerifier({ dataDir })
    const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
    const bookmark = roots.mint({
      scope,
      label: 'Workspace',
      kind: 'repository',
      absolutePath: workspace,
      approval: approval(verifier, 'authorize a root bookmark'),
    })
    const projectSession = registerProjectSessionRuntime({
      authority: { registerCommandProvider() {} },
      dataDir,
      scope,
      resolveImportRoot: (bookmarkId) => ({
        canonicalRoot: roots.validate({ scope, bookmarkId }).canonicalRoot,
      }),
      onProjectBound,
    })
    return {
      root,
      bookmarkId: bookmark.id,
      projectSession,
      cleanup() {
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  test('import fires the hook once with the projected project and its minted binding', () => {
    const seen: Project[] = []
    const fix = hookFixture((project) => seen.push(project))
    try {
      const project = fix.projectSession.providers['dev.project.import']! as (
        command: DevCommand
      ) => Project
      const imported = project(
        command('dev.project.import', {
          projectId: '00000000-0000-4000-8000-0000000000b1',
          rootBookmarkId: fix.bookmarkId,
        })
      )
      expect(seen).toEqual([imported])
      expect(seen[0]?.repoIds).toHaveLength(1)
      expect(seen[0]?.lifecycle).toBe('ready')
    } finally {
      fix.cleanup()
    }
  })

  test('create fires the hook with the bound repo ids', () => {
    const seen: Project[] = []
    const fix = hookFixture((project) => seen.push(project))
    try {
      const create = fix.projectSession.providers['dev.project.create']! as (
        command: DevCommand
      ) => Project
      const created = create(
        command('dev.project.create', {
          projectId: '00000000-0000-4000-8000-0000000000b2',
          repoIds: ['00000000-0000-4000-8000-0000000000c1'],
        })
      )
      expect(seen).toEqual([created])
      expect(seen[0]?.repoIds).toEqual(['00000000-0000-4000-8000-0000000000c1'])
    } finally {
      fix.cleanup()
    }
  })

  test('a synchronous hook failure is contained: the binding stands and the reply succeeds', () => {
    const fix = hookFixture(() => {
      throw new Error('the composition must contain me')
    })
    try {
      const project = fix.projectSession.providers['dev.project.import']! as (
        command: DevCommand
      ) => Project
      const imported = project(
        command('dev.project.import', {
          projectId: '00000000-0000-4000-8000-0000000000b3',
          rootBookmarkId: fix.bookmarkId,
        })
      )
      expect(imported.id).toBe('00000000-0000-4000-8000-0000000000b3')
      expect(fix.projectSession.findRepoBindings(imported.repoIds[0]!)).toHaveLength(1)
    } finally {
      fix.cleanup()
    }
  })
})
