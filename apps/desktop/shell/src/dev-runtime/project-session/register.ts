import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ArchiveRecord,
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  Project,
  ProjectRepoBinding,
  RuntimeSession,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import { DevAuthorityError } from '../authority'
import { createDurableSqliteStore } from '../host-store'
import { GitChildKilledError, runGit } from '../worktrees/git-run'
import { WorktreeError } from '../worktrees/errors'
import { nonInteractiveTransportEnv } from '../repos/managed'
import {
  admitCloneRemote,
  buildCloneUrl,
  classifyTransport,
  transportArgs,
  type CloneRemoteInput,
} from '../projects/clone-policy'

export type ProjectRepoBindingView = Readonly<{
  repoId: string
  rootBookmarkId: string
  canonicalRoot: string
  projectId: string
}>

export type ProjectSessionRuntime = Readonly<{
  providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>>
  /** Seeds or advances one binding; `project.id` is the cloud project id. */
  upsertProject(project: Project): void
  upsertSession(session: RuntimeSession): void
  /** Read-only resolution for sibling slices (e.g. the harness substrate);
   * it grants no authority — every gated operation re-checks its own
   * scope/resource/generation bindings after resolving the record. */
  getSession(runtimeSessionId: string): RuntimeSession | undefined
  /** Read-only resolution for the repository registry (#398): the binding
   * triples minted at import, one per project that binds the repo. They name
   * the authorized bookmark and canonical root; they prove nothing at use
   * time — the repo registry re-proves containment and identity through the
   * roots authority itself. */
  findRepoBindings(repoId: string): readonly ProjectRepoBindingView[]
  /** `dev.project.clone` pre-check: the cloud project id is a lowercase UUID
   * with no local binding yet (`identity_mismatch` otherwise). */
  assertUnboundProjectId(projectId: string): void
  /** `dev.project.clone` commit: bind one managed bare clone to an unbound
   * cloud project id. Re-checks the id under the same record write, so a
   * concurrent bind loses with `identity_mismatch`. */
  bindManagedClone(input: {
    projectId: string
    repoId: string
    canonicalRoot: string
    defaultBaseRef?: string
  }): Project
  /** Test/ops introspection: the durable archive journal, oldest first. */
  archiveRecords(): readonly ArchiveRecord[]
}>

/**
 * The canonical project/runtime-session authority shared by Dev View and Chat.
 *
 * One v2 snapshot record commits project bindings, sessions, and the archive
 * journal together, so `dev.session.archive`/`dev.session.unarchive` persist
 * the session flip and its `ArchiveRecord` in one SQLite transaction. A
 * binding is keyed by the cloud project id and holds only local facts
 * (repositories, base ref, lifecycle): the cloud owns project names, order,
 * and grouping. The authority database uses WAL/full sync. Records written by
 * the v1 schema (groups, local project names) live in differently named files
 * and are left on disk unread — never migrated, rewritten, or deleted.
 *
 * Every mutation enforces the scope triple (a foreign scope is
 * `unauthorized`, never a silent drop), the ownership epoch
 * (`stale_generation` for a lower generation), and optimistic concurrency
 * (`stale_version` for a non-advancing version). Reads fail closed on a stored
 * record that no longer decodes (`corrupt_state`); unknown state is never
 * coerced into success.
 */

/** One local repository binding for a cloud project. */
type ProjectBinding = Readonly<{
  /** The cloud project id (opaque lowercase UUID supplied by the client). */
  projectId: string
  repoIds: string[]
  /** Authoritative repository bindings minted at import. */
  repos?: ProjectRepoBinding[]
  preferredRuntimeNodeId?: string
  defaultBaseRef?: string
  bootstrapWorkflowId?: string
  defaultHarnessId?: string
  lifecycle: Project['lifecycle']
  version: number
}>

type AuthorityRecord = Readonly<{
  scope: Scope
  projects: ProjectBinding[]
  sessions: RuntimeSession[]
  archiveRecords: ArchiveRecord[]
  /** One canonical session per create key within the protocol retention window. */
  sessionCreates?: ReadonlyArray<{
    keyHash: string
    bodyHash: string
    sessionId: string
    createdAt: string
  }>
}>

const AUTHORITY_STORE_DIRECTORY = join('dev-runtime', 'project-session')
/** v2 partitions carry the schema version in their file name, so a v1
 * `authority.sqlite3` / `authority-<digest>.sqlite3` file is never opened. */
const AUTHORITY_STORE_PREFIX = 'authority-v2-'
const AUTHORITY_SCHEMA_VERSION = 2
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The bounded clone window: a shallow clone of a normal repository is
 *  seconds of work; a loaded host or a large default branch gets a full
 *  minute before the child is abandoned. The runner enforces it. */
const GIT_CLONE_TIMEOUT_MS = 60_000

const SESSION_CREATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const HASH_PATTERN = /^[0-9a-f]{64}$/

const PROJECT_STATES: ReadonlySet<string> = new Set([
  'importing',
  'cloning',
  'scanning',
  'ready',
  'archived',
  'failed',
])
const SESSION_STATES: ReadonlySet<string> = new Set([
  'preparing',
  'ready',
  'active',
  'disconnected',
  'completed',
  'failed',
  'cancelled',
])
const ARCHIVE_STATES: ReadonlySet<string> = new Set(['archived', 'restoring', 'restored'])
/** Session states that still reference execution; archive refuses while any
 * session on the project is in one of these and not itself archived. */
