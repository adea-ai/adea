/*
 * Shared worktree-context resolution for the Files/Source Control/editor
 * surfaces (#399). The registry (#398) owns project selection; until its
 * selection lands here, the surfaces resolve the live worktree through the
 * `dev.worktree.list` read model and refuse (typed state, no fabrication)
 * when no ready worktree exists.
 */
import type { Scope } from '@adea-ai/types/dev-runtime'

import { buildDevCommand } from '../browser/command'
import type { DevRuntimeService } from '../platform'

export type WorktreeContext = Readonly<{
  worktreeId: string
  generation: number
  rootIdentity: { device?: string; inode?: string; mtimeNs: string; size: string }
  branchLabel?: string
}>

type WorktreeListItem = {
  id: string
  generation: number
  lifecycle: string
  archived: boolean
  rootIdentity: WorktreeContext['rootIdentity']
  headRef?: string
}

type Page<T> = { items: readonly T[] }

/** Resolve the first ready, non-archived worktree on this runtime node. */
export async function resolveWorktreeContext(
  runtime: DevRuntimeService,
  scope: Scope
): Promise<WorktreeContext | undefined> {
  const reply = await runtime.execute(
    buildDevCommand({
      operation: 'dev.worktree.list',
      scope,
      body: { archived: false, limit: 50 },
    })
  )
  if (!reply.ok) return undefined
  const page = reply.value as Page<WorktreeListItem>
  const ready = (page.items ?? []).find((item) => item.lifecycle === 'ready' && !item.archived)
  if (!ready) return undefined
  return {
    worktreeId: ready.id,
    generation: ready.generation,
    rootIdentity: ready.rootIdentity,
    ...(ready.headRef !== undefined ? { branchLabel: ready.headRef } : {}),
  }
}

/** One-shot authenticated execute helper shared by the files/git panes. */
export async function executeOperation<T>(
  runtime: DevRuntimeService,
  scope: Scope,
  operation: Parameters<typeof buildDevCommand>[0]['operation'],
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): Promise<T> {
  const reply = await runtime.execute(
    buildDevCommand({ operation, scope, body, ...(resource ? { resource } : {}) })
  )
  if (!reply.ok) throw reply
  return reply.value as T
}
