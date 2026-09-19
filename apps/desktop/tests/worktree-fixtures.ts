// Shared disposable-repo fixtures for the worktree lifecycle suites.
// Every suite gets a throwaway data dir, an authorized repository bookmark,
// and a real local git repository — no network, no shared state.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createOwnerApprovalVerifier,
  type OwnerApproval,
  type OwnerApprovalVerifier,
} from '../shell/src/dev-runtime/authority'
import { createRootBookmarkAuthority } from '../shell/src/dev-runtime/roots'
import { createWorktreeService } from '../shell/src/dev-runtime/worktrees/service'

export const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

let verifier: OwnerApprovalVerifier
let consentSequence = 0

/** Issues one durable, scope-bound, single-use owner approval (M10 #34). */
export function approved(action = 'authorize a root bookmark'): OwnerApproval {
  const approval: OwnerApproval = {
    method: 'owner_dialog',
    reference: `consent-fixture-${++consentSequence}`,
    scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  verifier.recordIssuance(approval, scope, action)
  return approval
}

export function git(dir: string, args: string[]): { stdout: string; code: number } {
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
  })
  return {
    stdout: proc.stdout.toString(),
    code: proc.exitCode ?? 0,
  }
}

export function initRepo(
  dir: string,
  options: { bare?: boolean; initialBranch?: string } = {}
): string {
  mkdirSync(dir, { recursive: true })
  const branch = options.initialBranch ?? 'main'
  git(dir, ['init', ...(options.bare ? ['--bare'] : ['-b', branch])])
  git(dir, ['config', 'user.email', 'adea@example.com'])
  git(dir, ['config', 'user.name', 'Adea Tests'])
  // Fixtures must never run host hooks (git-lfs etc.) — deterministic and offline.
  git(dir, ['config', 'core.hooksPath', '/dev/null'])
  if (!options.bare) {
    writeFileSync(join(dir, 'README.md'), '# fixture\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'initial'])
  }
  return dir
}

/** A disposable world: dataDir (service state), workspace (bookmark root
 *  holding the primary checkout and created worktrees), and the repo. */
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'adea-worktrees-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const repoPath = realpathSync(initRepo(join(workspace, 'primary')))

  verifier = createOwnerApprovalVerifier({ dataDir })
  const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
  const bookmark = roots.mint({
    scope,
    label: 'Workspace',
    kind: 'repository',
    absolutePath: workspace,
    approval: approved(),
  })
  const service = createWorktreeService({
    dataDir,
    runtimeNodeId: scope.runtimeNodeId,
    roots,
    clock: () => new Date(),
  })

  return {
    root,
    dataDir,
    workspace,
    repoPath,
    roots,
    service,
    bookmarkId: bookmark.id,
    registerRepo() {
      return service.registerRepo({
        scope,
        projectId: projectIdA,
        absolutePath: repoPath,
        bookmarkId: bookmark.id,
      })
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export const projectIdA = '00000000-0000-4000-8000-00000000aaaa'
export const projectIdB = '00000000-0000-4000-8000-00000000bbbb'

export function clone(dir: string, from: string): string {
  const proc = Bun.spawnSync(['git', 'clone', from, dir], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) throw new Error(`clone failed: ${proc.stderr.toString()}`)
  git(dir, ['config', 'user.email', 'adea@example.com'])
  git(dir, ['config', 'user.name', 'Adea Tests'])
  return dir
}

export { cpSync, mkdirSync, rmSync, writeFileSync, join, tmpdir, mkdtempSync }