const LIVE_SESSION_STATES: ReadonlySet<string> = new Set([
  'preparing',
  'ready',
  'active',
  'disconnected',
])
const SESSION_PROJECTIONS: ReadonlySet<string> = new Set([
  'structured',
  'authenticated_hook',
  'terminal_fallback',
])

function isScope(value: unknown): value is Scope {
  const record = value as Scope | undefined
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.accountId === 'string' &&
    typeof record.workspaceId === 'string' &&
    typeof record.runtimeNodeId === 'string'
  )
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

const corruptRecord = () =>
  new DevAuthorityError('corrupt_state', 'authority store record failed to decode')

/** Structural decode of a stored record; anything else is `corrupt_state`. */
function validateStoredRecord(record: AuthorityRecord): void {
  const fail = corruptRecord
  if (!isScope(record.scope)) throw fail()
  if (!Array.isArray(record.projects)) throw fail()
  if ('groups' in record) throw fail()
  if (!Array.isArray(record.sessions) || !Array.isArray(record.archiveRecords)) throw fail()
  if (record.sessionCreates !== undefined) {
    if (!Array.isArray(record.sessionCreates)) throw fail()
    for (const created of record.sessionCreates) {
      if (
        typeof created !== 'object' ||
        created === null ||
        !HASH_PATTERN.test(created.keyHash) ||
        !HASH_PATTERN.test(created.bodyHash) ||
        typeof created.sessionId !== 'string' ||
        typeof created.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(created.createdAt))
      )
        throw fail()
    }
  }
  const scope = record.scope
  const inScope = (candidate: unknown) =>
    isScope(candidate) && JSON.stringify(candidate) === JSON.stringify(scope)
  const positive = (value: unknown) => isPositiveInteger(value)
  for (const project of record.projects) {
    if (
      typeof project !== 'object' ||
      project === null ||
      typeof project.projectId !== 'string' ||
      !UUID_PATTERN.test(project.projectId) ||
      'name' in project ||
      'groupIds' in project ||
      !Array.isArray(project.repoIds) ||
      project.repoIds.some((id) => typeof id !== 'string') ||
      (project.repos !== undefined && !Array.isArray(project.repos)) ||
      !PROJECT_STATES.has(project.lifecycle) ||
      !positive(project.version)
    )
      throw fail()
  }
  for (const session of record.sessions) {
    if (
      typeof session !== 'object' ||
      session === null ||
      typeof session.id !== 'string' ||
      typeof session.projectId !== 'string' ||
      typeof session.repoId !== 'string' ||
      typeof session.worktreeId !== 'string' ||
      typeof session.archived !== 'boolean' ||
      !SESSION_STATES.has(session.lifecycle) ||
      !SESSION_PROJECTIONS.has(session.projection) ||
      !positive(session.version) ||
      !positive(session.generation) ||
      !inScope(session.scope)
    )
      throw fail()
  }
  for (const archive of record.archiveRecords) {
    if (
      typeof archive !== 'object' ||
      archive === null ||
      typeof archive.id !== 'string' ||
      typeof archive.runtimeSessionId !== 'string' ||
      typeof archive.worktreeId !== 'string' ||
      typeof archive.archivedAt !== 'string' ||
      typeof archive.archivedBy !== 'string' ||
      !ARCHIVE_STATES.has(archive.state) ||
      !positive(archive.generation) ||
      !inScope(archive.scope)
    )
      throw fail()
  }
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function page<T>(items: readonly T[]): DevRuntimePage<T> {
  return { items: [...items], observedAt: new Date().toISOString() }
}

function requireScope(command: DevCommand, scope: Scope): void {
  if (!sameScope(command.scope, scope))
    throw new DevAuthorityError('unauthorized', 'project/session scope is not authorized')
}

function devError(code: DevError['code'], message: string): DevError {
  return { code, retryable: false, message }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId])
}

/**
 * One durable file belongs to one authority scope and schema version. The v2
 * name differs from every v1 file name, so opening v2 never reads, rewrites,
 * or deletes a v1 database; v1 rows are left on disk unread.
 */
function authorityStoreFile(dataDir: string, scope: Scope): string {
  return join(
    dataDir,
    AUTHORITY_STORE_DIRECTORY,
    `${AUTHORITY_STORE_PREFIX}${sha256Text(scopeKey(scope))}.sqlite3`
  )
}

/** The envelope resource for runtime_session operations must name this
 * session at its current generation: a stale or foreign binding is refused
 * before the provider touches the record. */
function requireSessionResource(command: DevCommand, session: RuntimeSession): void {
  const resource = command.resource
  if (resource === undefined) {
    throw devError('identity_mismatch', 'operation requires a runtime_session resource binding')
  }
  if (resource.kind !== 'runtime_session') {
    throw devError('identity_mismatch', 'resource kind must be runtime_session')
  }
  if (resource.id !== session.id) {
    throw devError('identity_mismatch', 'resource id does not match the request body')
  }
  if (resource.generation !== session.generation) {
    throw devError('stale_generation', 'resource generation does not match the session record')
  }
}

/** Project operations carry a project resource binding. Projects fence
 * through their optimistic version alone, so the envelope's numeric
 * generation must equal that version (spec: a record without a `generation`
 * field binds its resource generation to its `version`). */
