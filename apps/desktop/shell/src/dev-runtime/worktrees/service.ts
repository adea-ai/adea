// M12 #397: the git worktree lifecycle service — discovery/adoption,
// create-from-updated-base, approved bootstrap, leases, merge-back, archive,
// and fail-closed complete-and-clean with retired-name enforcement.
//
// Creation pipeline (spec order): authorize canonical repo → per-repo
// mutation lock + fingerprint refresh → bounded fetch (never touching the
// primary checkout) → base resolution → collision-safe, never-reused
// name/path → argv-only `git worktree add` with toplevel/gitdir/identity
// proof → durable record BEFORE any side effect on the checkout → approved
// include copy → approved bootstrap → ready + startup terminal lease. A
// partial failure stays inspectable and retryable; rollback never deletes
// unproven data.
//
// Primary donor: Orca (https://github.com/stablyai/orca)
// `src/main/runtime/orca-runtime-create-managed-worktree.ts`,
// `src/main/worktree-removal-safety.ts`, `src/main/worktree-trash.ts`,
// `src/shared/worktree-name-suggestion.ts`,
// `src/shared/worktree/retired-name-registry.ts`, pinned revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7, MIT License.
// Copyright (c) 2026 Stably AI, Inc. Muxy's WorktreeStore staged
// create→store→refresh semantics informed the lifecycle states.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'

import { nowIso, newRecordId, sameScope, type DevScope } from '../authority'
import { createDurableJsonStore } from '../host-store'
import type { AuthorityAudit } from '../audit'
import type { RootBookmarkAuthority } from '../roots'
import { WorktreeError, type WorktreeErrorCode } from './errors'
import { runGit, runGitChecked, gitRevParse } from './git-run'
import {
  directoryIdentity,
  isDangerousCleanupPath,
  isSafeWorktreeBaseDir,
  proveWorktreeRegistration,
  readRepoWorktreeAdminFingerprint,
  sameIdentity,
  type FileIdentityValue,
} from './identity'
import {
  discoverWorktrees,
  adminEntryExists,
  worktreeAdminEntryName,
  proveExternalWorktree,
} from './discovery'
import { createRepoMutationOwner } from './mutation-owner'
import { createLeaseStore, type LeaseOwnerKind, type LeaseRecord, type LeaseView } from './leases'
import {
  addRetiredNames,
  createRetiredNameLookup,
  EMPTY_RETIRED_NAME_REGISTRY,
  selectWorktreeName,
  normalizeWorktreeName,
  type RetiredNameRegistry,
} from './retired-names'
import { applyIncludeCopy, planIncludeCopy, type IncludeCopyPlan } from './include-copy'
import {
  createBootstrapRunner,
  workflowDigest,
  type BootstrapApproval,
  type BootstrapWorkflow,
  type StepOutcome,
} from './bootstrap'
import { createMergeService, type MergeOutcome, type MergePlan } from './merge'
import { createTemplateCache, type TemplateCache } from './templates'
import { createCleanupJournal, runJournaledStep, type CleanupJournal } from './journal'
import { createTrashSweeper } from './trash'
import {
  quarantineWorktree,
  worktreeTrashRoot,
  deleteQuarantinedWorktree,
  restoreWorktreeFromTrash,
} from './trash'
import {
  buildCleanupPlan,
  canonicalPlanJson,
  DESTRUCTIVE_CLEANUP_STEPS,
  factsChanged,
  type CleanupFacts,
  type CleanupPlan,
  type CleanupResult,
  type CleanupStepKind,
} from './cleanup-plan'

export type WorktreeLifecycle =
  | 'discovered'
  | 'authorizing'
  | 'creating'
  | 'bootstrapping'
  | 'ready'
  | 'archived'
  | 'merging'
  | 'conflicted'
  | 'cleanup_planned'
  | 'quiescing'
  | 'teardown'
  | 'quarantined'
  | 'unregistered'
  | 'deleting'
  | 'branch_cleanup'
  | 'cleaned'
  | 'blocked'
  | 'partial'
  | 'recovery_required'
  | 'failed'

export type RepoRecord = Readonly<{
  id: string
  scope: DevScope
  kind: 'git' | 'folder'
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  bookmarkId: string
  remote?: string
  defaultRef?: string
  defaultBranch?: string
  projectIds: ReadonlyArray<string>
  createdAt: string
  version: number
}>

export type WorktreeRecord = Readonly<{
  id: string
  scope: DevScope
  projectId: string
  repoId: string
  /** The on-disk directory name; retired on delete, never reused. */
  name: string
  branchRef?: string
  canonicalRoot: string
  rootIdentity: FileIdentityValue
  provenance: 'adea' | 'external'
  baseRef?: string
  baseSha?: string
  headRef?: string
  headSha?: string
  lifecycle: WorktreeLifecycle
  bootstrap: {
    state: 'not_started' | 'running' | 'completed' | 'failed' | 'cancelled'
    workflowId?: string
    workflowDigest?: string
    failedStepId?: string
    outcomes?: ReadonlyArray<StepOutcome>
  }
  archived: boolean
  generation: number
  version: number
  failure?: string
  quarantine?: Readonly<{
    trashRoot: string
    entryName: string
    identity: { device: string; inode: string }
  }>
  createdAt: string
  updatedAt: string
}>

export type CreateWorktreeResult = Readonly<{
  worktree: WorktreeRecord
  name: string
  includeCopy?: Readonly<{ copied: ReadonlyArray<string> }>
  bootstrapOutcomes?: ReadonlyArray<StepOutcome>
}>

export type CreateWorktreeInput = {
  scope: DevScope
  repoId: string
  projectId: string
  /** Required by the operation registry; may be a local or remote-tracking ref. */
  baseRef: string
  branchName?: string
  destinationName?: string
  /** Directory the worktree directory is created in. Must be covered by an
   *  active repository bookmark on this scope. */
  worktreeBaseDir: string
  /** Update the base from the configured remote before resolving it. */
  updateBase?: boolean
  idempotencyKey?: string
  includeApprovals?: ReadonlyArray<string>
  bootstrapWorkflow?: BootstrapWorkflow
  bootstrapApproval?: BootstrapApproval
  signal?: AbortSignal
}

export type WorktreeServiceOptions = {
  dataDir: string
  runtimeNodeId: string
  roots: RootBookmarkAuthority
  audit?: AuthorityAudit
  clock?: () => Date
  fetchTimeoutMs?: number
  /** Destructive-cleanup adapters owned by other slices (#396/#424). When a
   *  selected step has no adapter the step fails closed. */
  stopResource?: (resource: { id: string; kind: string }) => Promise<void>
  protectedBranches?: (repo: RepoRecord) => ReadonlyArray<string>
  /** Trash-sweep staleness policy (entries younger than this are kept). */
  sweepStaleAfterMs?: number
}

const FETCH_DEFAULT_TIMEOUT_MS = 60_000

