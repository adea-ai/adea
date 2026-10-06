// The repository registry (#398 follow-up): the durable authority that turns
// a project's import-time repo binding into a proven, authorized source.
//
// `dev.project.import` mints the binding triple (repoId, rootBookmarkId,
// canonicalRoot) but proves nothing on disk. The repo operations close that
// gap: `adopt` re-proves identity, containment, and canonical git facts under
// an authorized root bookmark; `authorize` binds a vault credential reference
// to the remote host; `inspect` computes read-only facts from the canonical
// root with local git reads only; `refresh` re-proves the canonical identity
// and probes the remote offline-safe (`git ls-remote` over the
// insteadOf-rewritten remote, as the #397/#423 runners do). Nothing here runs
// a shell, accepts a client path, or trusts a string-prefix containment: the
// canonical root always comes from the project binding or the durable record,
// and containment is re-proven through the roots authority immediately before
// any git read.
import { lstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import type {
  DevCommand,
  DevError,
  DevOperation,
  Repo,
  RepoInspection,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import { DevAuthorityError, sameScope } from '../authority'
import type { ChannelAuthority } from '../channel/authority'
import { identityOfPath, sameIdentity, type FileIdentityValue } from '../worktrees/identity'
import { runGit, type GitRunResult } from '../worktrees/git-run'
import { proveManagedBareRepo } from './managed'
import {
  createRepoRegistryStore,
  redactRemoteUrl,
  toRepoDto,
  type RepoRegistryRecord,
} from './registry-store'

export { redactRemoteUrl } from './registry-store'

export type RepoRuntime = Readonly<{
  providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>>
}>

type RepoRecord = RepoRegistryRecord

const LS_REMOTE_TIMEOUT_MS = 10_000

/** Inspect/refresh reads are bounded: fixed budgets, machine output only, and
 *  the shared child environment already sets `GIT_TERMINAL_PROMPT=0` and
 *  `GIT_OPTIONAL_LOCKS=0` (no prompts, no index lock on read paths). */
const GIT_READ_TIMEOUT_MS = 10_000
const GIT_READ_MAX_OUTPUT_BYTES = 1024 * 1024

function devError(code: DevError['code'], message: string): DevError {
  return { code, retryable: false, message }
}

function isRealDirectory(path: string): boolean {
  const presented = lstatSync(path, { throwIfNoEntry: false })
  return presented !== undefined && presented.isDirectory() && !presented.isSymbolicLink()
}

/** The proven canonical root: real-pathed, a real directory (never a
 *  symlink spelling), with its replacement-proof identity. */
function proveCanonicalRoot(path: string): {
  canonicalRoot: string
  identity: FileIdentityValue
} {
  if (typeof path !== 'string' || path.length < 1 || path.includes('\0') || !path.startsWith('/'))
    throw new DevAuthorityError('path_escape', 'repository path is malformed')
  const canonicalRoot = resolve(path)
  try {
    return { canonicalRoot, identity: identityOfPath(canonicalRoot) }
  } catch {
    throw new DevAuthorityError('not_found', 'repository checkout is missing on disk')
  }
}

/** The remote's bare hostname for credential host-matching, or undefined when
 *  the URL cannot be proven to name one (authorization then fails closed). */
function remoteHost(remote: string): string | undefined {
  const redacted = redactRemoteUrl(remote)
  return redacted.host === 'unknown' ? undefined : redacted.host
}

export function registerRepoRuntime(input: {
  authority: ChannelAuthority
  dataDir: string
  scope: Scope
  /** Fail-closed bookmark resolution: the roots authority's validate. */
  validateRootBookmark: (rootBookmarkId: string) => { canonicalRoot: string }
  /** Vault resolution for `dev.repo.authorize`: unknown refs refuse. */
  resolveCredentialRef: (credentialRefId: string) => { id: string; host: string; state: string }
  /** The project-session register's binding view: where repoIds come from. */
  findRepoBindings: (repoId: string) => readonly {
    repoId: string
    rootBookmarkId: string
    canonicalRoot: string
    projectId: string
  }[]
  /** Test seam: inject the bounded git runner; production uses the real one. */
  runGit?: typeof runGit
  /** ADR 0011: after a proof persists a record (adopt, authorize, refresh,
   *  inspect with `refresh: true`), the composition reconciles the repo's
   *  primary checkout worktree record through the one worktree service:
   *  created once for a git repository, its inspected head refreshed after. */
  onRepoProven?: (repoId: string) => Promise<void>
}): RepoRuntime {
  const git = input.runGit ?? runGit
  const registry = createRepoRegistryStore(input.dataDir)
  const findRecord = (repoId: string): RepoRecord | undefined => registry.find(repoId)
  const upsertRecord = (next: RepoRecord): void => registry.upsert(next)

  function requireScope(command: DevCommand): void {
    if (!sameScope(command.scope, input.scope))
      throw new DevAuthorityError('unauthorized', 'repository registry scope is not authorized')
  }

  /** The envelope resource for repository operations names this repo at its
   *  current version (a Repo carries no generation field, so the spec's
   *  fallback binds the resource generation to the optimistic version). */
  function requireRepoResource(command: DevCommand, repoId: string, version: number): void {
    const resource = command.resource
    if (resource === undefined)
      throw devError('identity_mismatch', 'operation requires a repository resource binding')
    if (resource.kind !== 'repository')
      throw devError('identity_mismatch', 'resource kind must be repository')
    if (resource.id !== repoId)
      throw devError('identity_mismatch', 'resource id does not match the request body')
    if (resource.generation !== version)
      throw devError('stale_generation', 'resource generation does not match the repo version')
  }

  /** The proven canonical root lives at module scope (`proveCanonicalRoot`). */
  /** Git-kind detection, identical to the #397 registrar: a `.git` directory
   *  is a repository root, a `.git` file is a linked worktree (refused — it
   *  is not a canonical root), a bare `HEAD` is a bare repository (refused),
   *  and anything else is a plain folder workspace. The ONE admitted bare
   *  layout — a managed clone — never reaches this path: its records carry
   *  `layout: 'bare_managed'` and prove through `proveManaged`. */
  function proveRepoKind(canonicalRoot: string): 'git' | 'folder' {
    const dotGit = lstatSync(join(canonicalRoot, '.git'), { throwIfNoEntry: false })
    if (dotGit?.isDirectory()) return 'git'
    if (dotGit?.isFile())
      // Not a DevAuthorityCode: thrown as the plain DevError shape the
      // channel surfaces verbatim (`not_git_repo`).
      throw devError('not_git_repo', 'the path is a linked worktree, not a repository root')
    const head = lstatSync(join(canonicalRoot, 'HEAD'), { throwIfNoEntry: false })
    if (head) throw devError('not_git_repo', 'bare repositories are unsupported')
    return 'folder'
  }

  /** Canonical git identity from local config only — no network. The remote
   *  URL comes from `remote.origin.url` (the configured URL, not
   *  `remote get-url`, so insteadOf rewrites never mask the true origin),
   *  and the default ref from the origin HEAD symbolic ref with the local
   *  `init.defaultBranch` as fallback. */
  async function readCanonicalGitFacts(
    canonicalRoot: string
  ): Promise<{ remote?: string; defaultRef?: string }> {
    const config = await readGit(canonicalRoot, ['config', '--get', 'remote.origin.url'])
    const remote = config?.exitCode === 0 ? config.stdout.trim() || undefined : undefined
    let defaultRef: string | undefined
    const symbolic = await readGit(canonicalRoot, [
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ])
    if (symbolic?.exitCode === 0) {
      const short = symbolic.stdout.trim().replace(/^origin\//, '')
      if (short.length > 0) defaultRef = `refs/heads/${short}`
    }
    if (defaultRef === undefined) {
      const fallback = await readGit(canonicalRoot, ['config', '--get', 'init.defaultBranch'])
      if (fallback?.exitCode === 0 && fallback.stdout.trim().length > 0)
        defaultRef = `refs/heads/${fallback.stdout.trim()}`
    }
    return {
      ...(remote !== undefined ? { remote } : {}),
      ...(defaultRef !== undefined ? { defaultRef } : {}),
    }
  }

  function readGit(canonicalRoot: string, args: string[]): Promise<GitRunResult | undefined> {
    return git(args, {
      cwd: canonicalRoot,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxOutputBytes: GIT_READ_MAX_OUTPUT_BYTES,
    }).catch(() => undefined)
  }

  /** The full proof-time verification: bookmark containment, directory
   *  identity, git-kind, and canonical git facts, all re-proven now. */
  async function proveBinding(proof: { canonicalRoot: string; rootBookmarkId: string }): Promise<{
    canonicalRoot: string
    identity: FileIdentityValue
    gitCommonDirIdentity?: FileIdentityValue
    kind: 'git' | 'folder'
    remote?: string
    defaultRef?: string
  }> {
    // Containment is re-proven through the roots authority (validate fails
    // closed on unknown, revoked, drifted, or replaced bookmarks) and then
    // structurally against the bookmark's canonical root.
    const bookmark = input.validateRootBookmark(proof.rootBookmarkId)
    const { canonicalRoot, identity } = proveCanonicalRoot(proof.canonicalRoot)
    if (
      canonicalRoot !== bookmark.canonicalRoot &&
      !canonicalRoot.startsWith(bookmark.canonicalRoot + sep)
    ) {
      throw new DevAuthorityError(
        'unauthorized_root',
        'repository path is not covered by the authorized root'
      )
    }
    const kind = proveRepoKind(canonicalRoot)
    const facts = kind === 'git' ? await readCanonicalGitFacts(canonicalRoot) : {}
    const gitCommonDirIdentity =
      kind === 'git' ? identityOfPath(join(canonicalRoot, '.git')) : undefined
    return {
      canonicalRoot,
      identity,
      ...(gitCommonDirIdentity !== undefined ? { gitCommonDirIdentity } : {}),
      kind,
      ...facts,
    }
  }

  /** The managed bare-clone proof (remote-only projects): the owner-only
   *  managed root, the bare layout, `core.bare=true`, and the recorded file
   *  identity — never a bookmark, which no user root provides here. */
  async function proveManaged(
    record: RepoRecord
  ): Promise<Awaited<ReturnType<typeof proveBinding>>> {
    const identity = await proveManagedBareRepo({
      dataDir: input.dataDir,
      canonicalRoot: record.canonicalRoot,
      repoId: record.id,
      expectedIdentity: record.rootIdentity,
      git,
    })
    const facts = await readCanonicalGitFacts(record.canonicalRoot)
    // A bare repository is its own git common dir.
    return {
      canonicalRoot: record.canonicalRoot,
      identity,
      gitCommonDirIdentity: identity,
      kind: 'git',
      ...facts,
    }
  }

  /** Re-prove a durable record through the proof its layout requires. */
  function proveRecord(record: RepoRecord): Promise<Awaited<ReturnType<typeof proveBinding>>> {
    if (record.layout === 'bare_managed') return proveManaged(record)
    return proveBinding({
      canonicalRoot: record.canonicalRoot,
      rootBookmarkId: record.rootBookmarkId!,
    })
  }

  /** Materialize or re-prove the durable record under `expectedVersion`.
   *  A not-yet-proven binding materializes at version 1 (the initial version
   *  every registry record carries); an existing record re-proofs at
   *  version + 1. Both paths run the full proof: containment, identity,
   *  kind, and canonical git facts. */
  async function adoptOrAuthorize(request: {
    repoId: string
    rootBookmarkId: string | undefined
    credentialRefId: string | undefined
    expectedVersion: number
  }): Promise<RepoRecord> {
    const stored = findRecord(request.repoId)
    const bindings = input.findRepoBindings(request.repoId)
    if (!stored && bindings.length === 0)
      throw new DevAuthorityError('not_found', 'repository is not registered on this runtime node')
    if (stored) {
      if (stored.version !== request.expectedVersion)
        throw new DevAuthorityError(
          'stale_version',
          `repository ${stored.id} moved on: version ${stored.version}`,
          stored.version
        )
    } else if (request.expectedVersion !== 1) {
      throw new DevAuthorityError(
        'stale_version',
        'repository has not been adopted yet; its initial version is 1',
        1
      )
    }
    const managed = stored?.layout === 'bare_managed'
    // A managed clone is registered by `dev.project.clone`; no user bookmark
    // covers it, so there is nothing to adopt it under.
    if (managed && request.rootBookmarkId !== undefined)
      throw new DevAuthorityError(
        'invalid_state',
        'a managed clone is registered by dev.project.clone and is never adopted'
      )
    // The proof bookmark: adopt names one from the command; authorize
    // re-proves the recorded (or first binding) bookmark. A client never
    // supplies a path — the canonical root comes from the binding or record.
    const bookmarkId = managed
      ? undefined
      : (request.rootBookmarkId ?? stored?.rootBookmarkId ?? bindings[0]!.rootBookmarkId)
    const canonicalRoot = stored?.canonicalRoot ?? bindings[0]!.canonicalRoot
    const proven = managed
      ? await proveManaged(stored)
      : await proveBinding({ canonicalRoot, rootBookmarkId: bookmarkId! })
    if (request.credentialRefId !== undefined) {
      if (proven.kind !== 'git' || proven.remote === undefined)
        throw new DevAuthorityError(
          'invalid_state',
          'credential authorization requires a git repository with a configured origin remote'
        )
      const credential = input.resolveCredentialRef(request.credentialRefId)
      if (credential.state !== 'ready')
        throw new DevAuthorityError(
          'invalid_state',
          `credential reference ${credential.id} is not usable (state ${credential.state})`
        )
      const host = remoteHost(proven.remote)
      if (host === undefined || host !== credential.host.toLowerCase())
        throw new DevAuthorityError(
          'identity_mismatch',
          'credential host does not match the repository remote host'
        )
    }
    const projectIds = [
      ...new Set([...bindings.map((binding) => binding.projectId), ...(stored?.projectIds ?? [])]),
    ]
    const next: RepoRecord = {
      id: request.repoId,
      scope: input.scope,
      kind: proven.kind,
      lifecycle: 'ready',
      canonicalRoot: proven.canonicalRoot,
      ...(managed ? { layout: 'bare_managed' as const } : {}),
      rootIdentity: proven.identity,
      ...(proven.gitCommonDirIdentity !== undefined
        ? { gitCommonDirIdentity: proven.gitCommonDirIdentity }
        : {}),
      ...(bookmarkId !== undefined ? { rootBookmarkId: bookmarkId } : {}),
      ...(proven.remote !== undefined ? { remote: proven.remote } : {}),
      // The base for new worktrees is fetched by remote name; the proven
      // remote is `remote.origin.url`, so the name is `origin`.
      ...(stored?.fetchRemote !== undefined
        ? { fetchRemote: stored.fetchRemote }
        : proven.remote !== undefined
          ? { fetchRemote: 'origin' }
          : {}),
      ...(proven.defaultRef !== undefined ? { defaultRef: proven.defaultRef } : {}),
      ...(request.credentialRefId !== undefined
        ? { credentialRefId: request.credentialRefId }
        : stored?.credentialRefId !== undefined
          ? { credentialRefId: stored.credentialRefId }
          : {}),
      projectIds,
      version: stored ? stored.version + 1 : 1,
      updatedAt: new Date().toISOString(),
    }
    upsertRecord(next)
    return next
  }

  /** Read-only inspection facts from the canonical root. Local git reads
   *  only — this path never touches the network, and it never writes: a
   *  vanished checkout reports `unavailable` without mutating the record. */
  async function inspectionFacts(record: RepoRecord): Promise<RepoInspection> {
    const observedAt = new Date().toISOString()
    let identity: FileIdentityValue
    try {
      identity = identityOfPath(record.canonicalRoot)
    } catch {
      return {
        repo: { ...toRepoDto(record), lifecycle: 'unavailable' },
        rootIdentity: record.rootIdentity,
        dirty: false,
        observedAt,
      }
    }
    if (record.kind !== 'git') {
      return {
        repo: toRepoDto(record),
        rootIdentity: identity,
        dirty: false,
        observedAt,
      }
    }
    const [headRef, headSha, status] = await Promise.all([
      readGit(record.canonicalRoot, ['rev-parse', '--symbolic-full-name', 'HEAD']),
      readGit(record.canonicalRoot, ['rev-parse', 'HEAD']),
      readGit(record.canonicalRoot, ['status', '--porcelain']),
    ])
    const headRefName = headRef?.exitCode === 0 ? headRef.stdout.trim() || undefined : undefined
    const headShaValue =
      headSha?.exitCode === 0 && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(headSha.stdout.trim())
        ? headSha.stdout.trim()
        : undefined
    const dirty =
      status?.exitCode === 0 ? status.stdout.split('\n').some((line) => line.length > 0) : false
    return {
      repo: toRepoDto(record),
      rootIdentity: identity,
      ...(headRefName !== undefined ? { headRef: headRefName } : {}),
      ...(headShaValue !== undefined ? { headSha: headShaValue } : {}),
      dirty,
      observedAt,
    }
  }

  /** Persist the canonical facts a `refresh: true` inspection proved, but
   *  only when they actually moved — a proof that changes nothing is not a
   *  mutation and does not bump the version. */
  function persistProvenFacts(
    previous: RepoRecord,
    proven: Awaited<ReturnType<typeof proveBinding>>
  ): RepoRecord {
    const moved =
      previous.kind !== proven.kind ||
      previous.canonicalRoot !== proven.canonicalRoot ||
      !sameIdentity(previous.rootIdentity, proven.identity) ||
      previous.remote !== proven.remote ||
      previous.defaultRef !== proven.defaultRef
    if (!moved) return previous
    const next: RepoRecord = {
      ...previous,
      kind: proven.kind,
      canonicalRoot: proven.canonicalRoot,
      rootIdentity: proven.identity,
      ...(proven.gitCommonDirIdentity !== undefined
        ? { gitCommonDirIdentity: proven.gitCommonDirIdentity }
        : { gitCommonDirIdentity: undefined }),
      remote: proven.remote,
      defaultRef: proven.defaultRef,
      version: previous.version + 1,
      updatedAt: new Date().toISOString(),
    }
    upsertRecord(next)
    return next
  }

  /** Re-prove canonical identity and probe the remote offline-safe. The
   *  probe is a bounded `git ls-remote origin HEAD` — git transport applies
   *  any insteadOf rewrite itself, exactly like the #397 fetch and #423
   *  remote probes. Failure is a typed `stale` lifecycle, never a crash and
   *  never a fabricated success; a vanished checkout persists `unavailable`.
   *  A refresh that proves nothing new is not a mutation and keeps the
   *  version. */
  async function refreshRecord(stored: RepoRecord): Promise<RepoRecord> {
    let next: RepoRecord = { ...stored }
    if (!isRealDirectory(stored.canonicalRoot)) {
      next = { ...next, lifecycle: 'unavailable' }
    } else {
      const proven = await proveRecord(stored)
      let lifecycle: RepoRecord['lifecycle'] = 'ready'
      if (proven.kind === 'git') {
        const probe = await git(['ls-remote', 'origin', 'HEAD'], {
          cwd: proven.canonicalRoot,
          timeoutMs: LS_REMOTE_TIMEOUT_MS,
          maxOutputBytes: GIT_READ_MAX_OUTPUT_BYTES,
        }).catch(() => undefined)
        if (probe?.exitCode !== 0) lifecycle = 'stale'
      }
      next = {
        ...next,
        kind: proven.kind,
        canonicalRoot: proven.canonicalRoot,
        rootIdentity: proven.identity,
        ...(proven.gitCommonDirIdentity !== undefined
          ? { gitCommonDirIdentity: proven.gitCommonDirIdentity }
          : { gitCommonDirIdentity: undefined }),
        remote: proven.remote,
        defaultRef: proven.defaultRef,
        lifecycle,
      }
    }
    const unchanged =
      next.kind === stored.kind &&
      next.canonicalRoot === stored.canonicalRoot &&
      sameIdentity(next.rootIdentity, stored.rootIdentity) &&
      next.remote === stored.remote &&
      next.defaultRef === stored.defaultRef &&
      next.lifecycle === stored.lifecycle
    if (unchanged) return stored
    const updated: RepoRecord = {
      ...next,
      version: stored.version + 1,
      updatedAt: new Date().toISOString(),
    }
    upsertRecord(updated)
    return updated
  }

  /** Reconcile the primary checkout record, then reply with the DTO. */
  async function reconciled(record: RepoRecord): Promise<Repo> {
    await input.onRepoProven?.(record.id)
    return toRepoDto(record)
  }

  const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
    // The one registry serves the listing too (ADR 0011): the worktree
    // service reads these same records, so the list and every worktree
    // operation agree on which repositories exist.
    'dev.repo.list': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.repo.list'].request(command.body)
      const projectId = body.projectId as string | undefined
      const records = registry
        .load()
        .filter(
          (entry) =>
            sameScope(entry.scope, input.scope) &&
            (projectId === undefined || entry.projectIds.includes(projectId))
        )
        .map(toRepoDto)
      const pageSize = (body.limit as number | undefined) ?? 100
      let start = 0
      if (body.cursor !== undefined) {
        const decoded = Number(Buffer.from(body.cursor as string, 'base64url').toString('utf8'))
        if (!Number.isSafeInteger(decoded) || decoded < 0)
          throw devError('not_found', 'unknown listing cursor')
        start = decoded
      }
      const items = records.slice(start, start + pageSize)
      const nextCursor =
        start + pageSize < records.length
          ? Buffer.from(String(start + pageSize)).toString('base64url')
          : undefined
      return {
        items,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        observedAt: new Date().toISOString(),
      }
    },

    'dev.repo.adopt': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.repo.adopt'].request(command.body)
      const repoId = body.repoId as string
      const expectedVersion = body.expectedVersion as number
      requireRepoResource(command, repoId, expectedVersion)
      return adoptOrAuthorize({
        repoId,
        rootBookmarkId: body.rootBookmarkId as string,
        credentialRefId: undefined,
        expectedVersion,
      }).then(reconciled)
    },

    'dev.repo.authorize': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.repo.authorize'].request(command.body)
      const repoId = body.repoId as string
      const expectedVersion = body.expectedVersion as number
      requireRepoResource(command, repoId, expectedVersion)
      return adoptOrAuthorize({
        repoId,
        rootBookmarkId: undefined,
        credentialRefId: body.credentialRefId as string,
        expectedVersion,
      }).then(reconciled)
    },

    'dev.repo.inspect': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.repo.inspect'].request(command.body)
      const repoId = body.repoId as string
      const stored = findRecord(repoId)
      if (!stored) {
        if (input.findRepoBindings(repoId).length > 0)
          throw new DevAuthorityError(
            'invalid_state',
            'repository has not been adopted yet; adopt it before inspection'
          )
        throw new DevAuthorityError(
          'not_found',
          'repository is not registered on this runtime node'
        )
      }
      requireRepoResource(command, repoId, stored.version)
      const provenPromise =
        body.refresh === true
          ? proveRecord(stored)
              .then((proven) => persistProvenFacts(stored, proven))
              .then(async (record) => {
                await input.onRepoProven?.(record.id)
                return record
              })
          : Promise.resolve(stored)
      return provenPromise.then((record) => inspectionFacts(record))
    },

    'dev.repo.refresh': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.repo.refresh'].request(command.body)
      const repoId = body.repoId as string
      const expectedVersion = body.expectedVersion as number
      const stored = findRecord(repoId)
      if (!stored)
        throw new DevAuthorityError(
          'not_found',
          'repository is not registered on this runtime node'
        )
      if (stored.version !== expectedVersion)
        throw new DevAuthorityError(
          'stale_version',
          `repository ${stored.id} moved on: version ${stored.version}`,
          stored.version
        )
      requireRepoResource(command, repoId, stored.version)
      return refreshRecord(stored).then(reconciled)
    },
  }

  for (const [operation, provider] of Object.entries(providers)) {
    const operationProvider = provider as (command: DevCommand) => unknown
    input.authority.registerCommandProvider(operation as DevOperation, async (command) =>
      operationProvider(command)
    )
  }
  return { providers }
}
