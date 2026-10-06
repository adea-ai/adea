// `dev.project.clone` (ADR 0011, PR 15): remote-only projects backed by a
// managed bare clone.
//
// The clone lands in Adea's owner-only app data
// (`dev-runtime/managed-repos/<repoId>.git`), never in a user path. It is a
// `--bare` clone with a remote-tracking refspec, registered in the one
// repository registry as `kind: 'git'` with `layout: 'bare_managed'`, bound
// to the cloud project id, and given NO primary worktree record: a
// remote-only project has worktrees only. Unbinding such a project removes
// the clone through the quarantine/trash path, and only after every one of
// its worktrees has been cleaned.
//
// Git runs through the bounded argv-only runner with a transport allowlist
// (`protocol.allow=never` plus the one proven scheme), a wall-clock budget, a
// size watchdog, and typed auth/network failures. Credential references are
// resolved and host-matched exactly like `dev.repo.authorize`; secret
// material never enters git arguments, the environment, the registry, a
// reply, an event, or a log. The remote URL is `workspace_private`: it stays
// in the device-local registry and every DTO redacts it.
import { chmodSync, lstatSync, mkdirSync, renameSync, rmdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type {
  DevCommand,
  DevError,
  Project,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import { nowIso, sameScope } from '../authority'
import type { AuthorityAudit } from '../audit'
import type { ChannelAuthority } from '../channel/authority'
import type { ProjectSessionRuntime } from '../project-session/register'
import {
  directoryBytes,
  ensureManagedReposRoot,
  managedClonePath,
  MANAGED_CLONE_MAX_BYTES,
  MANAGED_CLONE_SIZE_POLL_MS,
  MANAGED_CLONE_TIMEOUT_MS,
  MANAGED_WORKTREES_DIR,
  nonInteractiveTransportEnv,
  proveManagedBareRepo,
  provenManagedReposRoot,
} from '../repos/managed'
import { createRepoRegistryStore, redactRemoteUrl } from '../repos/registry-store'
import { discoverWorktrees } from '../worktrees/discovery'
import { WorktreeError, type WorktreeErrorCode } from '../worktrees/errors'
import { GitChildKilledError, runGit, type GitRunResult } from '../worktrees/git-run'
import { identityOfPath } from '../worktrees/identity'
import type { WorktreeService } from '../worktrees/service'
import {
  deleteQuarantinedWorktree,
  quarantineWorktree,
  restoreWorktreeFromTrash,
} from '../worktrees/trash'

/** At most this many clones run at once per runtime node. */
export const MANAGED_CLONE_MAX_CONCURRENT = 2
const GIT_LOCAL_TIMEOUT_MS = 10_000
const GIT_LOCAL_MAX_OUTPUT_BYTES = 1024 * 1024

type CloneProtocol = 'https' | 'ssh' | 'file'

type CloneLimits = Readonly<{ timeoutMs: number; maxBytes: number; pollMs: number }>

function devError(code: DevError['code'], message: string): DevError {
  return { code, retryable: code === 'remote_unavailable' || code === 'timeout', message }
}

// oxlint-disable-next-line no-control-regex -- remote URLs reject control characters by design
const CONTROL_OR_SPACE = /[\u0000- \u007f]/

/**
 * Admit a clone remote. Production accepts only `https://`, `ssh://`, and
 * scp-like `user@host:path` (ssh). `file://` is admitted only when the
 * composition passes the test-only `allowLocalRemotes` flag (the shipped
 * shell never does); local paths are never remotes. The URL may not carry a
 * password or an https user-info token (credentials come from a vault
 * reference, never the URL), may not start with `-` (option injection), and
 * may not contain whitespace or control characters. Everything else —
 * `http://`, `ext::`, `fd::`, bare paths — refuses with `invalid_state`.
 */
export function admitCloneRemote(
  remoteUrl: string,
  options: { allowLocalRemotes?: boolean } = {}
): CloneProtocol {
  const refuse = (why: string) => devError('invalid_state', `clone remote refused: ${why}`)
  if (remoteUrl.length < 1 || remoteUrl.length > 2048) throw refuse('length')
  if (CONTROL_OR_SPACE.test(remoteUrl)) throw refuse('whitespace or control characters')
  if (remoteUrl.startsWith('-')) throw refuse('leading dash')
  const scpLike = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([^:].*)$/.exec(remoteUrl)
  if (scpLike && !remoteUrl.includes('://')) {
    const [, , host = '', path = ''] = scpLike
    if (host.startsWith('-') || host.startsWith('.') || path.startsWith('-'))
      throw refuse('malformed ssh remote')
    return 'ssh'
  }
  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch {
    throw refuse('not a URL')
  }
  if (parsed.password !== '') throw refuse('embedded password; use a credential reference')
  if (parsed.protocol === 'https:') {
    if (parsed.username !== '') throw refuse('embedded user info; use a credential reference')
    if (parsed.hostname === '') throw refuse('missing host')
    return 'https'
  }
  if (parsed.protocol === 'ssh:') {
    if (parsed.hostname === '' || parsed.hostname.startsWith('-')) throw refuse('missing host')
    return 'ssh'
  }
  if (parsed.protocol === 'file:') {
    // A local remote would let a caller copy any repository the user can
    // read into app data; only test compositions opt in.
    if (options.allowLocalRemotes !== true) throw refuse('local remotes are not allowed')
    if (parsed.host !== '' || parsed.pathname.length < 2) throw refuse('malformed file remote')
    return 'file'
  }
  throw refuse(`unsupported transport ${parsed.protocol.replace(/:$/, '')}`)
}

/** A base ref the binding may default to: a plain ref spelling only. */
function admitBaseRef(ref: string): void {
  if (
    ref.length < 1 ||
    ref.length > 256 ||
    CONTROL_OR_SPACE.test(ref) ||
    ref.startsWith('-') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    /[~^:?*[\\]/.test(ref) ||
    ref.endsWith('/') ||
    ref.endsWith('.lock')
  )
    throw devError('invalid_state', 'default base ref is not a valid ref name')
}

/** Transport-scoped git config: every other protocol is refused by git. */
function transportArgs(protocol: CloneProtocol): string[] {
  return ['-c', 'protocol.allow=never', '-c', `protocol.${protocol}.allow=always`]
}

function classifyTransport(stderr: string): WorktreeErrorCode {
  const text = stderr.toLowerCase()
  // Batch-mode SSH refuses an unknown or changed host key outright: the
  // remote could not be proven, which is a reachability failure, not auth.
  if (
    text.includes('host key verification failed') ||
    text.includes('no matching host key') ||
    /no [a-z0-9-]+ host key is known/.test(text) ||
    text.includes('remote host identification has changed')
  )
    return 'remote_unavailable'
  if (
    text.includes('authentication failed') ||
    text.includes('could not read username') ||
    text.includes('could not read password') ||
    text.includes('permission denied') ||
    text.includes('terminal prompts disabled') ||
    text.includes('403')
  )
    return 'auth_required'
  if (text.includes('repository not found') || text.includes('does not appear to be a git'))
    return 'not_found'
  return 'remote_unavailable'
}

export type ManagedCloneAuthority = Readonly<{
  /** The unbind hook for remote-only projects (see project-session). */
  prepareUnbind(project: Project): Promise<Readonly<{ commit(): void; rollback(): void }>>
  /** Register `dev.project.clone` against the project register. */
  registerCloneProvider(input: {
    authority: ChannelAuthority
    projectSession: ProjectSessionRuntime
    resolveCredentialRef: (credentialRefId: string) => { id: string; host: string; state: string }
  }): void
}>

export function createManagedCloneAuthority(input: {
  dataDir: string
  scope: Scope
  worktreeService?: WorktreeService
  audit?: AuthorityAudit
  /** Test seam: the bounded git runner. */
  runGit?: typeof runGit
  /** Test seam: tighter clone budgets than the limits registry defaults. */
  limits?: Partial<CloneLimits>
  /** Test-only: admit `file://` remotes (local fixture origins). The shipped
   *  shell composition never sets it, so production refuses local remotes. */
  allowLocalRemotes?: boolean
}): ManagedCloneAuthority {
  const git = input.runGit ?? runGit
  const registry = createRepoRegistryStore(input.dataDir)
  const limits: CloneLimits = {
    timeoutMs: input.limits?.timeoutMs ?? MANAGED_CLONE_TIMEOUT_MS,
    maxBytes: input.limits?.maxBytes ?? MANAGED_CLONE_MAX_BYTES,
    pollMs: input.limits?.pollMs ?? MANAGED_CLONE_SIZE_POLL_MS,
  }
  const inFlight = new Set<string>()

  function log(
    action: string,
    subjectId: string,
    outcome: 'granted' | 'denied' | 'failed' | 'recovered',
    detail?: Record<string, string>
  ): void {
    input.audit?.append({ action, subjectId, outcome, ...(detail ? { detail } : {}) })
  }

  async function localGit(cwd: string, args: string[]): Promise<GitRunResult> {
    return git(args, {
      cwd,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      maxOutputBytes: GIT_LOCAL_MAX_OUTPUT_BYTES,
    })
  }

  async function localGitChecked(cwd: string, args: string[]): Promise<GitRunResult> {
    const result = await localGit(cwd, args)
    if (result.exitCode !== 0)
      throw new WorktreeError('invalid_state', `git ${args[0]} failed in the managed clone`)
    return result
  }

  /** One network git child under the clone budgets: wall-clock timeout,
   *  output cap, and a size watchdog that aborts once the clone directory
   *  outgrows `maxBytes`. Failures are typed (auth/network/timeout/size). */
  async function networkGit(args: string[], cwd: string, watchDir: string): Promise<void> {
    const controller = new AbortController()
    let overBudget = false
    const watchdog = setInterval(() => {
      if (directoryBytes(watchDir) > limits.maxBytes) {
        overBudget = true
        controller.abort()
      }
    }, limits.pollMs)
    watchdog.unref?.()
    let result: GitRunResult
    try {
      result = await git(args, {
        cwd,
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: GIT_LOCAL_MAX_OUTPUT_BYTES,
        signal: controller.signal,
        // Nothing may prompt: batch-mode SSH and no askpass/terminal prompt.
        env: nonInteractiveTransportEnv(),
      })
    } catch (error) {
      // The runner reaps a killed child before rejecting; `exited` says
      // whether that was confirmed, which decides what cleanup may delete.
      const exited = error instanceof GitChildKilledError ? error.exited : true
      if (overBudget)
        throw new GitChildKilledError(
          'limit_exceeded',
          'the clone exceeded the managed clone size budget',
          exited
        )
      if (error instanceof WorktreeError && error.code === 'timeout')
        throw new GitChildKilledError(
          'timeout',
          'the clone exceeded the managed clone time budget',
          exited
        )
      throw error
    } finally {
      clearInterval(watchdog)
    }
    if (overBudget || directoryBytes(watchDir) > limits.maxBytes)
      throw new WorktreeError('limit_exceeded', 'the clone exceeded the managed clone size budget')
    if (result.exitCode !== 0) {
      const code = classifyTransport(result.stderr)
      throw new WorktreeError(
        code,
        code === 'auth_required'
          ? 'the remote refused authentication for the clone'
          : code === 'not_found'
            ? 'the remote repository was not found'
            : 'the remote could not be reached for the clone'
      )
    }
  }

  /** Remove a directory this call created and proved (staging or a final
   *  clone that failed a later step) through the quarantine/trash path. With
   *  `deleteAfter: false` (the git child's exit was not confirmed) the
   *  directory is only quarantined: it stays owner-only in the managed trash
   *  and is never deleted while a writer may still hold it. Returns whether
   *  the directory is fully gone. */
  function discard(
    path: string,
    managedRoot: string,
    subjectId: string,
    deleteAfter: boolean
  ): boolean {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) return true
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new WorktreeError('dangerous_path', 'the partial clone is not a real directory')
    const identity = identityOfPath(path)
    const moved = quarantineWorktree({
      worktreeId: subjectId,
      worktreePath: path,
      repoPath: managedRoot,
      expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
    })
    chmodSync(moved.trashPath, 0o700)
    if (!deleteAfter) return false
    deleteQuarantinedWorktree({ trashRoot: moved.trashRoot, entryName: moved.entryName })
    return true
  }

  async function clone(
    command: DevCommand,
    projectSession: ProjectSessionRuntime,
    resolveCredentialRef: (credentialRefId: string) => { id: string; host: string; state: string }
  ): Promise<Project> {
    if (!sameScope(command.scope, input.scope))
      throw devError('unauthorized', 'project clone scope is not authorized')
    if (command.resource !== undefined)
      throw devError('identity_mismatch', 'dev.project.clone carries no resource binding')
    const body = devOperationDecoders['dev.project.clone'].request(command.body)
    const projectId = body.projectId as string
    const remoteUrl = body.remoteUrl as string
    const credentialRefId = body.credentialRefId as string | undefined
    const defaultBaseRef = body.defaultBaseRef as string | undefined
    projectSession.assertUnboundProjectId(projectId)
    const protocol = admitCloneRemote(remoteUrl, {
      allowLocalRemotes: input.allowLocalRemotes === true,
    })
    if (defaultBaseRef !== undefined) admitBaseRef(defaultBaseRef)
    if (credentialRefId !== undefined) {
      // The same fail-closed resolution `dev.repo.authorize` uses: unknown
      // refs are `not_found`, unusable ones refuse, and the credential host
      // must equal the remote's proven host.
      const credential = resolveCredentialRef(credentialRefId)
      if (credential.state !== 'ready')
        throw devError(
          'invalid_state',
          `credential reference ${credential.id} is not usable (state ${credential.state})`
        )
      const host = redactRemoteUrl(remoteUrl).host
      if (host === 'unknown' || host !== credential.host.toLowerCase())
        throw devError('identity_mismatch', 'credential host does not match the clone remote host')
    }
    if (inFlight.has(projectId))
      throw devError('identity_mismatch', 'a clone for this project is already in progress')
    if (inFlight.size >= MANAGED_CLONE_MAX_CONCURRENT)
      throw devError('limit_exceeded', 'too many managed clones are in progress')
    inFlight.add(projectId)
    try {
      return await cloneLocked({
        projectSession,
        projectId,
        remoteUrl,
        protocol,
        ...(credentialRefId !== undefined ? { credentialRefId } : {}),
        ...(defaultBaseRef !== undefined ? { defaultBaseRef } : {}),
      })
    } finally {
      inFlight.delete(projectId)
    }
  }

  async function cloneLocked(request: {
    projectSession: ProjectSessionRuntime
    projectId: string
    remoteUrl: string
    protocol: CloneProtocol
    credentialRefId?: string
    defaultBaseRef?: string
  }): Promise<Project> {
    const managedRoot = ensureManagedReposRoot(input.dataDir)
    const repoId = randomUUID()
    const finalPath = managedClonePath(managedRoot, repoId)
    // A fresh owner-only staging directory, created (and so proven) here:
    // a failure before the rename removes only this directory.
    const staging = join(managedRoot, `.staging-${repoId}.git`)
    mkdirSync(staging, { mode: 0o700 })
    let cloned = staging
    try {
      await networkGit(
        [...transportArgs(request.protocol), 'clone', '--bare', '--', request.remoteUrl, staging],
        managedRoot,
        staging
      )
      chmodSync(staging, 0o700)
      // `--bare` maps remote branches onto local ones and configures no
      // fetch refspec; managed worktrees fetch their base into
      // remote-tracking refs instead, so later fetches never rewrite a
      // worktree branch.
      await localGitChecked(staging, [
        'config',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ])
      await networkGit(
        [...transportArgs(request.protocol), 'fetch', '--prune', 'origin'],
        staging,
        staging
      )
      const head = await localGit(staging, ['symbolic-ref', '--quiet', 'HEAD'])
      const defaultBranch =
        head.exitCode === 0 ? head.stdout.trim().replace(/^refs\/heads\//, '') : ''
      let trackedDefault: string | undefined
      if (defaultBranch.length > 0) {
        const tracked = `refs/remotes/origin/${defaultBranch}`
        const exists = await localGit(staging, ['rev-parse', '--verify', '--quiet', tracked])
        if (exists.exitCode === 0) {
          await localGitChecked(staging, ['symbolic-ref', 'refs/remotes/origin/HEAD', tracked])
          trackedDefault = `origin/${defaultBranch}`
        }
      }
      if (request.defaultBaseRef !== undefined) {
        const resolved = await localGit(staging, [
          'rev-parse',
          '--verify',
          '--quiet',
          `${request.defaultBaseRef}^{commit}`,
        ])
        if (resolved.exitCode !== 0)
          throw new WorktreeError(
            'base_not_found',
            'the default base ref does not resolve in the clone'
          )
      }
      // Publish the clone under its managed name, then prove it as a
      // managed bare repository before anything records it.
      if (lstatSync(finalPath, { throwIfNoEntry: false }))
        throw new WorktreeError('path_collision', 'the managed clone path already exists')
      renameSync(staging, finalPath)
      cloned = finalPath
      const identity = await proveManagedBareRepo({
        dataDir: input.dataDir,
        canonicalRoot: finalPath,
        repoId,
        git,
      })
      const defaultRef = defaultBranch.length > 0 ? `refs/heads/${defaultBranch}` : undefined
      registry.upsert({
        id: repoId,
        scope: { ...input.scope },
        kind: 'git',
        layout: 'bare_managed',
        lifecycle: 'ready',
        canonicalRoot: finalPath,
        rootIdentity: identity,
        // A bare repository is its own git common dir.
        gitCommonDirIdentity: identity,
        remote: request.remoteUrl,
        fetchRemote: 'origin',
        ...(defaultRef !== undefined ? { defaultRef } : {}),
        ...(request.credentialRefId !== undefined
          ? { credentialRefId: request.credentialRefId }
          : {}),
        projectIds: [request.projectId],
        version: 1,
        updatedAt: nowIso(),
      })
      let project: Project
      try {
        const baseRef = request.defaultBaseRef ?? trackedDefault
        project = request.projectSession.bindManagedClone({
          projectId: request.projectId,
          repoId,
          canonicalRoot: finalPath,
          ...(baseRef !== undefined ? { defaultBaseRef: baseRef } : {}),
        })
      } catch (error) {
        registry.remove(repoId)
        throw error
      }
      log('repo.managed_cloned', repoId, 'granted', { protocol: request.protocol })
      return project
    } catch (error) {
      const cause =
        typeof (error as { code?: unknown })?.code === 'string'
          ? ((error as { code: string }).code as string)
          : 'unknown'
      log('repo.managed_clone', repoId, 'failed', { cause })
      // Cleanup runs only after the git child is reaped; an unconfirmed exit
      // quarantines without deleting.
      const childExited = !(error instanceof GitChildKilledError) || error.exited
      let removed = false
      let discardFailure: string | undefined
      try {
        removed = discard(cloned, managedRoot, repoId, childExited)
      } catch (discardError) {
        discardFailure = (discardError as Error).message
      }
      if (removed) throw error
      // Never a silent leftover: the outcome is typed and audited, and the
      // partial clone stays owner-only in the managed root or its trash.
      log('repo.managed_clone_discard', repoId, 'failed', {
        cause,
        reason: discardFailure !== undefined ? 'discard_failed' : 'child_exit_unconfirmed',
      })
      throw new WorktreeError(
        'cleanup_partial',
        `the clone failed (${cause}) and its partial data could not be removed ` +
          `(${discardFailure ?? 'the git child exit was not confirmed'}); it is retained ` +
          'owner-only in the managed root for the trash sweep'
      )
    }
  }

  async function prepareUnbind(
    project: Project
  ): Promise<Readonly<{ commit(): void; rollback(): void }>> {
    const managedRoot = provenManagedReposRoot(input.dataDir)
    const moved: Array<{ repoId: string; path: string; trashRoot: string; entryName: string }> = []
    const rollback = () => {
      for (const entry of moved.toReversed())
        restoreWorktreeFromTrash(join(entry.trashRoot, entry.entryName), entry.path)
    }
    try {
      for (const binding of project.repos ?? []) {
        if (binding.layout !== 'bare_managed') continue
        const record = registry.find(binding.repoId)
        if (!record) continue
        if (record.layout !== 'bare_managed' || record.canonicalRoot !== binding.canonicalRoot)
          throw new WorktreeError(
            'identity_mismatch',
            'the managed clone record does not match the project binding'
          )
        if (record.projectIds.some((id) => id !== project.id))
          throw new WorktreeError(
            'invalid_state',
            'the managed clone is bound to another project as well'
          )
        // Every worktree must be cleaned first: a remote-only project's
        // worktrees are its only checkouts, so the clone outliving them is
        // the only order that never strands a checkout without its repo.
        const live = (
          input.worktreeService?.listWorktrees({ scope: input.scope, repoId: record.id }) ?? []
        ).filter((worktree) => worktree.lifecycle !== 'cleaned')
        if (live.length > 0)
          throw new WorktreeError(
            'cleanup_blocked',
            `the managed clone still has ${live.length} worktree(s); complete and clean them first`
          )
        const identity = await proveManagedBareRepo({
          dataDir: input.dataDir,
          canonicalRoot: record.canonicalRoot,
          repoId: record.id,
          expectedIdentity: record.rootIdentity,
          git,
        })
        // Git's own registry must agree: nothing but the bare entry itself.
        const registered = await discoverWorktrees(record.canonicalRoot)
        if (registered.length > 1)
          throw new WorktreeError(
            'cleanup_blocked',
            'the managed clone still has registered git worktrees'
          )
        const trash = quarantineWorktree({
          worktreeId: record.id,
          worktreePath: record.canonicalRoot,
          repoPath: managedRoot,
          expectedIdentity: { device: identity.device ?? '', inode: identity.inode ?? '' },
        })
        moved.push({
          repoId: record.id,
          path: record.canonicalRoot,
          trashRoot: trash.trashRoot,
          entryName: trash.entryName,
        })
      }
    } catch (error) {
      rollback()
      throw error
    }
    return {
      rollback,
      commit() {
        for (const entry of moved) {
          try {
            deleteQuarantinedWorktree({ trashRoot: entry.trashRoot, entryName: entry.entryName })
          } catch (error) {
            // The binding is gone; the quarantined clone keeps its provenance
            // record for the trash sweep and the registry record stays as
            // retained `unavailable` data — never a silent success.
            const record = registry.find(entry.repoId)
            if (record)
              registry.upsert({
                ...record,
                lifecycle: 'unavailable',
                version: record.version + 1,
                updatedAt: nowIso(),
              })
            log('repo.managed_clone_deleted', entry.repoId, 'failed')
            throw new WorktreeError(
              'cleanup_partial',
              `project unbound, but deleting the quarantined managed clone failed: ${(error as Error).message}`
            )
          }
          registry.remove(entry.repoId)
          // The repo's managed worktree base goes too once it is empty.
          try {
            rmdirSync(join(input.dataDir, MANAGED_WORKTREES_DIR, entry.repoId))
          } catch {
            // Not empty (its trash root still holds quarantined entries) or
            // never created: retained for the sweep.
          }
          log('repo.managed_clone_deleted', entry.repoId, 'granted')
        }
      },
    }
  }

  return Object.freeze({
    prepareUnbind,
    registerCloneProvider(registration) {
      registration.authority.registerCommandProvider('dev.project.clone', async (command) =>
        clone(command, registration.projectSession, registration.resolveCredentialRef)
      )
    },
  })
}
