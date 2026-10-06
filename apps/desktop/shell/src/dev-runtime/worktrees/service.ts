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
import { basename, join, resolve, sep } from 'node:path'

import { nowIso, newRecordId, sameScope, type DevScope } from '../authority'
import { createDurableJsonStore } from '../host-store'
import type { AuthorityAudit } from '../audit'
import type { RootBookmarkAuthority } from '../roots'
import { createRepoRegistryStore, type RepoRegistryRecord } from '../repos/registry-store'
import {
  ensureManagedWorktreeBase,
  nonInteractiveTransportEnv,
  proveManagedBareRepo,
} from '../repos/managed'
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
  isTrashEntryName,
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

function cleanupJournalStepName(step: CleanupStepKind): string {
  if (step === 'quarantine_worktree') return 'quarantine'
  if (step === 'unregister_worktree') return 'unregister'
  return step
}

/** The worktree service's view of one record in the single repository
 *  registry (`dev-runtime/repos/registry.json`, ADR 0011): the registry
 *  record plus the short default branch name derived from `defaultRef`. */
export type RepoRecord = RepoRegistryRecord & Readonly<{ defaultBranch?: string }>

/** `primary` is the repository's own checkout (one per git repository,
 *  created on registration); `managed` worktrees were created by Adea;
 *  `external` worktrees were adopted after gitdir proof. */
export type WorktreeKind = 'primary' | 'managed' | 'external'

/** Local display titles are workspace-private and bounded. */
export const WORKTREE_TITLE_MAX_LENGTH = 120
/** `dev.worktree.diffSummary` answers at most this many worktrees per call. */
export const DIFF_SUMMARY_MAX_WORKTREES = 50
const DIFF_SUMMARY_TIMEOUT_MS = 10_000
const DIFF_SUMMARY_MAX_OUTPUT_BYTES = 1024 * 1024
const GIT_HEAD_READ_TIMEOUT_MS = 10_000

export type WorktreeDiffSummary = Readonly<{
  worktreeId: string
  added: number
  removed: number
  filesChanged: number
}>