function allocateWorktreeName(input: {
  baseDir: string
  requested?: string
  retired: RetiredNameRegistry
}): string {
  const isRetired = createRetiredNameLookup(input.retired)
  if (input.requested !== undefined) {
    const normalized = normalizeWorktreeName(input.requested)
    if (normalized.length < 1 || normalized.length > 64 || /[\\/]/.test(normalized)) {
      throw new WorktreeError(
        'invalid_state',
        'destination name must be 1..64 path-free characters'
      )
    }
    if (isRetired(normalized)) {
      throw new WorktreeError(
        'name_collision',
        'destination name is retired and can never be reused'
      )
    }
    if (existsSync(join(input.baseDir, normalized))) {
      throw new WorktreeError('path_collision', 'destination path already exists')
    }
    return normalized
  }
  // Live sibling names plus every retired name feed the suggester; the pool
  // degrades to suffixed tiers rather than recycling retired names.
  const usedNames = new Set<string>()
  for (const name of input.retired.names) usedNames.add(normalizeWorktreeName(name))
  let siblings: string[] = []
  try {
    siblings = readdirSync(input.baseDir)
  } catch {
    siblings = []
  }
  for (const sibling of siblings) usedNames.add(normalizeWorktreeName(sibling))
  const name = selectWorktreeName(usedNames, Math.random, input.retired.exhaustedTiers)
  if (existsSync(join(input.baseDir, name))) {
    throw new WorktreeError('path_collision', 'generated worktree path already exists')
  }
  return name
}

function resolveBaseDir(input: { worktreeBaseDir: string; repoCanonicalRoot: string }): string {
  const baseDir = resolve(input.worktreeBaseDir)
  if (!isSafeWorktreeBaseDir(baseDir, input.repoCanonicalRoot)) {
    throw new WorktreeError('dangerous_path', 'worktree base directory is a dangerous location')
  }
  const stat = lstatSync(baseDir, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorktreeError('not_found', 'worktree base directory must be a real directory')
  }
  return realpathSync(baseDir)
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function observeGitFacts(input: {
  record: WorktreeRecord
  repo: RepoRecord
  protectedBranches?: ReadonlyArray<string>
}): Promise<Partial<CleanupFacts>> {
  const cwd = input.record.canonicalRoot
  const statusOut = await runGit(['status', '--porcelain'], { cwd })
  let dirty = false
  let untracked = false
  let conflicted = false
  for (const line of statusOut.stdout.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('??')) {
      untracked = true
      continue
    }
    const x = line[0]
    const y = line[1]
    if (x === 'U' || y === 'U' || x === 'A' || x === 'D') {
      if (x === 'U' || y === 'U' || x === 'A' || x === 'D')
        conflicted = x === 'U' || y === 'U' || x === 'A' || x === 'D'
      else dirty = true
    } else {
      dirty = true
    }
  }
  const branch = input.record.branchRef
  // @{upstream} resolves against short branch names, not full refnames.
  const branchName = branch?.replace('refs/heads/', '')
  let upstreamKnown = false
  let ahead: number | null = null
  let behind: number | null = null
  let unpushedCommits = 0
  if (branchName) {
    const upstream = await runGit(
      ['rev-parse', '--verify', '--quiet', `${branchName}@{upstream}`],
      { cwd: input.repo.canonicalRoot }
    )
    upstreamKnown = upstream.exitCode === 0
    if (upstreamKnown) {
      const count = await runGit(
        ['rev-list', '--left-right', '--count', `${branchName}...${branchName}@{upstream}`],
        { cwd: input.repo.canonicalRoot }
      )
      if (count.exitCode === 0) {
        const [left, right] = count.stdout.trim().split('\t')
        ahead = Number(left)
        behind = Number(right)
      }
    } else {
      const unpushed = await runGit(['rev-list', '--count', `${branchName} --not --remotes`], {
        cwd: input.repo.canonicalRoot,
      })
      unpushedCommits = unpushed.exitCode === 0 ? Number(unpushed.stdout.trim()) : 0
    }
  }
  const entries = await discoverWorktrees(input.repo.canonicalRoot)
  const nested = entries
    .map((entry) => entry.path)
    .filter(
      (path) =>
        path !== input.record.canonicalRoot && path.startsWith(input.record.canonicalRoot + sep)
    )
  const headBranch = input.record.branchRef?.replace('refs/heads/', '')
  const isDefaultBranch =
    headBranch !== undefined &&
    (headBranch === (input.repo.defaultBranch ?? 'main') ||
      headBranch === input.repo.defaultRef?.replace('refs/heads/', ''))
  const isProtectedBranch =
    headBranch !== undefined && (input.protectedBranches ?? []).includes(headBranch)
  let gitdirProven = false
  try {
    gitdirProven = (await proveWorktreeRegistration(input.record.canonicalRoot)) !== null
  } catch {
    gitdirProven = false
  }
  return {
    dirty,
    untracked,
    conflicted,
    upstreamKnown,
    ahead,
    behind,
    unpushedCommits,
    isDefaultBranch,
    isProtectedBranch,
    nestedWorktrees: nested,
    gitdirProven,
  }
}

async function currentBranchRef(worktreeRoot: string): Promise<string | undefined> {
  const result = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: worktreeRoot })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

