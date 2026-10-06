/*
 * The Dev sidebar's runtime reads (ADR 0011): worktree records, harness runs
 * and batched diff counts. Each binds only the generated metadata of the one
 * operation it issues, so the eager Dev shell never carries the registry-wide
 * command map. Every read fails closed: a refusal, a transport error, or a
 * reply that does not have the expected shape yields `undefined`, never a
 * guessed empty list, so the sidebar keeps what it last observed.
 */
import type { Scope } from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_harness_runs,
  devOperationMetadataFor_dev_worktree_diffSummary,
  devOperationMetadataFor_dev_worktree_list,
} from '@adea-ai/types/dev-runtime-operation-metadata'

import {
  buildDevCommandFromMetadata,
  type BoundDevOperationMetadata,
} from '../browser/command-core'
import type { DevRuntimeService } from '../platform'
import {
  DIFF_SUMMARY_BATCH_LIMIT,
  type DevNavRun,
  type DevNavWorktreeRecord,
} from './dev-nav-model'

/** Bounded paging: the sidebar never walks an unbounded list. */
const PAGE_LIMIT = 500
const MAX_PAGES = 4

type Execute = Pick<DevRuntimeService, 'execute'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readValue(
  runtime: Execute,
  metadata: BoundDevOperationMetadata,
  scope: Scope,
  body: Record<string, unknown>
): Promise<unknown> {
  try {
    const reply = await runtime.execute(buildDevCommandFromMetadata(metadata, { scope, body }))
    return reply.ok ? reply.value : undefined
  } catch {
    return undefined
  }
}

async function readPages(
  runtime: Execute,
  metadata: BoundDevOperationMetadata,
  scope: Scope,
  body: Record<string, unknown>
): Promise<unknown[] | undefined> {
  const items: unknown[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const value = await readValue(runtime, metadata, scope, {
      ...body,
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (!isRecord(value) || !Array.isArray(value.items)) return page === 0 ? undefined : items
    items.push(...value.items)
    const next = typeof value.nextCursor === 'string' ? value.nextCursor : undefined
    if (!next || seen.has(next)) break
    seen.add(next)
    cursor = next
  }
  return items
}

const worktreeKinds = new Set(['primary', 'managed', 'external'])

function worktreeRecord(value: unknown): DevNavWorktreeRecord | undefined {
  if (!isRecord(value)) return undefined
  const { id, projectId, kind } = value
  if (typeof id !== 'string' || typeof projectId !== 'string') return undefined
  if (typeof kind !== 'string' || !worktreeKinds.has(kind)) return undefined
  const text = (key: string) =>
    typeof value[key] === 'string' ? (value[key] as string) : undefined
  const integer = (key: string) =>
    Number.isSafeInteger(value[key]) ? (value[key] as number) : undefined
  const identity = value.rootIdentity
  const rootIdentity =
    isRecord(identity) && typeof identity.mtimeNs === 'string' && typeof identity.size === 'string'
      ? (identity as DevNavWorktreeRecord['rootIdentity'])
      : undefined
  const optional = {
    repoId: text('repoId'),
    branchRef: text('branchRef'),
    headRef: text('headRef'),
    title: text('title'),
    taskId: text('taskId'),
    canonicalRoot: text('canonicalRoot'),
    generation: integer('generation'),
    version: integer('version'),
    rootIdentity,
  }
  return {
    id,
    projectId,
    kind: kind as DevNavWorktreeRecord['kind'],
    archived: value.archived === true,
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
  }
}

/** Every live worktree record in the scope (`dev.worktree.list`), grouped later by project. */
export async function listDevWorktrees(
  runtime: Execute,
  scope: Scope
): Promise<DevNavWorktreeRecord[] | undefined> {
  const items = await readPages(runtime, devOperationMetadataFor_dev_worktree_list, scope, {
    archived: false,
  })
  if (!items) return undefined
  return items.flatMap((item) => worktreeRecord(item) ?? [])
}

const runStates = new Set([
  'resolving',
  'starting',
  'working',
  'awaiting_input',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'disconnected',
  'unknown',
])

/** The scope's harness runs (`dev.harness.runs`): only what leaf status reads. */
export async function listDevHarnessRuns(
  runtime: Execute,
  scope: Scope
): Promise<DevNavRun[] | undefined> {
  const items = await readPages(runtime, devOperationMetadataFor_dev_harness_runs, scope, {})
  if (!items) return undefined
  return items.flatMap((item) =>
    isRecord(item) &&
    typeof item.runtimeSessionId === 'string' &&
    typeof item.state === 'string' &&
    runStates.has(item.state)
      ? [{ runtimeSessionId: item.runtimeSessionId, state: item.state as DevNavRun['state'] }]
      : []
  )
}

/**
 * Diff counts for at most one batch of worktrees (`dev.worktree.diffSummary`,
 * ≤50 ids). Callers pass only the rows on screen; an empty batch issues no call.
 */
export async function readDevDiffSummaries(
  runtime: Execute,
  scope: Scope,
  worktreeIds: readonly string[]
): Promise<Map<string, { added: number; removed: number }> | undefined> {
  const ids = [...new Set(worktreeIds)].slice(0, DIFF_SUMMARY_BATCH_LIMIT)
  if (ids.length === 0) return new Map()
  const value = await readValue(runtime, devOperationMetadataFor_dev_worktree_diffSummary, scope, {
    worktreeIds: ids,
  })
  if (!Array.isArray(value)) return undefined
  const diffs = new Map<string, { added: number; removed: number }>()
  for (const item of value) {
    if (
      isRecord(item) &&
      typeof item.worktreeId === 'string' &&
      Number.isSafeInteger(item.added) &&
      Number.isSafeInteger(item.removed)
    )
      diffs.set(item.worktreeId, { added: item.added as number, removed: item.removed as number })
  }
  return diffs
}
