// Workspace-owned device data only. Files and account-wide credentials are
// never inferred to be disposable from a directory name or a string match.
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Scope } from '../../../../packages/types/src/dev-runtime'
import type { MemoryStore } from './memory/store'
import { assertMemoryWorkspaceId } from './memory/store'
import { createDurableJsonStore } from './dev-runtime/host-store'
import { detachWorkspaceConnections } from './dev-runtime/connections/store'

const CONTENT_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
const SCOPED_RECORDS = [
  ['roots', 'bookmarks.json'],
  ['grants', 'grants.json'],
  ['repos', 'registry.json'],
  ['worktrees', 'worktrees.json'],
  ['worktrees', 'repos.json'],
  ['worktrees', 'leases.json'],
  ['resources', 'cleanup-policies.json'],
  ['worktrees/templates', 'records.json'],
] as const

function regularFile(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return false
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('workspace_cleanup_ambiguous_data')
  return true
}
function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.accountId === b.accountId &&
    a.workspaceId === b.workspaceId &&
    a.runtimeNodeId === b.runtimeNodeId
  )
}
function atomicJson(path: string, value: unknown) {
  const temp = `${path}.tmp-${randomUUID()}`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  const handle = openSync(temp, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temp, path)
  const directory = openSync(dirname(path), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

export type WorkspaceLocalDataPlan = Readonly<{
  contentIds: readonly string[]
  memoryEntries: number
  /** User repositories/worktrees remain user files; their Adea bindings go. */
  registryRecords: number
}>

export function assertWorkspaceDataPath(dataDir: string, path: string) {
  const parts = relative(dataDir, path).split('/')
  if (parts.includes('..')) throw new Error('workspace_cleanup_ambiguous_data')
  let candidate = dataDir
  for (const part of parts.slice(0, -1)) {
    candidate = join(candidate, part)
    const stat = lstatSync(candidate, { throwIfNoEntry: false })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('workspace_cleanup_ambiguous_data')
  }
  return path
}

export function workspaceLocalData(input: { dataDir: string; scope: Scope; memory: MemoryStore }) {
  const { dataDir, scope, memory } = input
  assertMemoryWorkspaceId(scope.workspaceId)
  const safePath = (path: string) => assertWorkspaceDataPath(dataDir, path)
  const contentDir = join(dataDir, 'local-content')
  const indexFile = join(contentDir, 'index.json')
  function index(): Record<string, { id: string; workspaceId: string }> {
    if (!regularFile(safePath(indexFile))) return {}
    const value = JSON.parse(readFileSync(indexFile, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('workspace_cleanup_ambiguous_data')
    for (const [id, ref] of Object.entries(value)) {
      const record = ref as { id?: unknown; workspaceId?: unknown }
      if (!CONTENT_ID.test(id) || record?.id !== id || typeof record.workspaceId !== 'string')
        throw new Error('workspace_cleanup_ambiguous_data')
    }
    return value
  }
  function registries() {
    return SCOPED_RECORDS.flatMap(([dir, file]) => {
      const path = join(dataDir, 'dev-runtime', dir, file)
      if (!regularFile(safePath(path))) return []
      const store = createDurableJsonStore<{ scope: Scope }>({
        file: path,
        schemaVersion: 1,
        label: 'workspace cleanup',
      })
      const records = [...store.load().records]
      for (const record of records) {
        const candidate = record?.scope
        if (
          !candidate ||
          typeof candidate.accountId !== 'string' ||
          typeof candidate.workspaceId !== 'string' ||
          typeof candidate.runtimeNodeId !== 'string'
        )
          throw new Error('workspace_cleanup_ambiguous_data')
        if (candidate.workspaceId === scope.workspaceId && !sameScope(candidate, scope))
          throw new Error('workspace_cleanup_additional_scope')
      }
      return [{ path, store, records }]
    })
  }
  let related: { repoIds: Set<string>; worktreeIds: Set<string> } | undefined
  function relatedRecords() {
    const files = registries()
    related ??= { repoIds: new Set(), worktreeIds: new Set() }
    for (const { path, records } of files) {
      for (const record of records.filter((candidate) => sameScope(candidate.scope, scope))) {
        const item = record as typeof record & { id?: string; layout?: string; lifecycle?: string }
        if (path.endsWith('/repos/registry.json')) {
          if (item.id) related.repoIds.add(item.id)
          // A failed physical managed-clone removal retains its recovery
          // record. Never erase that evidence to make the retry look complete.
          if (item.layout === 'bare_managed' && item.lifecycle === 'unavailable')
            throw new Error('workspace_cleanup_managed_repositories_pending')
        }
        if (path.endsWith('/worktrees/worktrees.json') && item.id) related.worktreeIds.add(item.id)
      }
    }
    const linked = [
      ['repo-fingerprints.json', 'repoId'],
      ['cleanup-jobs.json', 'worktreeId'],
      ['merge-records.json', 'worktreeId'],
    ] as const
    const associated = linked.flatMap(([file, key]) => {
      const path = safePath(join(dataDir, 'dev-runtime', 'worktrees', file))
      if (!regularFile(path)) return []
      const store = createDurableJsonStore<Record<string, unknown>>({
        file: path,
        schemaVersion: 1,
        label: 'workspace related records',
      })
      const records = [...store.load().records]
      const owned = records.filter(
        (record) =>
          typeof record[key] === 'string' &&
          (key === 'repoId' ? related!.repoIds : related!.worktreeIds).has(record[key] as string)
      )
      for (const record of owned) {
        if (file === 'cleanup-jobs.json' && record.state !== 'completed')
          throw new Error('workspace_cleanup_worktree_recovery_pending')
        if (
          file === 'merge-records.json' &&
          !['merged', 'aborted'].includes(record.state as string)
        )
          throw new Error('workspace_cleanup_worktree_recovery_pending')
        if (file === 'cleanup-jobs.json') {
          if (typeof record.jobId !== 'string' || !CONTENT_ID.test(record.jobId))
            throw new Error('workspace_cleanup_ambiguous_data')
          regularFile(
            safePath(join(dataDir, 'dev-runtime', 'worktrees', 'journal', `${record.jobId}.jsonl`))
          )
        }
      }
      return [{ file, store, records, owned }]
    })
    const templates = files
      .filter(({ path }) => path.endsWith('/worktrees/templates/records.json'))
      .flatMap(({ records }) => records.filter((candidate) => sameScope(candidate.scope, scope)))
    const templatePaths = templates.map((record) => {
      const item = record as typeof record & { projectId?: string; state?: string }
      if (item.state === 'building') throw new Error('workspace_cleanup_running_work')
      if (typeof item.projectId !== 'string') throw new Error('workspace_cleanup_ambiguous_data')
      const digest = createHash('sha256')
        .update(JSON.stringify({ scope, projectId: item.projectId }))
        .digest('hex')
        .slice(0, 32)
      const path = safePath(join(dataDir, 'dev-runtime', 'worktrees', 'templates', digest))
      const stat = lstatSync(path, { throwIfNoEntry: false })
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error('workspace_cleanup_ambiguous_data')
      return path
    })
    return { associated, templatePaths }
  }
  function plan(): WorkspaceLocalDataPlan {
    const refs = index()
    // Unindexed ciphertext and retained recovery copies lack a safe owner
    // proof. Keep deletion pending instead of guessing or claiming a purge.
    for (const name of readdirSync(contentDir))
      if (
        (name.endsWith('.sealed') && !refs[name.slice(0, -7)]) ||
        name.includes('.tmp') ||
        name.includes('.corrupt-')
      )
        throw new Error('workspace_cleanup_ambiguous_data')
    for (const [dir, file] of SCOPED_RECORDS) {
      const path = safePath(join(dataDir, 'dev-runtime', dir, file))
      const parent = dirname(path)
      if (
        lstatSync(parent, { throwIfNoEntry: false }) &&
        readdirSync(parent).some(
          (name) => name.startsWith(`${file}.corrupt-`) || name.startsWith(`${file}.tmp-`)
        )
      )
        throw new Error('workspace_cleanup_ambiguous_data')
    }
    const digest = createHash('sha256')
      .update(JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId]))
      .digest('hex')
    const legacy = safePath(
      join(dataDir, 'dev-runtime', 'project-session', `authority-${digest}.sqlite3`)
    )
    const unscopedLegacy = safePath(
      join(dataDir, 'dev-runtime', 'project-session', 'authority.sqlite3')
    )
    if (
      lstatSync(legacy, { throwIfNoEntry: false }) ||
      lstatSync(unscopedLegacy, { throwIfNoEntry: false })
    )
      throw new Error('workspace_cleanup_legacy_data_pending')
    const contentIds = Object.values(refs)
      .filter((ref) => ref.workspaceId === scope.workspaceId)
      .map((ref) => ref.id)
    for (const id of contentIds) regularFile(safePath(join(contentDir, `${id}.sealed`)))
    relatedRecords()
    safePath(join(contentDir, 'memory', '.ownership-check'))
    memory.validateWorkspacePurge(scope.workspaceId)
    const snapshot = memory.list(scope.workspaceId)
    if (snapshot.unreadable) throw new Error('workspace_cleanup_ambiguous_data')
    const registryRecords = registries().reduce(
      (count, item) =>
        count + item.records.filter((candidate) => sameScope(candidate.scope, scope)).length,
      0
    )
    return { contentIds, memoryEntries: snapshot.entries.length, registryRecords }
  }
  return {
    plan,
    purge(): WorkspaceLocalDataPlan {
      const snapshot = plan() // Fail ambiguous ownership before the first deletion.
      const { associated, templatePaths } = relatedRecords()
      // Related metadata goes first while its owning registry IDs still exist.
      for (const path of templatePaths) rmSync(path, { force: true, recursive: true })
      for (const item of associated) {
        if (item.file === 'cleanup-jobs.json')
          for (const record of item.owned)
            rmSync(
              safePath(
                join(dataDir, 'dev-runtime', 'worktrees', 'journal', `${record.jobId}.jsonl`)
              ),
              { force: true }
            )
        item.store.save(item.records.filter((record) => !item.owned.includes(record)))
      }
      memory.purgeWorkspace(scope.workspaceId)
      const refs = index()
      // Unlink before dropping the index reference: a crash retains enough
      // information to retry an unfinished ciphertext removal.
      for (const id of snapshot.contentIds) {
        rmSync(join(contentDir, `${id}.sealed`), { force: true })
        delete refs[id]
      }
      if (regularFile(safePath(indexFile))) atomicJson(indexFile, refs)
      detachWorkspaceConnections({ dataDir, scope })
      for (const { store, records } of registries())
        store.save(records.filter((record) => !sameScope(record.scope, scope)))
      return snapshot
    },
  }
}
