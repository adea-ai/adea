// Worktree storage measurement (spec "Machine-wide inventory and foreign
// stop", Worktree storage). Disk size is the expensive resource observation:
// a dependency folder can hold hundreds of thousands of files. So the walk is
// lazy (it starts only when a caller asks for the bytes), one walker runs per
// runtime node at a time with at most four concurrent directory reads, it
// never follows symlinks or crosses mount points, and it spends at most two
// minutes per worktree before yielding. A walk that runs out of budget
// reports `stale`, keeps its previous bytes, and resumes from where it
// stopped on the next request. A finished result is served from cache and
// re-measured only after 15 minutes.
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { WorktreeStorageRecord } from '../../../../../../packages/types/src/dev-runtime'

export const STORAGE_WALK_BUDGET_MS = 2 * 60_000
export const STORAGE_REMEASURE_AFTER_MS = 15 * 60_000
export const STORAGE_WALK_CONCURRENCY = 4

/** Directory names whose contents count as dependency or build output. */
export const BUILD_ROOT_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'target',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.output',
  '.svelte-kit',
  '__pycache__',
  '.gradle',
  'Pods',
  'DerivedData',
])

export type StorageWorktree = Readonly<{ id: string; root: string }>

type FileInfo = Readonly<{
  isDirectory: boolean
  isFile: boolean
  isSymbolicLink: boolean
  /** Device id, compared to refuse crossing mount points. */
  dev: number
  /** Allocated bytes on disk (falls back to the apparent size). */
  bytes: number
}>

export type StorageFs = Readonly<{
  lstat(path: string): Promise<FileInfo>
  readdir(path: string): Promise<readonly string[]>
}>

export const nodeStorageFs: StorageFs = {
  async lstat(path) {
    const info = await lstat(path)
    return {
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
      isSymbolicLink: info.isSymbolicLink(),
      dev: info.dev,
      bytes: typeof info.blocks === 'number' && info.blocks > 0 ? info.blocks * 512 : info.size,
    }
  },
  readdir: (path) => readdir(path),
}

type Walk = {
  pending: { path: string; build: boolean }[]
  sourceBytes: number
  buildBytes: number
  dev: number
}

type Entry = {
  record: WorktreeStorageRecord
  /** The last complete measurement, kept while a re-measure is under way. */
  completeAt?: number
  walk?: Walk
}

export type WorktreeStorageInput = Readonly<{
  worktrees: () => readonly StorageWorktree[]
  fs?: StorageFs
  now?: () => number
  budgetMs?: number
  remeasureAfterMs?: number
  concurrency?: number
}>

export type WorktreeStorage = Readonly<{
  /** Returns the current records and schedules any measurement they need. */
  list(worktreeId?: string): WorktreeStorageRecord[]
  /** Resolves when the walker is idle (tests and graceful shutdown). */
  idle(): Promise<void>
}>

