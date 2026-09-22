// Packaged M12 owner-journey evidence (#541).
//
// This is deliberately a host-side lane: it exercises the production project,
// worktree, session, and archive authorities against a disposable real Git
// repository while anchoring the run to the actual Electrobun .app bundle.
// Browser screenshots/video are not fabricated when the packaged CEF/CDP
// engine is unavailable (#537); those rows are recorded as blocked evidence.
//
// Usage:
//   bun apps/desktop/shell/scripts/packaged-owner-journey.ts \
//     --app-bundle path/to/Adea-dev.app \
//     --artifact artifacts/packaged/owner-journey.json

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { DevCommand, DevOperation, Scope } from '../../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier, type OwnerApproval } from '../src/dev-runtime/authority'
import { registerProjectSessionRuntime } from '../src/dev-runtime/project-session/register'
import { createRootBookmarkAuthority } from '../src/dev-runtime/roots'
import { createWorktreeService } from '../src/dev-runtime/worktrees/service'
import {
  findAppBundle,
  loadPackagedManifestForEntry,
  readPackagedIdentity,
  resolveInstallLocation,
  SIDECAR_INSTALL_LABEL,
  BUN_INSTALL_LABEL,
} from './packaged-install'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

type JourneyStatus = 'passed' | 'blocked' | 'failed'
type JourneyStep = {
  id: string
  status: JourneyStatus
  detail: string
  blocker?: string
}

type Evidence = {
  schemaVersion: 1
  issue: '#541'
  startedAt: string
  completedAt: string
  status: JourneyStatus
  appBundle: string | null
  packagedIdentity: { version: string; channel: string } | null
  steps: readonly JourneyStep[]
  blockers: readonly string[]
  manualRepair: 'none'
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function command(operation: DevOperation, body: Record<string, unknown>): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope: SCOPE,
    capabilities: [],
    body,
  } as DevCommand
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Adea packaged journey',
      GIT_AUTHOR_EMAIL: 'adea-packaged-journey@example.invalid',
      GIT_COMMITTER_NAME: 'Adea packaged journey',
      GIT_COMMITTER_EMAIL: 'adea-packaged-journey@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().trim()
}

