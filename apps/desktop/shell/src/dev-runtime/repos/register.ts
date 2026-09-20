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
  RedactedRemote,
  Repo,
  RepoInspection,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import { DevAuthorityError, sameScope, type DevScope } from '../authority'
import type { ChannelAuthority } from '../channel/authority'
import { createDurableJsonStore } from '../host-store'
import { identityOfPath, sameIdentity, type FileIdentityValue } from '../worktrees/identity'
import { runGit, type GitRunResult } from '../worktrees/git-run'

export type RepoRuntime = Readonly<{
  providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>>
}>

/**
 * The registry store record. `remote` keeps the raw configured URL so
 * canonical identity can be re-proven later; every DTO redacts it
 * (`redactRemoteUrl`) and the secret never enters a reply, event, or log.
 * `lifecycle` is durable repo truth: `ready` (proven), `stale` (the remote
 * could not be re-proven at the last refresh), `unavailable` (the canonical
 * root was missing on disk at the last refresh). `authorizing` and
 * `refreshing` are transient spec states that are never persisted or
 * returned by this synchronous provider.
 */
type RepoRecord = Readonly<{
  id: string
  scope: DevScope
  kind: 'git' | 'folder'
  lifecycle: 'ready' | 'stale' | 'unavailable'
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  gitCommonDirIdentity?: FileIdentityValue
  rootBookmarkId: string
  remote?: string
  defaultRef?: string
  credentialRefId?: string
  projectIds: readonly string[]
  version: number
  updatedAt: string
}>

const REGISTRY_STORE_FILE = join('dev-runtime', 'repos', 'registry.json')
const REGISTRY_SCHEMA_VERSION = 1
const LS_REMOTE_TIMEOUT_MS = 10_000

/** Inspect/refresh reads are bounded: fixed budgets, machine output only, and
 *  the shared child environment already sets `GIT_TERMINAL_PROMPT=0` and
 *  `GIT_OPTIONAL_LOCKS=0` (no prompts, no index lock on read paths). */
const GIT_READ_TIMEOUT_MS = 10_000
const GIT_READ_MAX_OUTPUT_BYTES = 1024 * 1024

const corruptRecord = () =>
  new DevAuthorityError('corrupt_state', 'repository registry record failed to decode')

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Structural decode of a stored record; anything else is `corrupt_state`. */
function validateStoredRecord(record: RepoRecord): void {
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof record.id !== 'string' ||
    (record.kind !== 'git' && record.kind !== 'folder') ||
    (record.lifecycle !== 'ready' &&
      record.lifecycle !== 'stale' &&
      record.lifecycle !== 'unavailable') ||
    typeof record.canonicalRoot !== 'string' ||
    record.canonicalRoot.length < 1 ||
    typeof record.rootBookmarkId !== 'string' ||
    !Array.isArray(record.projectIds) ||
    record.projectIds.some((id) => typeof id !== 'string') ||
    !isPositiveInteger(record.version) ||
    typeof record.updatedAt !== 'string' ||
    typeof record.rootIdentity?.mtimeNs !== 'string' ||
    typeof record.rootIdentity?.size !== 'string'
  )
    throw corruptRecord()
}

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

/** Remote URLs are redacted before any DTO: embedded user-info is removed
 *  while full nested namespace paths are preserved. SCP-like remotes
 *  (`git@host:owner/repo.git`) are parsed structurally, never with a shell;
 *  an unparseable remote redacts to an `unknown` host rather than guessing. */
export function redactRemoteUrl(remote: string): RedactedRemote {
  const trimmed = remote.trim()
  const scpLike = /^([^@\s]+)@([^@\s:]+):(.+)$/.exec(trimmed)
  let host: string
  let ownerPath: string
  let displayUrl: string
  if (scpLike) {
    host = (scpLike[2] ?? '').toLowerCase()
    ownerPath = (scpLike[3] ?? '').replace(/\.git$/, '')
    displayUrl = `${scpLike[2] ?? ''}:${ownerPath}`
  } else {
    try {
      const parsed = new URL(trimmed)
      host = parsed.host !== '' ? parsed.host.toLowerCase() : 'unknown'
      ownerPath = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '')
      displayUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\.git$/, '')
    } catch {
      host = 'unknown'
      ownerPath = ''
      displayUrl = ''
    }
  }
  const provider =
    host === 'github.com' || host.endsWith('.github.com')
      ? 'github'
      : host === 'gitlab.com' || host.endsWith('.gitlab.com')
        ? 'gitlab'
        : 'other'
  return { provider, host, ownerPath, displayUrl }
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
}): RepoRuntime {
  const git = input.runGit ?? runGit
  const store = createDurableJsonStore<RepoRecord>({
    file: join(input.dataDir, REGISTRY_STORE_FILE),
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    label: 'repository registry',
  })

  function loadRecords(): RepoRecord[] {
    const records = [...store.load().records]
    for (const record of records) validateStoredRecord(record)
    return records
  }

  function saveRecords(records: readonly RepoRecord[]): void {
    store.save([...records])
  }

  function findRecord(repoId: string): RepoRecord | undefined {
    return loadRecords().find((entry) => entry.id === repoId)
  }

  function upsertRecord(next: RepoRecord): void {
    const records = loadRecords()
    const index = records.findIndex((entry) => entry.id === next.id)
    if (index >= 0) records[index] = next
    else records.push(next)
    saveRecords(records)
  }

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
   *  and anything else is a plain folder workspace. */
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

  function toRepoDto(record: RepoRecord): Repo {
    const remote = record.remote !== undefined ? redactRemoteUrl(record.remote) : undefined
    return {
      id: record.id,
      scope: record.scope,
      kind: record.kind,
      lifecycle: record.lifecycle,
      canonicalRoot: record.canonicalRoot,
      ...(record.gitCommonDirIdentity !== undefined
        ? { gitCommonDirIdentity: record.gitCommonDirIdentity }
        : {}),
      ...(remote !== undefined ? { remote } : {}),
      ...(record.defaultRef !== undefined ? { defaultRef: record.defaultRef } : {}),
      projectIds: [...record.projectIds],
      version: record.version,
    }
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
    // The proof bookmark: adopt names one from the command; authorize
    // re-proves the recorded (or first binding) bookmark. A client never
    // supplies a path — the canonical root comes from the binding or record.
    const bookmarkId =
      request.rootBookmarkId ?? stored?.rootBookmarkId ?? bindings[0]!.rootBookmarkId
    const canonicalRoot = stored?.canonicalRoot ?? bindings[0]!.canonicalRoot
    const proven = await proveBinding({ canonicalRoot, rootBookmarkId: bookmarkId })
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
      rootIdentity: proven.identity,
      ...(proven.gitCommonDirIdentity !== undefined
        ? { gitCommonDirIdentity: proven.gitCommonDirIdentity }
        : {}),
      rootBookmarkId: bookmarkId,
      ...(proven.remote !== undefined ? { remote: proven.remote } : {}),
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
      const proven = await proveBinding({
        canonicalRoot: stored.canonicalRoot,
        rootBookmarkId: stored.rootBookmarkId,
      })
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

  const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
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
      }).then(toRepoDto)
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
      }).then(toRepoDto)
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
          ? proveBinding({
              canonicalRoot: stored.canonicalRoot,
              rootBookmarkId: stored.rootBookmarkId,
            }).then((proven) => persistProvenFacts(stored, proven))
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
      return refreshRecord(stored).then(toRepoDto)
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