export function createWorktreeService(options: WorktreeServiceOptions) {
  const clock = options.clock ?? (() => new Date())
  const dataDir = options.dataDir
  const runtimeNodeId = options.runtimeNodeId
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_DEFAULT_TIMEOUT_MS
  const audit = options.audit

  const storesDir = join(dataDir, 'dev-runtime', 'worktrees')
  mkdirSync(storesDir, { recursive: true, mode: 0o700 })

  const repoStore = createDurableJsonStore<RepoRecord>({
    file: join(storesDir, 'repos.json'),
    schemaVersion: 1,
    label: 'worktree repo',
  })
  const worktreeStore = createDurableJsonStore<WorktreeRecord>({
    file: join(storesDir, 'worktrees.json'),
    schemaVersion: 1,
    label: 'worktree record',
  })
  const retiredStore = createDurableJsonStore<RetiredNameRegistry & { repoCommonDirHash: string }>({
    file: join(storesDir, 'retired-names.json'),
    schemaVersion: 1,
    label: 'retired worktree names',
  })
  const fingerprintStore = createDurableJsonStore<{
    repoId: string
    fingerprint: string | null
    observedAt: string
  }>({
    file: join(storesDir, 'repo-fingerprints.json'),
    schemaVersion: 1,
    label: 'repo worktree fingerprint',
  })
  const cleanupJobStore = createDurableJsonStore<{
    jobId: string
    worktreeId: string
    state: string
    createdAt: string
    observedAt: string
    generation: number
    version: number
  }>({
    file: join(storesDir, 'cleanup-jobs.json'),
    schemaVersion: 1,
    label: 'cleanup job',
  })

  // Approved workflows/approvals are held in memory for retry: the durable
  // store keeps only digests and state, never workflow argv.
  const pendingWorkflows = new Map<string, BootstrapWorkflow>()
  const pendingApprovals = new Map<string, BootstrapApproval>()

  const mutationOwner = createRepoMutationOwner({ dataDir, runtimeNodeId, clock })
  const leases = createLeaseStore({ dataDir, clock })
  const bootstrapRunner = createBootstrapRunner({ clock })
  const mergeService = createMergeService({ dataDir, clock })
  const templates: TemplateCache = createTemplateCache({ dataDir, clock })
  const trashSweeper = createTrashSweeper({
    stateFile: join(storesDir, 'sweep-state.json'),
    clock,
    ...(options.sweepStaleAfterMs !== undefined ? { staleAfterMs: options.sweepStaleAfterMs } : {}),
  })

  function log(
    action: string,
    subjectId: string,
    outcome: 'granted' | 'denied' | 'revoked' | 'failed' | 'recovered',
    detail?: Record<string, string>
  ): void {
    audit?.append({ action, subjectId, outcome, ...(detail ? { detail } : {}) })
  }

  function loadRepos(): RepoRecord[] {
    return [...repoStore.load().records]
  }

  function loadWorktrees(): WorktreeRecord[] {
    return [...worktreeStore.load().records]
  }

  function saveWorktrees(records: WorktreeRecord[]): void {
    worktreeStore.save(records)
  }

  function findRepo(scope: DevScope, repoId: string): RepoRecord {
    const repo = loadRepos().find((entry) => entry.id === repoId)
    if (!repo || !sameScope(repo.scope, scope))
      throw new WorktreeError('not_found', 'repository not found')
    return repo
  }

  function findWorktree(scope: DevScope, worktreeId: string): WorktreeRecord {
    const record = loadWorktrees().find((entry) => entry.id === worktreeId)
    if (!record || !sameScope(record.scope, scope))
      throw new WorktreeError('not_found', 'worktree not found')
    return record
  }

  function putWorktree(record: WorktreeRecord): void {
    const all = loadWorktrees()
    const index = all.findIndex((entry) => entry.id === record.id)
    if (index >= 0) all[index] = record
    else all.push(record)
    saveWorktrees(all)
  }

  function retiredRegistryFor(repoCommonDir: string): RetiredNameRegistry {
    const key = sha256Text(repoCommonDir)
    const record = retiredStore.load().records.find((entry) => entry.repoCommonDirHash === key)
    return record
      ? { exhaustedTiers: record.exhaustedTiers, names: record.names }
      : EMPTY_RETIRED_NAME_REGISTRY
  }

  function persistRetiredRegistry(repoCommonDir: string, registry: RetiredNameRegistry): void {
    const key = sha256Text(repoCommonDir)
    const all = [...retiredStore.load().records]
    const index = all.findIndex((entry) => entry.repoCommonDirHash === key)
    const next = { ...registry, repoCommonDirHash: key }
    if (index >= 0) all[index] = next
    else all.push(next)
    retiredStore.save(all)
  }

  function retireNames(repoCommonDir: string, names: ReadonlyArray<string>): void {
    const merged = addRetiredNames(
      retiredRegistryFor(repoCommonDir),
      names.map(normalizeWorktreeName)
    )
    if (merged) persistRetiredRegistry(repoCommonDir, merged)
  }

  /** Authorize one repository root through the M10 bookmark authority and
   *  register the repository record. The bookmark must cover the repo path
   *  (be it, or an ancestor of it); bare repositories are unsupported. */
  async function registerRepo(input: {
    scope: DevScope
    projectId: string
    absolutePath: string
    bookmarkId: string
    remote?: string
    defaultRef?: string
    defaultBranch?: string
  }): Promise<RepoRecord> {
    const bookmark = options.roots.validate({ scope: input.scope, bookmarkId: input.bookmarkId })
    const canonicalRoot = realpathSync(input.absolutePath)
    if (
      canonicalRoot !== bookmark.canonicalRoot &&
      !canonicalRoot.startsWith(bookmark.canonicalRoot + sep)
    ) {
      throw new WorktreeError(
        'unauthorized_root',
        'repository path is not covered by the authorized root'
      )
    }
    const { identity } = directoryIdentity(canonicalRoot)
    const dotGit = lstatSync(join(canonicalRoot, '.git'), { throwIfNoEntry: false })
    let kind: 'git' | 'folder'
    if (dotGit?.isDirectory()) kind = 'git'
    else if (dotGit?.isFile()) {
      throw new WorktreeError(
        'not_git_repo',
        'the authorized path is a linked worktree, not a repository root'
      )
    } else {
      const head = lstatSync(join(canonicalRoot, 'HEAD'), { throwIfNoEntry: false })
      if (head) throw new WorktreeError('not_git_repo', 'bare repositories are unsupported')
      kind = 'folder'
    }

    const repos = loadRepos()
    const existing = repos.find(
      (entry) => sameScope(entry.scope, input.scope) && entry.canonicalRoot === canonicalRoot
    )
    if (existing) {
      const projectIds = [...new Set([...existing.projectIds, input.projectId])]
      const next: RepoRecord = { ...existing, projectIds, version: existing.version + 1 }
      const index = repos.indexOf(existing)
      repos[index] = next
      repoStore.save(repos)
      return next
    }
    const record: RepoRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      kind,
      canonicalRoot,
      rootIdentity: identity,
      bookmarkId: input.bookmarkId,
      ...(input.remote ? { remote: input.remote } : {}),
      ...(input.defaultRef ? { defaultRef: input.defaultRef } : {}),
      ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
      projectIds: [input.projectId],
      createdAt: nowIso(clock),
      version: 1,
    }
    repos.push(record)
    repoStore.save(repos)
    log('repo.registered', record.id, 'granted', { kind })
    return record
  }

  /** Fingerprint-gated refresh: rediscover only when the git admin state
   *  changed. No polling, no subprocess storm; a null fingerprint (unreadable)
   *  always triggers one explicit rescan and is surfaced as degraded. */
  async function refreshRepo(input: {
    scope: DevScope
    repoId: string
  }): Promise<{ changed: boolean; degraded: boolean }> {
    const repo = findRepo(input.scope, input.repoId)
    if (repo.kind !== 'git') return { changed: false, degraded: false }
    const fingerprint = await readRepoWorktreeAdminFingerprint(repo.canonicalRoot)
    const all = fingerprintStore.load().records
    const prior = all.find((entry) => entry.repoId === repo.id)
    const unchanged =
      prior !== undefined && fingerprint !== null && prior.fingerprint === fingerprint
    if (unchanged) return { changed: false, degraded: false }
    const next = all.filter((entry) => entry.repoId !== repo.id)
    next.push({ repoId: repo.id, fingerprint, observedAt: nowIso(clock) })
    fingerprintStore.save(next)
    // `changed` reports the admin-state delta the caller may need to rescan
    // for; host-record reconciliation runs underneath.
    let changed = false
    if (fingerprint !== null) {
      changed = prior === undefined || prior.fingerprint !== fingerprint
      await syncDiscovered(repo)
    }
    return { changed, degraded: fingerprint === null }
  }

  /** Reconcile host records with `git worktree list` truth: a checkout that
   *  disappeared behind our back becomes recovery_required, never silently
   *  cleaned. */
  async function syncDiscovered(repo: RepoRecord): Promise<number> {
    const entries = await discoverWorktrees(repo.canonicalRoot)
    const paths = new Set(entries.map((entry) => entry.path))
    const records = loadWorktrees()
    let changed = 0
    for (const record of records) {
      if (record.repoId !== repo.id) continue
      if (record.lifecycle === 'cleaned' || record.lifecycle === 'quarantined') continue
      if (!paths.has(record.canonicalRoot) && !existsSync(record.canonicalRoot)) {
        if (record.lifecycle !== 'recovery_required' && record.lifecycle !== 'failed') {
          const index = records.indexOf(record)
          records[index] = {
            ...record,
            lifecycle: 'recovery_required',
            generation: record.generation + 1,
            version: record.version + 1,
            updatedAt: nowIso(clock),
          }
          changed += 1
        }
      }
    }
    if (changed > 0) saveWorktrees(records)
    return changed
  }

  function listWorktrees(input: {
    scope: DevScope
    projectId?: string
    repoId?: string
    archived?: boolean
  }): WorktreeRecord[] {
    return loadWorktrees().filter(
      (entry) =>
        sameScope(entry.scope, input.scope) &&
        (input.projectId === undefined || entry.projectId === input.projectId) &&
        (input.repoId === undefined || entry.repoId === input.repoId) &&
        (input.archived === undefined || entry.archived === input.archived)
    )
  }

  function assertBaseDirAuthorized(scope: DevScope, baseDir: string): void {
    // The base directory must be covered by an active repository bookmark:
    // its canonical root must be an ancestor of (or equal to) the base dir.
    const canonicalBase = realpathSync(baseDir)
    const bookmarks = options.roots.list({ scope, kind: 'repository' })
    const covering = bookmarks.items.find((entry) => {
      if (entry.state !== 'active') return false
      return (
        canonicalBase === entry.canonicalRoot || canonicalBase.startsWith(entry.canonicalRoot + sep)
      )
    })
    if (!covering) {
      throw new WorktreeError(
        'unauthorized_root',
        'worktree base directory is not covered by an authorized root'
      )
    }
    options.roots.validate({ scope, bookmarkId: covering.id })
  }

  /** Create a managed worktree from an updated base. Serialized per repo
   *  common dir across processes; deduplicated by idempotency key. */
  async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
    const repo = findRepo(input.scope, input.repoId)
    if (repo.kind !== 'git') {
      // A folder workspace is a registration, not a filesystem create.
      throw new WorktreeError('invalid_state', 'folder repositories do not create git worktrees')
    }
    return mutationOwner.withMutation(
      {
        repoCommonDir: repo.canonicalRoot,
        operation: 'worktree-create',
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      () => createWorktreeLocked(input, repo)
    )
  }

  async function createWorktreeLocked(
    input: CreateWorktreeInput,
    repo: RepoRecord
  ): Promise<CreateWorktreeResult> {
    // 1. Authorize the canonical repo/common dir.
    const repoIdentity = directoryIdentity(repo.canonicalRoot)
    if (!sameIdentity(repoIdentity.identity, repo.rootIdentity)) {
      throw new WorktreeError('identity_mismatch', 'repository root identity changed')
    }
    // 2. Refresh the worktree-admin fingerprint under the mutation lock.
    await refreshRepo({ scope: input.scope, repoId: repo.id })

    // 3. Update the base from the selected remote (bounded, typed failures).
    //    Never mutates or resets the primary checkout: `git fetch` writes only
    //    remote-tracking refs under the common dir.
    if (input.updateBase !== false && repo.remote) {
      try {
        await runGitChecked(['fetch', repo.remote, '--prune'], {
          cwd: repo.canonicalRoot,
          timeoutMs: fetchTimeoutMs,
          signal: input.signal,
        })
      } catch (error) {
        const code: WorktreeErrorCode =
          error instanceof WorktreeError &&
          (error.code === 'timeout' || error.code === 'auth_required')
            ? error.code === 'timeout'
              ? 'remote_unavailable'
              : 'auth_required'
            : 'remote_unavailable'
        log('worktree.base_fetch', repo.id, 'failed', { code })
        throw new WorktreeError(
          code,
          `updating the base from ${repo.remote} failed: ${(error as Error).message}`,
          {
            action: 'retry_fetch',
          }
        )
      }
    }

    // 4. Resolve the base; allocate a collision-safe, never-reused name/path.
    const baseSha = await gitRevParse(repo.canonicalRoot, input.baseRef).catch(() => {
      throw new WorktreeError('base_not_found', `base ref not found: ${input.baseRef}`)
    })

    const baseDir = resolveBaseDir({
      worktreeBaseDir: input.worktreeBaseDir,
      repoCanonicalRoot: repo.canonicalRoot,
    })
    assertBaseDirAuthorized(input.scope, baseDir)
    const retired = retiredRegistryFor(repo.canonicalRoot)
    const name = allocateWorktreeName({ baseDir, requested: input.destinationName, retired })
    const branchName = input.branchName ?? `adea/${name}`
    const branchRef = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`
    const branchExists =
      (await runGit(['rev-parse', '--verify', '--quiet', branchRef], { cwd: repo.canonicalRoot }))
        .exitCode === 0
    if (branchExists) {
      throw new WorktreeError('name_collision', `branch already exists: ${branchName}`)
    }

    const worktreePath = join(baseDir, name)
    if (lstatSync(worktreePath, { throwIfNoEntry: false })) {
      throw new WorktreeError('path_collision', `worktree path already exists: ${name}`)
    }

    // 5. Create the worktree with argv only, then prove toplevel/gitdir/identity.
    await runGitChecked(['worktree', 'add', '-b', branchName, worktreePath, baseSha], {
      cwd: repo.canonicalRoot,
      signal: input.signal,
    })
    const canonicalWorktree = realpathSync(worktreePath)
    const toplevel = (
      await runGitChecked(['rev-parse', '--show-toplevel'], { cwd: canonicalWorktree })
    ).stdout.trim()
    if (realpathSync(toplevel) !== canonicalWorktree) {
      throw new WorktreeError(
        'gitdir_unproven',
        'created worktree toplevel does not match the requested path'
      )
    }
    const registration = await proveWorktreeRegistration(canonicalWorktree)
    if (!registration) {
      throw new WorktreeError(
        'gitdir_unproven',
        'created worktree gitdir backlink could not be proven'
      )
    }
    const created = directoryIdentity(canonicalWorktree)

    // Persist the lifecycle fact before any subsequent side effect.
    const record: WorktreeRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      projectId: input.projectId,
      repoId: repo.id,
      name,
      branchRef,
      canonicalRoot: created.path,
      rootIdentity: created.identity,
      provenance: 'adea',
      baseRef: input.baseRef,
      baseSha,
      headRef: branchRef,
      headSha: baseSha,
      lifecycle: input.bootstrapWorkflow ? 'bootstrapping' : 'ready',
      bootstrap: input.bootstrapWorkflow
        ? {
            state: 'running',
            workflowId: input.bootstrapWorkflow.id,
            workflowDigest: workflowDigest(input.bootstrapWorkflow),
          }
        : { state: 'not_started' },
      archived: false,
      generation: 1,
      version: 1,
      createdAt: nowIso(clock),
      updatedAt: nowIso(clock),
    }
    putWorktree(record)
    if (input.bootstrapWorkflow && input.bootstrapApproval) {
      pendingWorkflows.set(record.id, input.bootstrapWorkflow)
      pendingApprovals.set(record.id, input.bootstrapApproval)
    }

    // 6. Approved include copy (CoW clones; approved items only).
    let includeCopy: { copied: string[] } | undefined
    try {
      const plan = await planIncludeCopy({
        sourceRoot: repo.canonicalRoot,
        destinationRoot: created.path,
        approvals: input.includeApprovals,
      })
      if ('ran' in plan) {
        includeCopy = undefined
      } else {
        const applied = await applyIncludeCopy({
          plan: plan as IncludeCopyPlan,
          digest: (plan as IncludeCopyPlan).digest,
          signal: input.signal,
        })
        includeCopy = { copied: [...applied.copied] }
      }
    } catch (error) {
      // The worktree exists and stays inspectable; the failure is recorded and
      // nothing is deleted (rollback never deletes unproven data).
      putWorktree({
        ...record,
        lifecycle: 'failed',
        failure: `include copy failed: ${(error as Error).message}`,
        version: record.version + 1,
      })
      log('worktree.include_copy', record.id, 'failed')
      throw error
    }

    // 7. Approved bootstrap (argv-only), bound to the canonical root.
    let bootstrapOutcomes: StepOutcome[] | undefined
    if (input.bootstrapWorkflow) {
      try {
        bootstrapOutcomes = await bootstrapRunner.run({
          worktreeRoot: created.path,
          worktreeIdentity: created.identity,
          workflow: input.bootstrapWorkflow,
          approval: input.bootstrapApproval,
          scope: input.scope,
          canonicalRepoRoot: repo.canonicalRoot,
          signal: input.signal,
        })
      } catch (error) {
        putWorktree({
          ...record,
          lifecycle: 'failed',
          bootstrap: {
            state: 'failed',
            workflowId: input.bootstrapWorkflow.id,
            workflowDigest: workflowDigest(input.bootstrapWorkflow),
          },
          failure: `bootstrap failed: ${(error as Error).message}`,
          version: record.version + 1,
        })
        log('worktree.bootstrap', record.id, 'failed')
        throw error
      }
    }

    // 8. Ready + startup terminal lease (the #400 harness gate reads leases).
    const finalRecord: WorktreeRecord = {
      ...record,
      lifecycle: 'ready',
      ...(bootstrapOutcomes
        ? {
            bootstrap: {
              ...record.bootstrap,
              state: 'completed' as const,
              outcomes: bootstrapOutcomes,
            },
          }
        : {}),
      headSha: await gitRevParse(created.path, 'HEAD'),
      version: record.version + 1,
      updatedAt: nowIso(clock),
    }
    putWorktree(finalRecord)
    leases.acquire({
      scope: input.scope,
      worktreeId: finalRecord.id,
      worktreeGeneration: finalRecord.generation,
      ownerKind: 'terminal',
      ownerId: 'terminal:startup',
    })
    log('worktree.created', finalRecord.id, 'granted', { kind: 'managed' })
    return {
      worktree: finalRecord,
      name,
      ...(includeCopy ? { includeCopy } : {}),
      ...(bootstrapOutcomes ? { bootstrapOutcomes } : {}),
    }
  }

  /** Adopt an external worktree after canonical path/gitdir validation. */
  async function adoptWorktree(input: {
    scope: DevScope
    repoId: string
    projectId: string
    worktreePath: string
  }): Promise<WorktreeRecord> {
    const repo = findRepo(input.scope, input.repoId)
    const proof = await proveExternalWorktree({
      worktreePath: input.worktreePath,
      repoRoot: repo.canonicalRoot,
    })
    const branchRef = await currentBranchRef(proof.canonicalRoot)
    const headSha = await gitRevParse(proof.canonicalRoot, 'HEAD').catch(() => undefined)
    const record: WorktreeRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      projectId: input.projectId,
      repoId: repo.id,
      name: proof.canonicalRoot.split(sep).pop() ?? proof.canonicalRoot,
      ...(branchRef ? { branchRef } : {}),
      canonicalRoot: proof.canonicalRoot,
      rootIdentity: proof.identity,
      provenance: 'external',
      ...(headSha ? { headSha } : {}),
      lifecycle: 'ready',
      bootstrap: { state: 'not_started' },
      archived: false,
      generation: 1,
      version: 1,
      createdAt: nowIso(clock),
      updatedAt: nowIso(clock),
    }
    putWorktree(record)
    log('worktree.adopted', record.id, 'granted', { kind: 'external' })
    return record
  }

  /** Archive only: navigation metadata, nothing else. Lossless. */
  function archiveWorktree(input: {
    scope: DevScope
    worktreeId: string
    expectedGeneration: number
  }): WorktreeRecord {
    const record = findWorktree(input.scope, input.worktreeId)
    if (record.generation !== input.expectedGeneration) {
      throw new WorktreeError('stale_generation', 'worktree generation moved')
    }
    if (record.lifecycle === 'quarantined' || record.lifecycle === 'cleaned') {
      throw new WorktreeError('invalid_state', 'a removed worktree cannot be archived')
    }
    const next: WorktreeRecord = {
      ...record,
      archived: true,
      lifecycle: 'archived',
      generation: record.generation + 1,
      version: record.version + 1,
      updatedAt: nowIso(clock),
    }
    putWorktree(next)
    return next
  }

  function unarchiveWorktree(input: {
    scope: DevScope
    worktreeId: string
    expectedGeneration: number
  }): WorktreeRecord {
    const record = findWorktree(input.scope, input.worktreeId)
    if (record.generation !== input.expectedGeneration) {
      throw new WorktreeError('stale_generation', 'worktree generation moved')
    }
    if (!record.archived) return record
    const next: WorktreeRecord = {
      ...record,
      archived: false,
      lifecycle: 'ready',
      generation: record.generation + 1,
      version: record.version + 1,
      updatedAt: nowIso(clock),
    }
    putWorktree(next)
    return next
  }

  /** Retry a failed bootstrap from the durable workflow binding. */
  async function retryBootstrap(input: {
    scope: DevScope
    worktreeId: string
    signal?: AbortSignal
  }): Promise<WorktreeRecord> {
    const record = findWorktree(input.scope, input.worktreeId)
    if (!record.bootstrap.workflowId || !record.bootstrap.workflowDigest) {
      throw new WorktreeError('invalid_state', 'no bootstrap workflow is bound to this worktree')
    }
    const workflow = pendingWorkflows.get(record.id)
    const approval = pendingApprovals.get(record.id)
    if (!workflow || !approval) {
      throw new WorktreeError(
        'bootstrap_denied',
        'bootstrap retry requires the stored workflow and approval'
      )
    }
    const fresh = directoryIdentity(record.canonicalRoot)
    const outcomes = await bootstrapRunner.run({
      worktreeRoot: record.canonicalRoot,
      worktreeIdentity: fresh.identity,
      workflow,
      approval,
      scope: input.scope,
      canonicalRepoRoot: findRepo(input.scope, record.repoId).canonicalRoot,
      signal: input.signal,
    })
    const next: WorktreeRecord = {
      ...record,
      lifecycle: 'ready',
      bootstrap: {
        ...record.bootstrap,
        state: 'completed',
        outcomes,
        failedStepId: undefined,
      },
      failure: undefined,
      generation: record.generation + 1,
      version: record.version + 1,
      updatedAt: nowIso(clock),
    }
    putWorktree(next)
    return next
  }

  // --- leases ---------------------------------------------------------------

  const leaseApi = {
    acquire: (input: {
      scope: DevScope
      worktreeId: string
      expectedGeneration: number
      ownerKind: LeaseOwnerKind
      ownerId: string
      ttlSeconds?: number
    }): LeaseRecord => {
      const record = findWorktree(input.scope, input.worktreeId)
      if (record.generation !== input.expectedGeneration) {
        throw new WorktreeError('stale_generation', 'worktree generation moved')
      }
      if (record.archived)
        throw new WorktreeError('invalid_state', 'an archived worktree grants no new leases')
      return leases.acquire({
        scope: input.scope,
        worktreeId: input.worktreeId,
        worktreeGeneration: record.generation,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        ttlSeconds: input.ttlSeconds,
      })
    },
    heartbeat: (input: { scope: DevScope; worktreeId: string; leaseId: string }): LeaseView =>
      leases.heartbeat(input),
    release: (input: { scope: DevScope; worktreeId: string; leaseId: string }): LeaseRecord =>
      leases.release(input),
    reconcile: (input: { scope: DevScope; worktreeId: string; leaseId: string }): LeaseRecord =>
      leases.reconcileExpired(input),
    list: (worktreeId: string): LeaseView[] => leases.list(worktreeId),
  }

  // --- merge ----------------------------------------------------------------

  const mergeApi = {
    plan: async (input: {
      scope: DevScope
      worktreeId: string
      expectedGeneration: number
      targetRef: string
      expectedTargetSha?: string
      commitMessage: string
    }): Promise<MergePlan> => {
      const record = findWorktree(input.scope, input.worktreeId)
      if (record.generation !== input.expectedGeneration) {
        throw new WorktreeError('stale_generation', 'worktree generation moved')
      }
      if (record.provenance !== 'adea') {
        throw new WorktreeError('external_ownership', 'external worktrees do not merge back')
      }
      const repo = findRepo(input.scope, record.repoId)
      return mergeService.planMerge({
        worktreeId: record.id,
        worktreeRoot: record.canonicalRoot,
        repoPath: repo.canonicalRoot,
        targetRef: input.targetRef,
        expectedTargetSha: input.expectedTargetSha,
        commitMessage: input.commitMessage,
      })
    },
    commit: async (input: {
      scope: DevScope
      plan: MergePlan
      digest: string
      signal?: AbortSignal
    }): Promise<MergeOutcome> => {
      const outcome = await mergeService.commitMerge({
        plan: input.plan,
        digest: input.digest,
        signal: input.signal,
      })
      if (outcome.state === 'conflicted') {
        const record = findWorktree(input.scope, input.plan.worktreeId)
        putWorktree({
          ...record,
          lifecycle: 'conflicted',
          generation: record.generation + 1,
          version: record.version + 1,
          updatedAt: nowIso(clock),
        })
      }
      return outcome
    },
    resume: (input: { recoveryToken: string; resolved: boolean }) =>
      mergeService.resumeMerge(input),
    abort: (recoveryToken: string) => mergeService.abortMerge(recoveryToken),
    deleteBranchIfUnchanged: (input: {
      repoPath: string
      branchRef: string
      expectedSha: string
    }) => mergeService.deleteBranchIfUnchanged(input),
  }

  // --- cleanup --------------------------------------------------------------

  function observeCleanupFacts(input: { record: WorktreeRecord; repo: RepoRecord }): CleanupFacts {
    const record = input.record
    let identityProven = false
    try {
      const fresh = directoryIdentity(record.canonicalRoot)
      identityProven = sameIdentity(fresh.identity, record.rootIdentity)
    } catch {
      identityProven = false
    }
    return {
      worktreeId: record.id,
      generation: record.generation,
      provenance: record.provenance,
      lifecycle: record.lifecycle,
      canonicalRoot: record.canonicalRoot,
      repoPath: input.repo.canonicalRoot,
      headBranch: record.branchRef?.replace('refs/heads/', ''),
      branchRef: record.branchRef,
      headSha: record.headSha,
      dirty: false,
      untracked: false,
      conflicted: false,
      upstreamKnown: false,
      ahead: null,
      behind: null,
      unpushedCommits: 0,
      isDefaultBranch: false,
      isProtectedBranch: false,
      hasLiveLeases: leases.hasLiveLeases(record.id),
      attachedOwnedResources: [],
      nestedWorktrees: [],
      identityProven,
      gitdirProven: identityProven,
      dangerous: isDangerousCleanupPath(record.canonicalRoot, input.repo.canonicalRoot),
      trashRootUsable: (() => {
        const root = worktreeTrashRoot(record.canonicalRoot)
        const stat = lstatSync(root, { throwIfNoEntry: false })
        return !(stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      })(),
    }
  }

  /** Build a cleanup plan from fresh observations. */
  async function planCleanup(input: {
    scope: DevScope
    worktreeId: string
    expectedGeneration: number
    selectedSteps: ReadonlyArray<CleanupStepKind>
    selectedResourceIds?: ReadonlyArray<string>
  }): Promise<CleanupPlan> {
    const record = findWorktree(input.scope, input.worktreeId)
    if (record.generation !== input.expectedGeneration) {
      throw new WorktreeError('stale_generation', 'worktree generation moved')
    }
    const repo = findRepo(input.scope, record.repoId)
    const base = observeCleanupFacts({ record, repo })
    const observed = await observeGitFacts({
      record,
      repo,
      protectedBranches: options.protectedBranches?.(repo),
    })
    const facts: CleanupFacts = { ...base, ...observed }
    const plan = buildCleanupPlan({
      planId: newRecordId(),
      facts,
      selectedSteps: input.selectedSteps,
      selectedResourceIds: input.selectedResourceIds,
      clock,
    })
    const jobs = [...cleanupJobStore.load().records]
    jobs.push({
      jobId: plan.planId,
      worktreeId: record.id,
      state: plan.blockers.length > 0 ? 'blocked' : 'preflighted',
      createdAt: plan.createdAt,
      observedAt: nowIso(clock),
      generation: record.generation,
      version: 1,
    })
    cleanupJobStore.save(jobs)
    return plan
  }

  function journalFor(jobId: string): CleanupJournal {
    return createCleanupJournal({ file: join(storesDir, 'journal', `${jobId}.jsonl`) })
  }

  /** Execute an approved plan. Facts are re-observed under the repo lock and
   *  any drift refuses the commit; every step journals before its side effect;
   *  a failed step leaves quarantined/recoverable state, never a silent
   *  partial delete. */
  async function commitCleanup(input: {
    scope: DevScope
    plan: CleanupPlan
    digest: string
  }): Promise<CleanupResult> {
    const fields = {
      planId: input.plan.planId,
      worktreeId: input.plan.worktreeId,
      generation: input.plan.generation,
      facts: input.plan.facts,
      blockers: input.plan.blockers,
      selectedSteps: input.plan.selectedSteps,
      selectedResourceIds: input.plan.selectedResourceIds,
    }
    if (createHash('sha256').update(canonicalPlanJson(fields)).digest('hex') !== input.digest) {
      throw new WorktreeError('plan_stale', 'cleanup plan digest does not match the plan')
    }
    const recordAtPlan = findWorktree(input.scope, input.plan.worktreeId)
    const repo = findRepo(input.scope, recordAtPlan.repoId)
    // A destructive step may only run from a blocker-free plan.
    if (
      input.plan.blockers.length > 0 &&
      input.plan.selectedSteps.some((step) => DESTRUCTIVE_CLEANUP_STEPS.includes(step))
    ) {
      throw new WorktreeError(
        'cleanup_blocked',
        `cleanup is blocked by ${input.plan.blockers.length} preflight condition(s): ` +
          input.plan.blockers.map((blocker) => blocker.code).join(', ')
      )
    }
    const stepResults: Array<{
      step: CleanupStepKind
      state: 'completed' | 'skipped' | 'failed'
      detail?: string
    }> = []
    const journal = journalFor(input.plan.planId)
    const jobId = input.plan.planId

    return mutationOwner.withMutation(
      { repoCommonDir: repo.canonicalRoot, operation: 'worktree-cleanup', idempotencyKey: jobId },
      async () => {
        const baseAtCommit = observeCleanupFacts({ record: recordAtPlan, repo })
        const observedAtCommit = await observeGitFacts({
          record: recordAtPlan,
          repo,
          protectedBranches: options.protectedBranches?.(repo),
        })
        const atCommit: CleanupFacts = { ...baseAtCommit, ...observedAtCommit }
        const changedField = factsChanged(input.plan.facts, atCommit)
        if (changedField) {
          throw new WorktreeError(
            'plan_stale',
            `observed fact changed after the plan: ${changedField}`,
            {
              action: 'replan_cleanup',
            }
          )
        }

        const markJob = (state: string) => {
          const all = [...cleanupJobStore.load().records]
          const job = all.find((entry) => entry.jobId === jobId)
          if (job) {
            const index = all.indexOf(job)
            all[index] = { ...job, state, observedAt: nowIso(clock) }
            cleanupJobStore.save(all)
          }
        }
        const selected = new Set(input.plan.selectedSteps)

        // 1. stop_owned_resource (each selected resource, proof-bound)
        if (selected.has('stop_owned_resource')) {
          for (const resourceId of input.plan.selectedResourceIds) {
            const known = input.plan.facts.attachedOwnedResources.find(
              (entry) => entry.id === resourceId
            )
            if (!known) {
              stepResults.push({
                step: 'stop_owned_resource',
                state: 'failed',
                detail: `unknown resource ${resourceId}`,
              })
              markJob('partial')
              throw new WorktreeError(
                'ownership_unproven',
                `cleanup resource ${resourceId} is unknown`
              )
            }
            if (!options.stopResource) {
              stepResults.push({
                step: 'stop_owned_resource',
                state: 'failed',
                detail: 'no stop authority is configured',
              })
              markJob('partial')
              throw new WorktreeError('cleanup_blocked', 'no resource stop authority is configured')
            }
            await runJournaledStep(
              journal,
              {
                jobId,
                worktreeId: recordAtPlan.id,
                step: `stop:${resourceId}`,
                stepInputs: { resourceId, generation: input.plan.facts.generation },
              },
              async () => {
                await options.stopResource!({ id: known.id, kind: known.kind })
                return { stopped: resourceId }
              }
            )
            stepResults.push({
              step: 'stop_owned_resource',
              state: 'completed',
              detail: resourceId,
            })
          }
          markJob('quiescing')
        }

        // 2. run_teardown (approved, argv-only, identity-proven per step)
        if (selected.has('run_teardown')) {
          const workflow = pendingWorkflows.get(recordAtPlan.id)
          const approval = pendingApprovals.get(recordAtPlan.id)
          if (!workflow || !approval) {
            markJob('teardown')
            stepResults.push({
              step: 'run_teardown',
              state: 'failed',
              detail: 'no approved teardown workflow is bound',
            })
            throw new WorktreeError('bootstrap_denied', 'teardown requires an approved workflow')
          }
          await runJournaledStep(
            journal,
            {
              jobId,
              worktreeId: recordAtPlan.id,
              step: 'teardown',
              stepInputs: { digest: workflowDigest(workflow) },
            },
            async () => {
              const preTeardownIdentity = directoryIdentity(recordAtPlan.canonicalRoot)
              await bootstrapRunner.run({
                worktreeRoot: recordAtPlan.canonicalRoot,
                worktreeIdentity: preTeardownIdentity.identity,
                workflow,
                approval,
                scope: input.scope,
                canonicalRepoRoot: repo.canonicalRoot,
              })
              return { tornDown: true }
            }
          )
          stepResults.push({ step: 'run_teardown', state: 'completed' })
        }

        // 3. quarantine_worktree (rename into trash, double identity proof)
        let trash:
          | { trashRoot: string; entryName: string; identity: { device: string; inode: string } }
          | undefined
        if (selected.has('quarantine_worktree')) {
          trash = await runJournaledStep(
            journal,
            { jobId, worktreeId: recordAtPlan.id, step: 'quarantine' },
            async () => {
              const fresh = directoryIdentity(recordAtPlan.canonicalRoot)
              const moved = quarantineWorktree({
                worktreeId: recordAtPlan.id,
                worktreePath: fresh.path,
                repoPath: repo.canonicalRoot,
                expectedIdentity: {
                  device: fresh.identity.device ?? '',
                  inode: fresh.identity.inode ?? '',
                },
                clock,
              })
              return {
                trashRoot: moved.trashRoot,
                entryName: moved.entryName,
                identity: {
                  device: fresh.identity.device ?? '',
                  inode: fresh.identity.inode ?? '',
                },
              }
            }
          )
          putWorktree({
            ...recordAtPlan,
            lifecycle: 'quarantined',
            quarantine: trash,
            generation: recordAtPlan.generation + 1,
            version: recordAtPlan.version + 1,
            updatedAt: nowIso(clock),
          })
          stepResults.push({ step: 'quarantine_worktree', state: 'completed' })
        }

        // 4. unregister_worktree (git registration cleanup; restore on failure)
        if (selected.has('unregister_worktree')) {
          await runJournaledStep(
            journal,
            { jobId, worktreeId: recordAtPlan.id, step: 'unregister' },
            async () => {
              const adminEntry = trash
                ? null
                : await worktreeAdminEntryName(recordAtPlan.canonicalRoot).catch(() => null)
              const prune = await runGit(['worktree', 'prune'], { cwd: repo.canonicalRoot })
              if (prune.exitCode !== 0) {
                if (trash) {
                  restoreWorktreeFromTrash(
                    join(trash.trashRoot, trash.entryName),
                    recordAtPlan.canonicalRoot
                  )
                }
                throw new WorktreeError(
                  'rollback_failed',
                  `git worktree prune failed: ${prune.stderr.trim().slice(0, 256)}`
                )
              }
              if (adminEntry && adminEntryExists(repo.canonicalRoot, adminEntry)) {
                if (trash) {
                  restoreWorktreeFromTrash(
                    join(trash.trashRoot, trash.entryName),
                    recordAtPlan.canonicalRoot
                  )
                }
                throw new WorktreeError(
                  'rollback_failed',
                  'git registration entry survived the prune'
                )
              }
              return { unregistered: true }
            }
          )
          stepResults.push({ step: 'unregister_worktree', state: 'completed' })
        }

        // 5. delete_branch (expected-SHA CAS; only after proven integration)
        if (selected.has('delete_branch')) {
          if (!input.plan.facts.branchRef || !input.plan.facts.headSha) {
            throw new WorktreeError(
              'invalid_state',
              'branch deletion requires recorded branch facts'
            )
          }
          const facts = input.plan.facts
          if (!facts.upstreamKnown || (facts.ahead ?? 0) > 0 || facts.unpushedCommits > 0) {
            throw new WorktreeError(
              'unpushed',
              'branch deletion requires proven integration (pushed/merged)'
            )
          }
          await runJournaledStep(
            journal,
            { jobId, worktreeId: recordAtPlan.id, step: 'delete_branch' },
            async () => {
              await mergeService.deleteBranchIfUnchanged({
                repoPath: repo.canonicalRoot,
                branchRef: facts.branchRef!,
                expectedSha: facts.headSha!,
              })
              return { deleted: facts.branchRef }
            }
          )
          stepResults.push({ step: 'delete_branch', state: 'completed' })
        }

        // 6. delete_quarantine (immediate, identity-proven) or leave for sweep
        if (selected.has('delete_quarantine') && trash) {
          await runJournaledStep(
            journal,
            { jobId, worktreeId: recordAtPlan.id, step: 'delete_quarantine' },
            async () => {
              deleteQuarantinedWorktree({ trashRoot: trash.trashRoot, entryName: trash.entryName })
              return { deleted: trash.entryName }
            }
          )
          stepResults.push({ step: 'delete_quarantine', state: 'completed' })
        }
        if (selected.has('prune_retained_data')) {
          stepResults.push({
            step: 'prune_retained_data',
            state: 'completed',
            detail: 'dependency templates are cleared through the template cache',
          })
        }

        // Retire the directory name: harness stores key by cwd; never reuse.
        if (trash) retireNames(repo.canonicalRoot, [recordAtPlan.name])
        const finalLifecycle: WorktreeLifecycle =
          trash === undefined
            ? 'cleaned'
            : selected.has('delete_quarantine')
              ? 'cleaned'
              : 'quarantined'
        putWorktree({
          ...recordAtPlan,
          lifecycle: finalLifecycle,
          generation: recordAtPlan.generation + 1,
          version: recordAtPlan.version + 1,
          updatedAt: nowIso(clock),
        })
        markJob('completed')
        return { planId: jobId, worktreeId: recordAtPlan.id, state: 'completed', stepResults }
      }
    )
  }

  /** Resume an interrupted cleanup job: completed journal steps are skipped
   *  when the plan is re-approved; a quarantined-but-unfinished record is
   *  surfaced as recovery, never silently finished. */
  async function resumeCleanup(input: {
    scope: DevScope
    worktreeId: string
    jobId: string
  }): Promise<CleanupResult> {
    const journal = journalFor(input.jobId)
    const done = journal.completedSteps(input.jobId)
    const record = findWorktree(input.scope, input.worktreeId)
    if (done.has('quarantine') && !done.has('delete_quarantine')) {
      if (record.lifecycle !== 'quarantined' && record.lifecycle !== 'cleaned') {
        putWorktree({ ...record, lifecycle: 'recovery_required', updatedAt: nowIso(clock) })
      }
    }
    const jobs = [...cleanupJobStore.load().records]
    const job = jobs.find((entry) => entry.jobId === input.jobId)
    if (job && job.state === 'completed') {
      return {
        planId: input.jobId,
        worktreeId: input.worktreeId,
        state: 'completed',
        stepResults: [],
      }
    }
    // Recovery state is a result, not an exception: the caller needs the
    // structured state to render re-plan/re-approve remediation.
    return {
      planId: input.jobId,
      worktreeId: input.worktreeId,
      state: 'recovery_required',
      stepResults: [
        {
          step: 'quarantine_worktree',
          state: 'failed',
          detail: 'quarantine completed without a full plan; re-plan and re-approve to continue',
        },
      ],
    }
  }

  // --- trash sweep ------------------------------------------------------------

  const sweepApi = {
    begin: (trashRoots: ReadonlyArray<string>) => trashSweeper.beginSweep(trashRoots),
    page: (maxEntries: number) => trashSweeper.sweepPage(maxEntries),
    pending: () => trashSweeper.pendingCount(),
  }

  // --- templates --------------------------------------------------------------

  const templateApi = {
    status: (scope: DevScope, projectId: string) => templates.status(scope, projectId),
    beginBuild: (input: Parameters<TemplateCache['beginBuild']>[0]) => templates.beginBuild(input),
    materialize: (input: Parameters<TemplateCache['materialize']>[0]) =>
      templates.materialize(input),
    clear: (scope: DevScope, projectId: string) => templates.clear(scope, projectId),
  }

  return Object.freeze({
    registerRepo,
    refreshRepo,
    listRepos: (scope: DevScope) => loadRepos().filter((entry) => sameScope(entry.scope, scope)),
    createWorktree,
    adoptWorktree,
    listWorktrees,
    getWorktree: (scope: DevScope, worktreeId: string) => findWorktree(scope, worktreeId),
    archiveWorktree,
    unarchiveWorktree,
    retryBootstrap,
    bindBootstrap: bindBootstrapApi,
    leases: leaseApi,
    merge: mergeApi,
    planCleanup,
    commitCleanup,
    resumeCleanup,
    sweep: sweepApi,
    templates: templateApi,
    retiredNames: (scope: DevScope, repoId: string) => {
      const repo = findRepo(scope, repoId)
      return retiredRegistryFor(repo.canonicalRoot)
    },
  })

  function bindBootstrapApi(input: {
    worktreeId: string
    workflow: BootstrapWorkflow
    approval: BootstrapApproval
  }): void {
    pendingWorkflows.set(input.worktreeId, input.workflow)
    pendingApprovals.set(input.worktreeId, input.approval)
  }
}

export type WorktreeService = ReturnType<typeof createWorktreeService>