function issueApproval(verifier: ReturnType<typeof createOwnerApprovalVerifier>, action: string) {
  const approval: OwnerApproval = {
    method: 'owner_dialog',
    reference: `packaged-owner-journey-${randomUUID()}`,
    scope: SCOPE,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  verifier.recordIssuance(approval, SCOPE, action)
  return approval
}

function writeEvidence(path: string, evidence: Evidence): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString()
  const artifactPath = argValue('--artifact') ?? 'artifacts/packaged/owner-journey.json'
  const steps: JourneyStep[] = []
  const blockers: string[] = []
  let appBundle: string | null = argValue('--app-bundle') ?? null
  let packagedIdentity: Evidence['packagedIdentity'] = null
  let status: JourneyStatus = 'passed'

  const step = (id: string, result: Omit<JourneyStep, 'id'>): void => {
    steps.push({ id, ...result })
    if (result.status === 'blocked') {
      status = 'blocked'
      if (result.blocker) blockers.push(result.blocker)
    }
    if (result.status === 'failed') status = 'failed'
  }

  if (process.platform !== 'darwin') {
    step('platform', {
      status: 'blocked',
      detail: 'packaged owner journey is a macOS-only Electrobun evidence lane',
      blocker: 'macOS packaged execution is required by M12 #426',
    })
  } else {
    appBundle ??= findAppBundle(join(import.meta.dir, '..', 'build'))
    if (!appBundle || !existsSync(appBundle)) {
      step('packaged-bundle', {
        status: 'failed',
        detail: 'no Adea-dev.app was found; run the packaged build first',
      })
    } else {
      appBundle = realpathSync(appBundle)
      const bundlePath = appBundle
      const manifest = loadPackagedManifestForEntry(join(bundlePath, 'Contents/Resources/app'))
      const bun = resolveInstallLocation(bundlePath, BUN_INSTALL_LABEL)
      const sidecar = resolveInstallLocation(bundlePath, SIDECAR_INSTALL_LABEL)
      if (!manifest.ok || !bun.ok || !sidecar.ok) {
        step('packaged-bundle', {
          status: 'failed',
          detail: JSON.stringify({ manifest: manifest.ok, bun: bun.ok, sidecar: sidecar.ok }),
        })
      } else {
        const identity = readPackagedIdentity(bundlePath)
        packagedIdentity = { version: identity.version, channel: identity.channel }
        step('packaged-bundle', {
          status: 'passed',
          detail: `Adea ${identity.version} (${identity.channel}) contains the bundled Bun and terminal sidecar`,
        })
      }
    }
  }

  if (steps.every((entry) => entry.status !== 'failed')) {
    const root = mkdtempSync(join(tmpdir(), 'adea-packaged-owner-journey-'))
    const dataDir = join(root, 'data')
    const workspace = join(root, 'workspace')
    const repoPath = join(workspace, 'primary')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(repoPath, { recursive: true })
    let journeyRoot: string | undefined
    try {
      git(repoPath, ['init', '-b', 'main'])
      git(repoPath, ['config', 'user.email', 'adea-packaged-journey@example.invalid'])
      git(repoPath, ['config', 'user.name', 'Adea packaged journey'])
      writeFileSync(join(repoPath, 'README.md'), '# packaged journey\n')
      git(repoPath, ['add', 'README.md'])
      git(repoPath, ['commit', '-m', 'fixture'])

      const verifier = createOwnerApprovalVerifier({ dataDir })
      const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
      const bookmark = roots.mint({
        scope: SCOPE,
        label: 'Packaged journey workspace',
        kind: 'repository',
        absolutePath: workspace,
        approval: issueApproval(verifier, 'authorize a root bookmark'),
      })
      const worktrees = createWorktreeService({
        dataDir,
        runtimeNodeId: SCOPE.runtimeNodeId,
        roots,
      })
      const repo = await worktrees.registerRepo({
        scope: SCOPE,
        projectId: '00000000-0000-4000-8000-0000000000a1',
        absolutePath: realpathSync(repoPath),
        bookmarkId: bookmark.id,
      })
      journeyRoot = repo.canonicalRoot
      const projectId = repo.projectIds[0]
      if (!projectId) throw new Error('registered repository has no project binding')

      const projectSessions = registerProjectSessionRuntime({
        authority: { registerCommandProvider() {} } as never,
        dataDir,
        scope: SCOPE,
        resolveImportRoot: (rootBookmarkId) => ({
          canonicalRoot: roots.validate({ scope: SCOPE, bookmarkId: rootBookmarkId }).canonicalRoot,
        }),
      })
      const group = projectSessions.providers['dev.group.create']!(
        command('dev.group.create', { name: 'Packaged journey' })
      ) as { id: string }
      const imported = projectSessions.providers['dev.project.import']!(
        command('dev.project.import', {
          name: 'Packaged fixture',
          rootBookmarkId: bookmark.id,
          groupIds: [group.id],
        })
      ) as { id: string; repoIds: readonly string[] }
      step('project-import', {
        status: 'passed',
        detail: `imported ${imported.id} with one authorized root and group ${group.id}`,
      })

      const worktreeBaseDir = join(workspace, 'adea-worktrees', 'primary')
      mkdirSync(worktreeBaseDir, { recursive: true })
      const created = await worktrees.createWorktree({
        scope: SCOPE,
        repoId: repo.id,
        projectId,
        baseRef: 'main',
        branchName: 'feat/packaged-owner-journey',
        worktreeBaseDir,
        idempotencyKey: 'packaged-owner-journey-worktree',
      })
      step('isolated-worktree', {
        status: 'passed',
        detail: `${created.worktree.canonicalRoot} (${created.worktree.lifecycle}, bootstrap=${created.worktree.bootstrap.state})`,
      })

      const project = {
        id: projectId,
        scope: SCOPE,
        name: 'Packaged fixture runtime',
        groupIds: [group.id],
        repoIds: [repo.id],
        lifecycle: 'ready' as const,
        version: 1,
      }
      projectSessions.upsertProject(project)
      const session = projectSessions.providers['dev.session.create']!(
        command('dev.session.create', {
          projectId: project.id,
          repoId: repo.id,
          worktreeId: created.worktree.id,
        })
      ) as { id: string; generation: number; lifecycle: string }
      step('runtime-session', {
        status: 'passed',
        detail: `created ${session.id} in ${session.lifecycle} state on worktree ${created.worktree.id}`,
      })

      const archived = projectSessions.providers['dev.session.archive']!(
        command('dev.session.archive', {
          runtimeSessionId: session.id,
          expectedGeneration: session.generation,
          reason: 'packaged owner journey archive proof',
        })
      ) as { state: string }
      const restored = projectSessions.providers['dev.session.unarchive']!(
        command('dev.session.unarchive', {
          runtimeSessionId: session.id,
          expectedGeneration: session.generation,
        })
      ) as { state: string }
      step('archive-unarchive', {
        status:
          archived.state === 'archived' && restored.state === 'restored' ? 'passed' : 'failed',
        detail: `archive=${archived.state}, restore=${restored.state}, records=${projectSessions.archiveRecords().length}`,
      })

      step('browser-cdp', {
        status: 'blocked',
        detail:
          'packaged browser lane is typed-unavailable because no CEF/CDP engine publishes frames',
        blocker:
          'adea-ai/adea#537 remains open: live packaged CEF/CDP frames, annotations, element picking, screencast, takeover, and screenshot/video evidence are not available',
      })
      step('owner-journey-recording', {
        status: 'blocked',
        detail: 'screenshot/video recording is withheld until the packaged browser engine exists',
        blocker: 'owner-journey screenshot/video acceptance remains open with #537',
      })
    } catch (error) {
      step('production-authorities', {
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      // The disposable root is the only state this lane creates. It is removed
      // after evidence is written; no user database, profile, or repository is
      // repaired by hand.
      rmSync(root, { recursive: true, force: true })
      if (journeyRoot && existsSync(journeyRoot)) {
        step('disposable-cleanup', {
          status: 'failed',
          detail: `temporary worktree root still exists after cleanup: ${journeyRoot}`,
        })
      } else {
        step('disposable-cleanup', {
          status: 'passed',
          detail: 'temporary repository and data root removed',
        })
      }
    }
  }

  const evidence: Evidence = {
    schemaVersion: 1,
    issue: '#541',
    startedAt,
    completedAt: new Date().toISOString(),
    status,
    appBundle,
    packagedIdentity,
    steps,
    blockers,
    manualRepair: 'none',
  }
  writeEvidence(artifactPath, evidence)
  console.log(`PACKAGED-OWNER-JOURNEY ${status.toUpperCase()}`)
  console.log(`evidence: ${artifactPath}`)
  for (const entry of steps)
    console.log(`${entry.status === 'passed' ? 'ok' : entry.status}: ${entry.id} — ${entry.detail}`)
  return status === 'passed' ? 0 : status === 'blocked' ? 2 : 1
}

process.exit(await main())