function requireProjectResource(command: DevCommand, projectId: string): void {
  const resource = command.resource
  if (resource === undefined) {
    throw devError('identity_mismatch', 'operation requires a project resource binding')
  }
  if (resource.kind !== 'project') {
    throw devError('identity_mismatch', 'resource kind must be project')
  }
  if (resource.id !== projectId) {
    throw devError('identity_mismatch', 'resource id does not match the request body')
  }
}

function archiveRecord(
  session: RuntimeSession,
  scope: Scope,
  state: ArchiveRecord['state'],
  reason?: string
): ArchiveRecord {
  return {
    id: randomUUID(),
    scope,
    runtimeSessionId: session.id,
    worktreeId: session.worktreeId,
    state,
    archivedAt: new Date().toISOString(),
    archivedBy: 'desktop-owner',
    generation: session.generation,
    ...(reason ? { reason } : {}),
    ...(state === 'restored' ? { restoredAt: new Date().toISOString() } : {}),
  }
}

export function registerProjectSessionRuntime(input: {
  authority: ChannelAuthority
  dataDir: string
  scope: Scope
  /** Shell event bus; session changes publish so Chat and Dev share them. */
  publish?: (event: string, payload: unknown) => void
  /** Fail-closed creation hook: the composition proves the worktree exists
   *  and belongs to this scope before a session record is created. */
  validateSessionCreation?: (body: {
    projectId: string
    repoId: string
    worktreeId: string
  }) => void
  /**
   * Fail-closed import hook (#398): the composition resolves an authorized
   * root bookmark through the roots authority and returns its canonical
   * root. Any refusal (unknown, revoked, drifted, replaced) throws before
   * the register touches the record; client-supplied paths never reach it.
   */
  resolveImportRoot?: (rootBookmarkId: string) => { canonicalRoot: string }
  /**
   * Bookmark-minting hook for the clone-URL import kind (`dev.project.clone`):
   * after a bounded clone lands inside an authorized destination root, the
   * composition mints the clone's bookmark through the roots authority (the
   * owner's approve action is the command itself, issued over the
   * scope-bound channel). Absent, the clone kind refuses `unavailable`
   * instead of importing an unauthorized path.
   */
  authorizeRoot?: (absolutePath: string, label: string) => { id: string }
  /**
   * Test seam: inject the bounded clone runner; production shells out to the
   * real bounded git runner. Returns the child's exit code.
   */
  runClone?: (args: {
    argv: readonly string[]
    cwd: string
  }) => Promise<{ exitCode: number; stderr?: string }>
  /**
   * `dev.project.clone` with `mode: 'managed'` (remote-only projects): the
   * composition's managed clone authority places a bare clone under the
   * owner-only app-data root. Absent, the managed mode refuses `unavailable`.
   */
  managedClone?: (request: {
    projectId: string
    remote: CloneRemoteInput
    credentialRefId?: string
    defaultBaseRef?: string
  }) => Promise<Project>
  /**
   * Test-only: admit `file://` clone remotes (fixture origins) in both clone
   * modes. The shipped shell composition never sets it.
   */
  allowLocalCloneRemotes?: boolean
  /**
   * Unbind side effects for managed bare clones (remote-only projects). The
   * register calls `prepare` after its own refusals (version, live
   * sessions) and before removing the binding; a refusal there leaves the
   * binding intact. `commit` runs after the binding is durably removed and
   * `rollback` when that write fails. Unbinding an ordinary binding never
   * calls this hook and never touches files.
   */
  managedUnbind?: (project: Project) => Promise<
    | Readonly<{
        commit(): void
        rollback(): void
      }>
    | undefined
  >
  /**
   * Bound-project notification (auto-adopt): the register fires it once,
   * after a binding is durably written by `dev.project.import`,
   * `dev.project.create`, or the checkout-clone import path. The hook is
   * never awaited — a command reply must not wait on adoption — and the
   * register contains a synchronous throw, so the binding always stands
   * even when the hook fails. It never runs for `bindManagedClone` (the
   * managed path writes the registry record itself) and never runs again
   * on load: auto-adopt is an import/creation side effect, not a
   * reconciler, so removing a registry record is never silently undone.
   */
  onProjectBound?: (project: Project) => void
}): ProjectSessionRuntime {
  const store = createDurableSqliteStore<AuthorityRecord>({
    file: authorityStoreFile(input.dataDir, input.scope),
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    label: 'project/session authority',
    scope: input.scope,
  })
  const emptyRecord = (): AuthorityRecord => ({
    scope: input.scope,
    projects: [],
    sessions: [],
    archiveRecords: [],
    sessionCreates: [],
  })
  const loaded = store.load()
  let record: AuthorityRecord = loaded.records[0] ?? emptyRecord()
  validateStoredRecord(record)
  if (!sameScope(record.scope, input.scope))
    throw new DevAuthorityError(
      'corrupt_state',
      'authority store belongs to another account/workspace/runtime node'
    )
  const save = () => store.save([record])

  /** The wire record for one binding: `id` is the cloud project id. */
  const toProject = (binding: ProjectBinding): Project => {
    const { projectId, ...rest } = binding
    return { id: projectId, scope: input.scope, ...rest }
  }
  const findBinding = (projectId: string): ProjectBinding => {
    const binding = record.projects.find((entry) => entry.projectId === projectId)
    if (!binding) throw new DevAuthorityError('not_found', `project ${projectId} is unknown`)
    return binding
  }
  const requireExpectedVersion = (binding: ProjectBinding, expectedVersion: number) => {
    if (binding.version !== expectedVersion)
      throw new DevAuthorityError(
        'stale_version',
        `project ${binding.projectId} moved on: version ${binding.version}`,
        binding.version
      )
  }
  /** Bindings are keyed by the client-supplied cloud project id: a second
   * binding for the same id is an identity collision, never a silent merge. */
  const requireUnboundProjectId = (projectId: string) => {
    if (!UUID_PATTERN.test(projectId))
      throw new DevAuthorityError('identity_mismatch', 'project id must be a lowercase UUID')
    if (record.projects.some((entry) => entry.projectId === projectId))
      throw new DevAuthorityError(
        'identity_mismatch',
        `cloud project ${projectId} already has a local binding`
      )
  }
  const replaceBinding = (next: ProjectBinding) => {
    record = {
      ...record,
      projects: record.projects.map((entry) => (entry.projectId === next.projectId ? next : entry)),
    }
  }
  /** Sessions that still reference execution block archive and unbind. */
  const liveSessionCount = (projectId: string) =>
    record.sessions.filter(
      (session) =>
        session.projectId === projectId &&
        !session.archived &&
        LIVE_SESSION_STATES.has(session.lifecycle)
    ).length

  /** Optimistic-concurrency upsert shared by every entity kind. */
  const upsert = <T extends { id: string; scope: Scope; version: number; generation?: number }>(
    list: T[],
    incoming: T
  ): T[] => {
    if (!sameScope(incoming.scope, input.scope))
      throw new DevAuthorityError('unauthorized', 'record scope is not authorized')
    const stored = list.find((entry) => entry.id === incoming.id)
    if (stored) {
      if (incoming.generation !== undefined && incoming.generation < stored.generation!)
        throw new DevAuthorityError(
          'stale_generation',
          `record ${incoming.id} is owned by generation ${stored.generation}`,
          incoming.version
        )
      if (incoming.version <= stored.version)
        throw new DevAuthorityError(
          'stale_version',
          `record ${incoming.id} version ${incoming.version} does not advance ${stored.version}`,
          stored.version
        )
      return list.map((entry) => (entry.id === incoming.id ? incoming : entry))
    }
    return [...list, incoming]
  }

  const findSession = (id: string): RuntimeSession => {
    const session = record.sessions.find((entry) => entry.id === id)
    if (!session) throw new DevAuthorityError('not_found', `runtime session ${id} is unknown`)
    return session
  }

  function publishSession(session: RuntimeSession, kind: string): void {
    input.publish?.('dev.session.updated', {
      kind,
      runtimeSessionId: session.id,
      scope: session.scope,
      generation: session.generation,
      version: session.version,
      archived: session.archived,
      lifecycle: session.lifecycle,
      observedAt: new Date().toISOString(),
    })
  }

  function publishProject(project: Project, kind: string): void {
    input.publish?.('dev.project.updated', {
      kind,
      projectId: project.id,
      scope: project.scope,
      version: project.version,
      lifecycle: project.lifecycle,
      observedAt: new Date().toISOString(),
    })
  }

  /**
   * The one import path (#398): bind an authorized root bookmark to a cloud
   * project id in a single atomic snapshot write. Both import kinds — the
   * owner-authorized local root (`dev.project.import`) and the bounded clone
   * (`dev.project.clone`) — end here, so refusal semantics cannot drift.
   */
  function importAuthorizedRoot(
    projectId: string,
    rootBookmarkId: string,
    preferredRuntimeNodeId: string | undefined,
    canonicalRoot: string
  ): Project {
    // One canonical root is bound once: a second registration for the same
    // bookmark is an identity collision, not a silent duplicate.
    if (
      record.projects.some((project) =>
        project.repos?.some((repo) => repo.rootBookmarkId === rootBookmarkId)
      )
    )
      throw new DevAuthorityError(
        'identity_mismatch',
        'a project is already bound to this authorized root'
      )
    const repoId = randomUUID()
    const created: ProjectBinding = {
      projectId,
      repoIds: [repoId],
      repos: [{ repoId, rootBookmarkId, canonicalRoot }],
      lifecycle: 'ready',
      version: 1,
      ...(preferredRuntimeNodeId !== undefined ? { preferredRuntimeNodeId } : {}),
    }
    record = { ...record, projects: [...record.projects, created] }
    save()
    const projected = toProject(created)
    notifyBound(projected)
    return projected
  }

  /**
   * Fire the auto-adopt notification once the binding is durable. The hook
   * is fire-and-forget: a synchronous failure must never fail or roll back
   * the import/creation that already committed.
   */
  function notifyBound(project: Project): void {
    try {
      input.onProjectBound?.(project)
    } catch {
      // Best-effort by contract; the binding stands.
    }
  }

  const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
    'dev.project.list': (command) => {
      requireScope(command, input.scope)
      return page(record.projects.map(toProject))
    },
    'dev.project.get': (command) => {
      requireScope(command, input.scope)
      const projectId = (command.body as { projectId: string }).projectId
      return toProject(findBinding(projectId))
    },
    'dev.project.import': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.import'].request(command.body)
      const projectId = body.projectId as string
      requireUnboundProjectId(projectId)
      // The canonical root never comes from the command: the composition
      // resolves the authorized bookmark fail-closed (unknown, revoked,
      // drifted, or replaced roots throw before this record is touched).
      if (!input.resolveImportRoot) {
        throw new DevAuthorityError(
          'not_found',
          'no authorized root authority is available for project import'
        )
      }
      const root = input.resolveImportRoot(body.rootBookmarkId as string)
      return importAuthorizedRoot(
        projectId,
        body.rootBookmarkId as string,
        body.preferredRuntimeNodeId as string | undefined,
        root.canonicalRoot
      )
    },
    'dev.project.clone': async (command) => {
      requireScope(command, input.scope)
      // Top-level clone names its target in the body; no envelope resource.
      if (command.resource !== undefined)
        throw new DevAuthorityError(
          'identity_mismatch',
          'dev.project.clone carries no resource binding'
        )
      const body = devOperationDecoders['dev.project.clone'].request(command.body)
      const projectId = body.projectId as string
      // An already-bound cloud project refuses before any clone runs.
      requireUnboundProjectId(projectId)
      // The remote arrives redacted into parts (never a raw URL body): the
      // provider reconstructs the URL from trusted components. The owner's
      // approve action over the scope-bound channel is the authorization for
      // both the destination root and the clone itself.
      const remote = body.remote as CloneRemoteInput
      const credentialRefId = body.credentialRefId as string | undefined
      const defaultBaseRef = body.defaultBaseRef as string | undefined
      const destinationBookmarkId = body.destinationBookmarkId as string | undefined
      // `managed` (remote-only project): a hidden bare clone in owner-only
      // app data with no primary checkout. It never uses a user path.
      if (body.mode === 'managed') {
        if (destinationBookmarkId !== undefined)
          throw new DevAuthorityError(
            'invalid_state',
            'a managed clone lives in app data and takes no destination bookmark'
          )
        if (!input.managedClone)
          throw new DevAuthorityError('unavailable', 'no managed clone authority is available')
        return input.managedClone({
          projectId,
          remote,
          ...(credentialRefId !== undefined ? { credentialRefId } : {}),
          ...(defaultBaseRef !== undefined ? { defaultBaseRef } : {}),
        })
      }
      // `checkout` (the default, #1061): a working copy inside an authorized
      // destination bookmark, imported through the shared import path.
      if (destinationBookmarkId === undefined)
        throw new DevAuthorityError(
          'invalid_state',
          'a checkout clone requires an authorized destination bookmark'
        )
      if (defaultBaseRef !== undefined)
        throw new DevAuthorityError(
          'invalid_state',
          'defaultBaseRef applies to managed clones; a checkout clone uses its own HEAD'
        )
      if (credentialRefId !== undefined) {
        // Private-remote clones need vault credential wiring that no slice
        // has shipped; refuse typed instead of attempting an unauthenticated
        // clone against a private host.
        throw new DevAuthorityError(
          'unavailable',
          'credential-backed clone sources are not wired yet; use a publicly readable remote'
        )
      }
      if (!input.resolveImportRoot) {
        throw new DevAuthorityError(
          'not_found',
          'no authorized root authority is available for project clone'
        )
      }
      const destination = input.resolveImportRoot(destinationBookmarkId)
      const cloneUrl = buildCloneUrl(remote)
      // The shared transport policy: https/ssh only (`file://` only behind
      // the test flag), every other transport refused by git itself.
      const protocol = admitCloneRemote(cloneUrl, {
        allowLocalRemotes: input.allowLocalCloneRemotes === true,
      })
      const targetDir = join(destination.canonicalRoot, 'clones', remote.repository)
      if (existsSync(targetDir)) {
        throw new DevAuthorityError(
          'invalid_state',
          `the clone destination already exists: ${targetDir}`
        )
      }
      const runClone =
        input.runClone ??
        ((args: { argv: readonly string[]; cwd: string }) =>
          runGit(args.argv.slice(1), {
            cwd: args.cwd,
            timeoutMs: GIT_CLONE_TIMEOUT_MS,
            // Nothing may prompt: batch-mode SSH and no askpass/terminal prompt.
            env: nonInteractiveTransportEnv(),
          }))
      // `--depth 1`: the import kind provisions a working copy, not history.
      const argv = [
        'git',
        ...transportArgs(protocol),
        'clone',
        '--depth',
        '1',
        '--',
        cloneUrl,
        targetDir,
      ] as const
      let result: { exitCode: number; stderr?: string }
      try {
        result = await runClone({ argv, cwd: destination.canonicalRoot })
      } catch (error) {
        // The runner reaps a killed child before rejecting. A partial
        // checkout left in the user's authorized root is never deleted by
        // Adea: it is reported, typed, for the owner to inspect.
        if (error instanceof GitChildKilledError && existsSync(targetDir))
          throw new WorktreeError(
            'cleanup_partial',
            `the clone was stopped (${error.code}) and left a partial checkout at ${targetDir}`
          )
        throw error
      }
      if (result.exitCode !== 0) {
        const message = `git clone exited ${result.exitCode} for the authorized destination`
        // A runner that reports stderr gets the shared typed classification
        // (auth/host-key/not-found); a bare exit code stays `spawn_failed`.
        if (result.stderr !== undefined)
          throw new WorktreeError(classifyTransport(result.stderr), message)
        throw new DevAuthorityError('spawn_failed', message)
      }
      if (!input.authorizeRoot) {
        throw new DevAuthorityError(
          'unavailable',
          'no bookmark authority is available to bind the cloned root'
        )
      }
      // The bookmark label is the repository name: the register stores no
      // project names (the cloud project record owns it).
      const minted = input.authorizeRoot(targetDir, remote.repository)
      // Re-check after the await: a concurrent bind of the same cloud
      // project id must not produce a second binding.
      requireUnboundProjectId(projectId)
      return importAuthorizedRoot(projectId, minted.id, undefined, targetDir)
    },
    'dev.project.create': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.create'].request(command.body)
      const projectId = body.projectId as string
      requireUnboundProjectId(projectId)
      const created: ProjectBinding = {
        projectId,
        repoIds: [...(body.repoIds as string[])],
        lifecycle: 'ready',
        version: 1,
        ...(body.preferredRuntimeNodeId !== undefined
          ? { preferredRuntimeNodeId: body.preferredRuntimeNodeId as string }
          : {}),
        ...(body.defaultBaseRef !== undefined
          ? { defaultBaseRef: body.defaultBaseRef as string }
          : {}),
        ...(body.bootstrapWorkflowId !== undefined
          ? { bootstrapWorkflowId: body.bootstrapWorkflowId as string }
          : {}),
        ...(body.defaultHarnessId !== undefined
          ? { defaultHarnessId: body.defaultHarnessId as string }
          : {}),
      }
      record = { ...record, projects: [...record.projects, created] }
      save()
      const projected = toProject(created)
      notifyBound(projected)
      return projected
    },
    'dev.project.update': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.update'].request(command.body)
      const projectId = body.projectId as string
      const patch = body.patch as {
        preferredRuntimeNodeId?: string
        defaultBaseRef?: string
        bootstrapWorkflowId?: string
        defaultHarnessId?: string
      }
      requireProjectResource(command, projectId)
      const project = findBinding(projectId)
      requireExpectedVersion(project, body.expectedVersion as number)
      if (project.lifecycle === 'archived')
        throw new DevAuthorityError(
          'invalid_state',
          `project ${project.projectId} is archived; unarchive it before editing`
        )
      const next: ProjectBinding = {
        ...project,
        ...(patch.preferredRuntimeNodeId !== undefined
          ? { preferredRuntimeNodeId: patch.preferredRuntimeNodeId }
          : {}),
        ...(patch.defaultBaseRef !== undefined ? { defaultBaseRef: patch.defaultBaseRef } : {}),
        ...(patch.bootstrapWorkflowId !== undefined
          ? { bootstrapWorkflowId: patch.bootstrapWorkflowId }
          : {}),
        ...(patch.defaultHarnessId !== undefined
          ? { defaultHarnessId: patch.defaultHarnessId }
          : {}),
        version: project.version + 1,
      }
      replaceBinding(next)
      save()
      const projected = toProject(next)
      publishProject(projected, 'project.updated')
      return projected
    },
    'dev.project.archive': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.archive'].request(command.body)
      const projectId = body.projectId as string
      const archived = body.archived as boolean
      requireProjectResource(command, projectId)
      const project = findBinding(projectId)
      requireExpectedVersion(project, body.expectedVersion as number)
      if (archived === (project.lifecycle === 'archived'))
        throw new DevAuthorityError(
          'invalid_state',
          `project ${project.projectId} is ${archived ? 'already archived' : 'not archived'}`
        )
      if (archived) {
        // Archive is navigation metadata only — it never stops or deletes —
        // so it refuses while any session on the project is still live.
        const live = liveSessionCount(project.projectId)
        if (live > 0)
          throw new DevAuthorityError(
            'invalid_state',
            `project ${project.projectId} still has ${live} live session(s); archive them first`
          )
      }
      const next: ProjectBinding = {
        ...project,
        lifecycle: archived ? 'archived' : 'ready',
        version: project.version + 1,
      }
      replaceBinding(next)
      save()
      const projected = toProject(next)
      publishProject(projected, archived ? 'project.archived' : 'project.unarchived')
      return projected
    },
    'dev.project.unbind': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.unbind'].request(command.body)
      const projectId = body.projectId as string
      requireProjectResource(command, projectId)
      const project = findBinding(projectId)
      requireExpectedVersion(project, body.expectedVersion as number)
      // Unbinding removes only the local binding record — it never stops a
      // process or touches repository files — so, like archive, it refuses
      // while any session on the project is still live.
      const refuseLive = () => {
        const live = liveSessionCount(project.projectId)
        if (live > 0)
          throw new DevAuthorityError(
            'invalid_state',
            `project ${project.projectId} still has ${live} live session(s); archive them first`
          )
      }
      refuseLive()
      const removeBinding = (effect?: { commit(): void; rollback(): void }): Project => {
        const previous = record
        record = {
          ...record,
          projects: record.projects.filter((entry) => entry.projectId !== projectId),
        }
        try {
          save()
        } catch (error) {
          record = previous
          effect?.rollback()
          throw error
        }
        effect?.commit()
        const projected = toProject(project)
        publishProject(projected, 'project.unbound')
        return projected
      }
      // A remote-only project owns a managed bare clone: its deletion is
      // proven and quarantined before the binding goes (and refuses while any
      // of its worktrees is still live). Ordinary bindings never touch files.
      if (project.repos?.some((repo) => repo.layout === 'bare_managed') !== true)
        return removeBinding()
      const managedUnbind = input.managedUnbind
      if (!managedUnbind)
        throw new DevAuthorityError(
          'invalid_state',
          'no managed clone authority is available to unbind a remote-only project'
        )
      return managedUnbind(toProject(project)).then((effect) => {
        // The hook awaited: the binding must still be exactly the one proven,
        // and no session may have gone live meanwhile.
        const current = record.projects.find((entry) => entry.projectId === projectId)
        try {
          if (current !== project)
            throw new DevAuthorityError(
              'stale_version',
              `project ${projectId} moved on during unbind`,
              current?.version
            )
          refuseLive()
        } catch (error) {
          effect?.rollback()
          throw error
        }
        return removeBinding(effect)
      })
    },
    'dev.session.create': (command) => {
      requireScope(command, input.scope)
      const body = command.body as {
        projectId: string
        repoId: string
        worktreeId: string
        taskId?: string
        agentProfileId?: string
        agentProfileVersion?: number
        harnessInstallationId?: string
      }
      const key = command.idempotencyKey
      if (key !== undefined && !/^[\x20-\x7e]{1,128}$/.test(key))
        throw devError('invalid_state', 'session create idempotency key is invalid')
      const keyHash = key === undefined ? undefined : sha256Text(key)
      const bodyHash = sha256Text(
        JSON.stringify({
          projectId: body.projectId,
          repoId: body.repoId,
          worktreeId: body.worktreeId,
          taskId: body.taskId,
          agentProfileId: body.agentProfileId,
          agentProfileVersion: body.agentProfileVersion,
          harnessInstallationId: body.harnessInstallationId,
        })
      )
      const retained = (record.sessionCreates ?? []).filter(
        (entry) => Date.now() - Date.parse(entry.createdAt) <= SESSION_CREATE_RETENTION_MS
      )
      const prior = retained.find((entry) => entry.keyHash === keyHash)
      if (prior) {
        if (prior.bodyHash !== bodyHash)
          throw devError('idempotency_conflict', 'session create key was used for another request')
        return findSession(prior.sessionId)
      }
      const project = findBinding(body.projectId)
      if (!project.repoIds.includes(body.repoId))
        throw new DevAuthorityError(
          'identity_mismatch',
          `repository ${body.repoId} is not bound to project ${project.projectId}`
        )
      if (command.resource !== undefined) {
        throw devError('identity_mismatch', 'dev.session.create carries no resource binding')
      }
      // The composition proves the referenced worktree is registered and
      // live on this node before any session record exists.
      input.validateSessionCreation?.({
        projectId: body.projectId,
        repoId: body.repoId,
        worktreeId: body.worktreeId,
      })
      const created: RuntimeSession = {
        id: randomUUID(),
        scope: input.scope,
        projectId: project.projectId,
        repoId: body.repoId,
        worktreeId: body.worktreeId,
        lifecycle: 'preparing',
        archived: false,
        projection: 'structured',
        generation: 1,
        version: 1,
        ...(body.taskId ? { taskId: body.taskId } : {}),
        ...(body.agentProfileId ? { agentProfileId: body.agentProfileId } : {}),
        ...(body.agentProfileVersion !== undefined
          ? { agentProfileVersion: body.agentProfileVersion }
          : {}),
        ...(body.harnessInstallationId
          ? { harnessInstallationId: body.harnessInstallationId }
          : {}),
      }
      record = {
        ...record,
        sessions: [...record.sessions, created],
        sessionCreates:
          keyHash === undefined
            ? retained
            : [
                ...retained,
                { keyHash, bodyHash, sessionId: created.id, createdAt: new Date().toISOString() },
              ],
      }
      save()
      publishSession(created, 'session.created')
      return created
    },
    'dev.session.list': (command) => {
      requireScope(command, input.scope)
      return page(
        record.sessions.filter((entry) => {
          const body = command.body as {
            runtimeSessionId?: string
            projectId?: string
            archived?: boolean
          }
          return (
            (body.runtimeSessionId === undefined || entry.id === body.runtimeSessionId) &&
            (body.projectId === undefined || entry.projectId === body.projectId) &&
            (body.archived === undefined || entry.archived === body.archived)
          )
        })
      )
    },
    'dev.session.get': (command) => {
      requireScope(command, input.scope)
      return findSession((command.body as { runtimeSessionId: string }).runtimeSessionId)
    },
    'dev.session.archive': (command) => {
      requireScope(command, input.scope)
      const body = command.body as {
        runtimeSessionId: string
        expectedGeneration: number
        reason?: string
      }
      const session = findSession(body.runtimeSessionId)
      if (session.generation !== body.expectedGeneration)
        throw new DevAuthorityError(
          'stale_generation',
          `runtime session ${session.id} is owned by generation ${session.generation}`,
          session.version
        )
      if (session.archived)
        throw new DevAuthorityError(
          'invalid_state',
          `runtime session ${session.id} is already archived`
        )
      const next = { ...session, archived: true, version: session.version + 1 }
      const archived = archiveRecord(next, input.scope, 'archived', body.reason)
      // One atomic write commits the session flip and its durable record.
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
        archiveRecords: [...record.archiveRecords, archived],
      }
      save()
      publishSession(next, 'session.archived')
      return archived
    },
    'dev.session.unarchive': (command) => {
      requireScope(command, input.scope)
      const body = command.body as { runtimeSessionId: string; expectedGeneration: number }
      const session = findSession(body.runtimeSessionId)
      if (session.generation !== body.expectedGeneration)
        throw new DevAuthorityError(
          'stale_generation',
          `runtime session ${session.id} is owned by generation ${session.generation}`,
          session.version
        )
      if (!session.archived)
        throw new DevAuthorityError(
          'invalid_state',
          `runtime session ${session.id} is not archived`
        )
      const next = { ...session, archived: false, version: session.version + 1 }
      const restored = archiveRecord(next, input.scope, 'restored')
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
        archiveRecords: [...record.archiveRecords, restored],
      }
      save()
      publishSession(next, 'session.unarchived')
      return restored
    },
    'dev.session.transferInput': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.session.transferInput'].request(command.body)
      const session = record.sessions.find(
        (entry) => entry.id === (body.runtimeSessionId as string)
      )
      if (!session) throw devError('not_found', 'runtime session not found')
      requireSessionResource(command, session)
      if (session.generation !== (body.expectedGeneration as number)) {
        throw devError('stale_generation', 'runtime session generation conflict')
      }
      if (session.version !== (body.expectedOwnerVersion as number)) {
        throw devError('stale_version', 'input owner version conflict')
      }
      if (session.archived) {
        throw devError('invalid_state', 'an archived session grants no input ownership')
      }
      // Ownership transfer is the one input-authority operation: it bumps
      // the generation, so input granted under the old generation is inert.
      const next: RuntimeSession = {
        ...session,
        generation: session.generation + 1,
        version: session.version + 1,
        lifecycle: session.lifecycle === 'ready' ? 'active' : session.lifecycle,
      }
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
      }
      save()
      publishSession(next, 'session.input_transferred')
      return next
    },
  }
  for (const [operation, provider] of Object.entries(providers)) {
    input.authority.registerCommandProvider(operation as DevOperation, provider)
  }
  return {
    providers,
    upsertProject(project) {
      if (!UUID_PATTERN.test(project.id))
        throw new DevAuthorityError('identity_mismatch', 'project id must be a lowercase UUID')
      // Scope, generation, and version checks run against the wire projection.
      upsert(record.projects.map(toProject), project)
      const binding: ProjectBinding = {
        projectId: project.id,
        repoIds: [...project.repoIds],
        ...(project.repos ? { repos: [...project.repos] } : {}),
        ...(project.preferredRuntimeNodeId !== undefined
          ? { preferredRuntimeNodeId: project.preferredRuntimeNodeId }
          : {}),
        ...(project.defaultBaseRef !== undefined ? { defaultBaseRef: project.defaultBaseRef } : {}),
        ...(project.bootstrapWorkflowId !== undefined
          ? { bootstrapWorkflowId: project.bootstrapWorkflowId }
          : {}),
        ...(project.defaultHarnessId !== undefined
          ? { defaultHarnessId: project.defaultHarnessId }
          : {}),
        lifecycle: project.lifecycle,
        version: project.version,
      }
      const exists = record.projects.some((entry) => entry.projectId === project.id)
      record = {
        ...record,
        projects: exists
          ? record.projects.map((entry) => (entry.projectId === project.id ? binding : entry))
          : [...record.projects, binding],
      }
      save()
    },
    upsertSession(session) {
      record = { ...record, sessions: upsert(record.sessions, session) }
      save()
    },
    getSession(runtimeSessionId) {
      return record.sessions.find((entry) => entry.id === runtimeSessionId)
    },
    findRepoBindings(repoId) {
      // Managed bare clones carry no bookmark and are never adopted through
      // a binding: `dev.project.clone` writes their registry record itself.
      return record.projects.flatMap((project) =>
        (project.repos ?? []).flatMap((repo) =>
          repo.repoId === repoId && repo.layout === undefined
            ? [
                {
                  repoId: repo.repoId,
                  rootBookmarkId: repo.rootBookmarkId,
                  canonicalRoot: repo.canonicalRoot,
                  projectId: project.projectId,
                },
              ]
            : []
        )
      )
    },
    assertUnboundProjectId: (projectId) => requireUnboundProjectId(projectId),
    bindManagedClone(bind) {
      requireUnboundProjectId(bind.projectId)
      const created: ProjectBinding = {
        projectId: bind.projectId,
        repoIds: [bind.repoId],
        repos: [{ repoId: bind.repoId, canonicalRoot: bind.canonicalRoot, layout: 'bare_managed' }],
        lifecycle: 'ready',
        version: 1,
        ...(bind.defaultBaseRef !== undefined ? { defaultBaseRef: bind.defaultBaseRef } : {}),
      }
      const previous = record
      record = { ...record, projects: [...record.projects, created] }
      try {
        save()
      } catch (error) {
        record = previous
        throw error
      }
      const projected = toProject(created)
      publishProject(projected, 'project.cloned')
      return projected
    },
    archiveRecords: () => [...record.archiveRecords],
  }
}