export type WorktreeRecord = Readonly<{
  id: string
  scope: DevScope
  projectId: string
  repoId: string
  kind: WorktreeKind
  /** The on-disk directory name; retired on delete, never reused. */
  name: string
  branchRef?: string
  /** Local display title (workspace-private; never leaves the device). */
  title?: string
  /** Opaque cloud task id this worktree is linked to. */
  taskId?: string
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
  /** `skipped: 'no_primary_working_tree'` for a managed bare clone: there is
   *  no working tree to copy `.worktreeinclude` files from. */
  includeCopy?: Readonly<{ copied: ReadonlyArray<string>; skipped?: 'no_primary_working_tree' }>
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
   *  active repository bookmark on this scope — or, for a managed bare clone,
   *  be exactly its owner-only `managed-worktrees/<repoId>` base. */
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
  /** Workspace connections (ADR 0012): env for the base-update fetch child,
   *  resolved through the active workspace's git hosting binding. Absent or
   *  resolving undefined keeps the device's own git credentials. */
  resolveFetchEnv?: (input: {
    canonicalRoot: string
    remote: string
    operation: string
  }) => Promise<Record<string, string> | undefined>
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

  // The one repository registry (ADR 0011). The former worktree-private
  // `repos.json` beside the worktree stores is left unread.
  const repoRegistry = createRepoRegistryStore(dataDir)
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
    /** Selected steps survive a shell restart for recovery reporting. */
    selectedSteps?: CleanupStepKind[]
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
    return repoRegistry.load().map((record) => {
      const defaultBranch = record.defaultRef?.replace(/^refs\/heads\//, '')
      return defaultBranch ? { ...record, defaultBranch } : record
    })
  }

  function loadWorktrees(): WorktreeRecord[] {
    // Records persisted before `kind` existed derive it from provenance; the
    // primary checkout was never a record then.
    return worktreeStore
      .load()
      .records.map((record) =>
        record.kind !== undefined
          ? record
          : { ...record, kind: record.provenance === 'adea' ? 'managed' : 'external' }
      )
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

  /** The layout gate every repository-mutating path runs first. A managed
   *  bare clone is admitted only after the managed proof (owner-only managed
   *  root, bare layout, `core.bare=true`, recorded identity); any other git
   *  record must still be a checkout with a `.git` directory — every other
   *  bare repository stays refused. */
  async function proveRepoLayout(repo: RepoRecord): Promise<void> {
    if (repo.layout === 'bare_managed') {
      await proveManagedBareRepo({
        dataDir,
        canonicalRoot: repo.canonicalRoot,
        repoId: repo.id,
        expectedIdentity: repo.rootIdentity,
      })
      return
    }
    if (repo.kind !== 'git') return
    const dotGit = lstatSync(join(repo.canonicalRoot, '.git'), { throwIfNoEntry: false })
    if (!dotGit?.isDirectory())
      throw new WorktreeError('not_git_repo', 'bare repositories are unsupported')
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
   *  (be it, or an ancestor of it); bare repositories are unsupported here —
   *  the only admitted bare layout is a managed clone, which
   *  `dev.project.clone` registers without a bookmark. */
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

    const repos = repoRegistry.load()
    const existing = repos.find(
      (entry) => sameScope(entry.scope, input.scope) && entry.canonicalRoot === canonicalRoot
    )
    let record: RepoRegistryRecord
    if (existing) {
      const projectIds = [...new Set([...existing.projectIds, input.projectId])]
      record =
        projectIds.length === existing.projectIds.length
          ? existing
          : { ...existing, projectIds, version: existing.version + 1, updatedAt: nowIso(clock) }
      if (record !== existing) repoRegistry.upsert(record)
    } else {
      const remoteUrl =
        kind === 'git' && input.remote !== undefined
          ? await configuredRemoteUrl(canonicalRoot, input.remote)
          : undefined
      const defaultRef =
        input.defaultRef ??
        (input.defaultBranch !== undefined ? `refs/heads/${input.defaultBranch}` : undefined)
      record = {
        id: newRecordId(),
        scope: { ...input.scope },
        kind,
        lifecycle: 'ready',
        canonicalRoot,
        rootIdentity: identity,
        rootBookmarkId: input.bookmarkId,
        ...(remoteUrl !== undefined ? { remote: remoteUrl } : {}),
        ...(input.remote !== undefined ? { fetchRemote: input.remote } : {}),
        ...(defaultRef !== undefined ? { defaultRef } : {}),
        projectIds: [input.projectId],
        version: 1,
        updatedAt: nowIso(clock),
      }
      repoRegistry.upsert(record)
      log('repo.registered', record.id, 'granted', { kind })
    }
    await ensurePrimaryWorktree({ scope: input.scope, repoId: record.id })
    return findRepo(input.scope, record.id)
  }

  /** The configured URL of a named remote (local config only, no network). */
  async function configuredRemoteUrl(
    canonicalRoot: string,
    remoteName: string
  ): Promise<string | undefined> {
    const result = await runGit(['config', '--get', `remote.${remoteName}.url`], {
      cwd: canonicalRoot,
      timeoutMs: GIT_HEAD_READ_TIMEOUT_MS,
    }).catch(() => undefined)
    const url = result?.exitCode === 0 ? result.stdout.trim() : ''
    return url.length > 0 ? url : undefined
  }

  /** The checkout's current branch ref and HEAD commit from local git reads
   *  only. A detached HEAD has no branch ref; an unborn branch has no SHA. */
  async function inspectHead(root: string): Promise<{ headRef?: string; headSha?: string }> {
    const [symbolic, sha] = await Promise.all([
      runGit(['symbolic-ref', '--quiet', 'HEAD'], {
        cwd: root,
        timeoutMs: GIT_HEAD_READ_TIMEOUT_MS,
      }).catch(() => undefined),
      runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
        cwd: root,
        timeoutMs: GIT_HEAD_READ_TIMEOUT_MS,
      }).catch(() => undefined),
    ])
    const headRef = symbolic?.exitCode === 0 ? symbolic.stdout.trim() : ''
    const headSha = sha?.exitCode === 0 ? sha.stdout.trim() : ''
    return {
      ...(headRef.length > 0 ? { headRef } : {}),
      ...(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(headSha) ? { headSha } : {}),
    }
  }

  function primaryRecordFor(scope: DevScope, repoId: string): WorktreeRecord | undefined {
    return loadWorktrees().find(
      (entry) =>
        entry.kind === 'primary' &&
        entry.repoId === repoId &&
        sameScope(entry.scope, scope) &&
        entry.lifecycle !== 'cleaned'
    )
  }

  /** ADR 0011: a registered git repository's own checkout is exactly one
   *  `kind: 'primary'` worktree record. Creates it on first registration and
   *  otherwise refreshes its inspected branch/HEAD. Folder repositories and
   *  managed bare clones (remote-only projects) have no primary record. */
  async function ensurePrimaryWorktree(input: {
    scope: DevScope
    repoId: string
  }): Promise<WorktreeRecord | undefined> {
    const repo = findRepo(input.scope, input.repoId)
    if (repo.kind !== 'git' || repo.layout === 'bare_managed') return undefined
    const existing = primaryRecordFor(input.scope, repo.id)
    if (existing) return refreshPrimaryHead(existing, repo)
    const { path, identity } = directoryIdentity(repo.canonicalRoot)
    const head = await inspectHead(path)
    const record: WorktreeRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      kind: 'primary',
      projectId: repo.projectIds[0] ?? '',
      repoId: repo.id,
      name: basename(path),
      ...(head.headRef !== undefined ? { branchRef: head.headRef, headRef: head.headRef } : {}),
      ...(head.headSha !== undefined ? { headSha: head.headSha } : {}),
      canonicalRoot: path,
      rootIdentity: identity,
      // The primary checkout was not created by Adea: every ownership-gated
      // path (merge-back, cleanup) treats it as external.
      provenance: 'external',
      lifecycle: 'ready',
      bootstrap: { state: 'not_started' },
      archived: false,
      generation: 1,
      version: 1,
      createdAt: nowIso(clock),
      updatedAt: nowIso(clock),
    }
    putWorktree(record)
    log('worktree.primary_registered', record.id, 'granted', { kind: 'primary' })
    return record
  }

  /** Re-inspect the primary checkout's branch/HEAD; persists (version + 1,
   *  generation unchanged) only when the observed facts moved. */
  async function refreshPrimaryHead(
    record: WorktreeRecord,
    repo: RepoRecord
  ): Promise<WorktreeRecord> {
    if (record.kind !== 'primary' || repo.kind !== 'git') return record
    if (!existsSync(record.canonicalRoot)) return record
    const head = await inspectHead(record.canonicalRoot)
    if (head.headRef === record.headRef && head.headSha === record.headSha) return record
    // A detached or unborn HEAD clears the stale fact (undefined is not
    // persisted by the JSON store).
    const next: WorktreeRecord = {
      ...record,
      branchRef: head.headRef,
      headRef: head.headRef,
      headSha: head.headSha,
      version: record.version + 1,
      updatedAt: nowIso(clock),
    }
    putWorktree(next)
    return next
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
    // The primary checkout's branch/HEAD move with the admin fingerprint
    // (it stamps the main HEAD), so the same gated pass refreshes it.
    const primary = primaryRecordFor(repo.scope, repo.id)
    if (primary && primary.lifecycle === 'ready') await refreshPrimaryHead(primary, repo)
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
    await proveRepoLayout(repo)
    const repoIdentity = directoryIdentity(repo.canonicalRoot)
    if (!sameIdentity(repoIdentity.identity, repo.rootIdentity)) {
      throw new WorktreeError('identity_mismatch', 'repository root identity changed')
    }
    // 2. Refresh the worktree-admin fingerprint under the mutation lock.
    await refreshRepo({ scope: input.scope, repoId: repo.id })

    // 3. Update the base from the selected remote (bounded, typed failures).
    //    Never mutates or resets the primary checkout: `git fetch` writes only
    //    remote-tracking refs under the common dir.
    if (input.updateBase !== false && repo.fetchRemote) {
      let fetchEnv: Record<string, string> | undefined
      try {
        fetchEnv = await options.resolveFetchEnv?.({
          canonicalRoot: repo.canonicalRoot,
          remote: repo.fetchRemote,
          operation: 'dev.worktree.create',
        })
      } catch (error) {
        // A bound connection that cannot be used fails closed: never a
        // silent fall back to the device's own credentials.
        log('worktree.base_fetch', repo.id, 'failed', { code: 'auth_required' })
        throw new WorktreeError(
          'auth_required',
          (error as { message?: string }).message ?? 'the workspace git connection cannot be used'
        )
      }
      try {
        await runGitChecked(['fetch', repo.fetchRemote, '--prune'], {
          cwd: repo.canonicalRoot,
          timeoutMs: fetchTimeoutMs,
          signal: input.signal,
          // A managed clone's network children never prompt (batch SSH); a
          // bound workspace connection adds its credential environment.
          ...(repo.layout === 'bare_managed' || fetchEnv
            ? {
                env: {
                  ...(repo.layout === 'bare_managed' ? nonInteractiveTransportEnv() : {}),
                  ...fetchEnv,
                },
              }
            : {}),
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
          `updating the base from ${repo.fetchRemote} failed: ${(error as Error).message}`,
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
    if (repo.layout === 'bare_managed') {
      // No user bookmark sits above a managed clone: its worktrees live only
      // under its own owner-only managed base.
      if (baseDir !== ensureManagedWorktreeBase(dataDir, repo.id)) {
        throw new WorktreeError(
          'unauthorized_root',
          'a managed clone creates worktrees only under its managed worktree root'
        )
      }
    } else {
      assertBaseDirAuthorized(input.scope, baseDir)
    }
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
      kind: 'managed',
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

    // 6. Approved include copy (CoW clones; approved items only). A managed
    //    bare clone has no primary working tree to copy from: the step is
    //    reported as skipped, never satisfied from the bare admin dir.
    let includeCopy: { copied: string[]; skipped?: 'no_primary_working_tree' } | undefined
    try {
      if (repo.layout === 'bare_managed') {
        includeCopy = { copied: [], skipped: 'no_primary_working_tree' }
        log('worktree.include_copy', record.id, 'granted', { skipped: 'no_primary_working_tree' })
      } else {
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
    await proveRepoLayout(repo)
    const proof = await proveExternalWorktree({
      worktreePath: input.worktreePath,
      repoRoot: repo.canonicalRoot,
      // A bare repository is its own common dir; a checkout's is `.git`.
      repoCommonDir:
        repo.layout === 'bare_managed' ? repo.canonicalRoot : join(repo.canonicalRoot, '.git'),
    })
    // Each checkout is represented exactly once: a path that already has a
    // live record (managed, external, or the primary) is not re-adopted.
    const recorded = loadWorktrees().find(
      (entry) =>
        sameScope(entry.scope, input.scope) &&
        entry.canonicalRoot === proof.canonicalRoot &&
        entry.lifecycle !== 'cleaned' &&
        entry.lifecycle !== 'quarantined'
    )
    if (recorded) {
      throw new WorktreeError('invalid_state', 'this checkout already has a worktree record')
    }
    const branchRef = await currentBranchRef(proof.canonicalRoot)
    const headSha = await gitRevParse(proof.canonicalRoot, 'HEAD').catch(() => undefined)
    const record: WorktreeRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      kind: 'external',
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
    refusePrimary(record, 'archived')
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

  /** The primary checkout is the repository itself: it is never archived,
   *  merged back, cleaned up, renamed, or deleted. Typed refusal. */
  function refusePrimary(record: WorktreeRecord, action: string): void {
    if (record.kind === 'primary') {
      throw new WorktreeError('invalid_state', `the primary checkout cannot be ${action}`)
    }
  }

  /** Set (or clear, with a blank title) the local display title of a managed
   *  or external worktree. Metadata only: the version moves, the generation
   *  (the lease/plan fence) does not, and nothing on disk changes. */
  function renameWorktree(input: {
    scope: DevScope
    worktreeId: string
    expectedVersion: number
    title: string
  }): WorktreeRecord {
    const record = findWorktree(input.scope, input.worktreeId)
    refusePrimary(record, 'renamed')
    if (record.version !== input.expectedVersion) {
      throw new WorktreeError('stale_version', 'worktree version moved')
    }
    if (record.lifecycle === 'quarantined' || record.lifecycle === 'cleaned') {
      throw new WorktreeError('invalid_state', 'a removed worktree cannot be renamed')
    }
    const title = input.title.trim()
    if (title.length > WORKTREE_TITLE_MAX_LENGTH) {
      throw new WorktreeError('limit_exceeded', 'worktree title is too long')
    }
    // oxlint-disable-next-line no-control-regex -- titles reject control characters by design
    if (/[\u0000-\u001f\u007f]/.test(title)) {
      throw new WorktreeError('invalid_state', 'worktree title contains control characters')
    }
    if ((record.title ?? '') === title) return record
    const next: WorktreeRecord = {
      ...record,
      title: title.length > 0 ? title : undefined,
      version: record.version + 1,
      updatedAt: nowIso(clock),
    }
    putWorktree(next)
    log('worktree.renamed', record.id, 'granted')
    return next
  }

  /** Line/file counts of each worktree's tracked changes (working tree and
   *  index) against its recorded base commit, or HEAD when no base is
   *  recorded (the primary checkout, adopted worktrees). Local git only,
   *  bounded per worktree, counts only — no paths or content leave here.
   *  Unknown ids refuse the whole call; a worktree whose checkout cannot be
   *  observed right now is omitted rather than reported as clean. */
  async function diffSummary(input: {
    scope: DevScope
    worktreeIds: ReadonlyArray<string>
  }): Promise<WorktreeDiffSummary[]> {
    if (input.worktreeIds.length > DIFF_SUMMARY_MAX_WORKTREES) {
      throw new WorktreeError('limit_exceeded', 'too many worktrees in one diff summary')
    }
    const ids = [...new Set(input.worktreeIds)]
    const records = ids.map((id) => findWorktree(input.scope, id))
    const results: WorktreeDiffSummary[] = []
    for (const record of records) {
      if (
        record.lifecycle === 'cleaned' ||
        record.lifecycle === 'quarantined' ||
        !existsSync(record.canonicalRoot)
      )
        continue
      const base = record.baseSha ?? 'HEAD'
      const result = await runGit(
        ['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--'],
        {
          cwd: record.canonicalRoot,
          timeoutMs: DIFF_SUMMARY_TIMEOUT_MS,
          maxOutputBytes: DIFF_SUMMARY_MAX_OUTPUT_BYTES,
        }
      ).catch(() => undefined)
      if (!result || result.exitCode !== 0) continue
      let added = 0
      let removed = 0
      let filesChanged = 0
      for (const line of result.stdout.split('\n')) {
        if (line.length === 0) continue
        const [addedText, removedText] = line.split('\t')
        filesChanged += 1
        // Binary files report `-`: counted as a changed file, zero lines.
        if (addedText !== '-') added += Number(addedText) || 0
        if (removedText !== '-') removed += Number(removedText) || 0
      }
      results.push({ worktreeId: record.id, added, removed, filesChanged })
    }
    return results
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
      refusePrimary(record, 'merged back')
      if (record.provenance !== 'adea') {
        throw new WorktreeError('external_ownership', 'external worktrees do not merge back')
      }
      const repo = findRepo(input.scope, record.repoId)
      await proveRepoLayout(repo)
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
    refusePrimary(record, 'cleaned up')
    if (record.generation !== input.expectedGeneration) {
      throw new WorktreeError('stale_generation', 'worktree generation moved')
    }
    const repo = findRepo(input.scope, record.repoId)
    await proveRepoLayout(repo)
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
      selectedSteps: [...plan.selectedSteps],
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
    refusePrimary(recordAtPlan, 'cleaned up')
    const repo = findRepo(input.scope, recordAtPlan.repoId)
    await proveRepoLayout(repo)
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
    const record = findWorktree(input.scope, input.worktreeId)
    refusePrimary(record, 'cleaned up')
    const jobs = [...cleanupJobStore.load().records]
    const job = jobs.find((entry) => entry.jobId === input.jobId)
    const latest = journal.latestSteps(input.jobId)
    const selectedSteps = job?.selectedSteps ?? []

    const recoveryResults = (): CleanupResult['stepResults'] =>
      selectedSteps.map((step) => {
        const entry =
          step === 'stop_owned_resource'
            ? [...latest.entries()].find(([name]) => name.startsWith('stop:'))?.[1]
            : latest.get(cleanupJournalStepName(step))
        if (!entry) {
          return { step, state: 'skipped', detail: 'step was not reached before interruption' }
        }
        if (entry.state === 'completed') return { step, state: 'completed' }
        if (entry.state === 'rolled_back')
          return { step, state: 'rolled_back', detail: 'rolled back safely' }
        return { step, state: 'failed', detail: 'step was interrupted before durable completion' }
      })

    // The only automatic rollback is the narrow crash window after a proven
    // quarantine rename and before the worktree record update. Later steps
    // may have changed Git registration or deleted the trash entry, so those
    // cases remain recovery_required for an explicit operator decision.
    const quarantine = latest.get('quarantine')
    const laterStepExists = [...latest.keys()].some((step) => step !== 'quarantine')
    if (
      quarantine?.state === 'completed' &&
      !laterStepExists &&
      record.lifecycle !== 'quarantined' &&
      record.lifecycle !== 'cleaned'
    ) {
      const result = quarantine.result
      const trashRoot = typeof result?.trashRoot === 'string' ? result.trashRoot : undefined
      const entryName = typeof result?.entryName === 'string' ? result.entryName : undefined
      const identity = result?.identity
      const identityMatches =
        identity &&
        typeof identity === 'object' &&
        (identity as { device?: unknown }).device === record.rootIdentity.device &&
        (identity as { inode?: unknown }).inode === record.rootIdentity.inode
      const expectedTrashRoot = resolve(worktreeTrashRoot(record.canonicalRoot))
      const trashPath = trashRoot && entryName ? join(resolve(trashRoot), entryName) : undefined
      const provenanceProven =
        trashRoot !== undefined &&
        entryName !== undefined &&
        isTrashEntryName(entryName) &&
        resolve(trashRoot) === expectedTrashRoot &&
        trashPath === resolve(join(trashRoot, entryName)) &&
        identityMatches === true &&
        !existsSync(record.canonicalRoot) &&
        existsSync(trashPath)
      if (provenanceProven && restoreWorktreeFromTrash(trashPath, record.canonicalRoot)) {
        const rolledBack = journal.append({
          jobId: input.jobId,
          worktreeId: record.id,
          seq: journal.lastSeq(input.jobId) + 1,
          step: 'quarantine',
          state: 'rolled_back',
          result: { restored: true },
        })
        latest.set('quarantine', rolledBack)
        const index = job ? jobs.indexOf(job) : -1
        if (index >= 0 && job) {
          jobs[index] = { ...job, state: 'partial', observedAt: nowIso(clock) }
          cleanupJobStore.save(jobs)
        }
        return {
          planId: input.jobId,
          worktreeId: input.worktreeId,
          state: 'partial',
          stepResults: recoveryResults(),
        }
      }
    }

    if (record.lifecycle !== 'quarantined' && record.lifecycle !== 'cleaned') {
      putWorktree({ ...record, lifecycle: 'recovery_required', updatedAt: nowIso(clock) })
    }
    if (job && job.state === 'completed') {
      return {
        planId: input.jobId,
        worktreeId: input.worktreeId,
        state: 'completed',
        stepResults: recoveryResults(),
      }
    }
    // Recovery state is a result, not an exception: the caller needs the
    // structured state to render re-plan/re-approve remediation.
    return {
      planId: input.jobId,
      worktreeId: input.worktreeId,
      state: 'recovery_required',
      stepResults:
        recoveryResults().length > 0
          ? recoveryResults()
          : [
              {
                step: 'quarantine_worktree',
                state: 'failed',
                detail: 'cleanup job has no durable plan; re-plan and re-approve to continue',
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
    ensurePrimaryWorktree,
    createWorktree,
    adoptWorktree,
    listWorktrees,
    renameWorktree,
    diffSummary,
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