export function createWorktreeStorage(input: WorktreeStorageInput): WorktreeStorage {
  const fs = input.fs ?? nodeStorageFs
  const now = input.now ?? Date.now
  const budgetMs = input.budgetMs ?? STORAGE_WALK_BUDGET_MS
  const remeasureAfterMs = input.remeasureAfterMs ?? STORAGE_REMEASURE_AFTER_MS
  const concurrency = Math.max(1, input.concurrency ?? STORAGE_WALK_CONCURRENCY)
  const entries = new Map<string, Entry>()
  const queue: StorageWorktree[] = []
  let running: Promise<void> | undefined

  function entryFor(id: string): Entry {
    let entry = entries.get(id)
    if (!entry) {
      entry = { record: { worktreeId: id, state: 'measuring' } }
      entries.set(id, entry)
    }
    return entry
  }

  function needsWork(entry: Entry): boolean {
    if (entry.walk) return true
    if (entry.record.state === 'unreadable') {
      return entry.completeAt === undefined || now() - entry.completeAt >= remeasureAfterMs
    }
    if (entry.completeAt === undefined) return true
    return now() - entry.completeAt >= remeasureAfterMs
  }

  async function step(worktree: StorageWorktree): Promise<void> {
    const entry = entryFor(worktree.id)
    if (!entry.walk) {
      let rootInfo: FileInfo
      try {
        rootInfo = await fs.lstat(worktree.root)
      } catch {
        rootInfo = { isDirectory: false, isFile: false, isSymbolicLink: false, dev: 0, bytes: 0 }
      }
      if (!rootInfo.isDirectory || rootInfo.isSymbolicLink) {
        entry.record = { worktreeId: worktree.id, state: 'unreadable' }
        entry.completeAt = now()
        return
      }
      entry.walk = {
        pending: [{ path: worktree.root, build: false }],
        sourceBytes: 0,
        buildBytes: 0,
        dev: rootInfo.dev,
      }
      if (entry.record.state !== 'measured' && entry.record.state !== 'stale') {
        entry.record = { worktreeId: worktree.id, state: 'measuring' }
      }
    }
    const walk = entry.walk
    const deadline = now() + budgetMs

    async function visit(directory: { path: string; build: boolean }): Promise<void> {
      let names: readonly string[]
      try {
        names = await fs.readdir(directory.path)
      } catch {
        return // An unreadable subdirectory contributes nothing; never zero-filled.
      }
      for (const name of names) {
        const path = join(directory.path, name)
        let info: FileInfo
        try {
          info = await fs.lstat(path)
        } catch {
          continue
        }
        if (info.isSymbolicLink) continue
        if (info.dev !== walk.dev) continue
        const build = directory.build || BUILD_ROOT_NAMES.has(name)
        if (info.isDirectory) {
          walk.pending.push({ path, build })
          continue
        }
        if (!info.isFile) continue
        if (build) walk.buildBytes += info.bytes
        else walk.sourceBytes += info.bytes
      }
    }

    while (walk.pending.length > 0) {
      if (now() >= deadline) {
        // Out of budget: keep the previous bytes, mark stale, resume later.
        const previous = entry.record
        entry.record = {
          worktreeId: worktree.id,
          state: 'stale',
          ...(previous.sourceBytes !== undefined ? { sourceBytes: previous.sourceBytes } : {}),
          ...(previous.buildBytes !== undefined ? { buildBytes: previous.buildBytes } : {}),
          ...(previous.measuredAt !== undefined ? { measuredAt: previous.measuredAt } : {}),
        }
        return
      }
      const batch = walk.pending.splice(-concurrency, concurrency)
      await Promise.all(batch.map(visit))
    }
    entry.walk = undefined
    entry.completeAt = now()
    entry.record = {
      worktreeId: worktree.id,
      state: 'measured',
      sourceBytes: String(walk.sourceBytes),
      buildBytes: String(walk.buildBytes),
      measuredAt: new Date(entry.completeAt).toISOString(),
    }
  }

  function drain(): void {
    if (running) return
    running = (async () => {
      while (queue.length > 0) {
        const worktree = queue.shift() as StorageWorktree
        try {
          await step(worktree)
        } catch {
          const entry = entryFor(worktree.id)
          entry.walk = undefined
          entry.completeAt = now()
          entry.record = { worktreeId: worktree.id, state: 'unreadable' }
        }
      }
    })().finally(() => {
      running = undefined
    })
  }

  return Object.freeze({
    list(worktreeId) {
      const worktrees = input
        .worktrees()
        .filter((worktree) => worktreeId === undefined || worktree.id === worktreeId)
      const known = new Set(worktrees.map((worktree) => worktree.id))
      for (const id of entries.keys())
        if (worktreeId === undefined && !known.has(id)) entries.delete(id)
      for (const worktree of worktrees) {
        const entry = entryFor(worktree.id)
        if (needsWork(entry) && !queue.some((queued) => queued.id === worktree.id)) {
          queue.push(worktree)
        }
      }
      if (queue.length > 0) drain()
      return worktrees.map((worktree) => entryFor(worktree.id).record)
    },
    idle: async () => {
      for (let current = running; current; current = running) await current
    },
  })
}
