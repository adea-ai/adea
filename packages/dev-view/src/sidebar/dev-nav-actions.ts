/*
 * The Dev sidebar's runtime mutations (ADR 0011). Loaded on first use, so the
 * eager Dev shell carries only the reads. Each action issues exactly one
 * registry operation with the worktree's resource binding where the registry
 * requires one, and reports a refusal as a message instead of throwing.
 */
import type { Scope } from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_files_openExternal,
  devOperationMetadataFor_dev_project_unbind,
  devOperationMetadataFor_dev_session_create,
  devOperationMetadataFor_dev_worktree_archive,
  devOperationMetadataFor_dev_worktree_cleanupCommit,
  devOperationMetadataFor_dev_worktree_cleanupPlan,
  devOperationMetadataFor_dev_worktree_create,
  devOperationMetadataFor_dev_worktree_rename,
} from '@adea-ai/types/dev-runtime-operation-metadata'

import {
  buildDevCommandFromMetadata,
  type BoundDevOperationMetadata,
  type DevCommandBuildFields,
} from '../browser/command-core'
import type { DevRuntimeService } from '../platform'
import type { DevNavWorktreeRecord } from './dev-nav-model'

export type DevNavActionResult<T = undefined> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>

type Execute = Pick<DevRuntimeService, 'execute'>

/** Every cleanup step a sidebar delete may plan; the host drops what does not apply. */
const CLEANUP_STEPS = [
  'stop_owned_resource',
  'run_teardown',
  'quarantine_worktree',
  'unregister_worktree',
  'delete_quarantine',
  'delete_branch',
  'prune_retained_data',
] as const

const cleanupStepLabels: Readonly<Record<string, string>> = {
  stop_owned_resource: 'Stop the processes this worktree owns',
  run_teardown: 'Run the project teardown',
  quarantine_worktree: 'Move the worktree folder to quarantine',
  unregister_worktree: 'Unregister the worktree from git',
  delete_quarantine: 'Delete the quarantined folder',
  delete_branch: 'Delete the worktree branch',
  prune_retained_data: 'Prune retained local data',
}

async function run<T>(
  runtime: Execute,
  metadata: BoundDevOperationMetadata,
  fields: DevCommandBuildFields
): Promise<DevNavActionResult<T>> {
  try {
    const reply = await runtime.execute(buildDevCommandFromMetadata(metadata, fields))
    if (reply.ok) return { ok: true, value: reply.value as T }
    return { ok: false, message: reply.error.message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'The runtime refused.' }
  }
}

function worktreeResource(record: DevNavWorktreeRecord, kind = 'worktree') {
  return { kind, id: record.id, generation: record.generation ?? 1 }
}

export function createWorktree(
  runtime: Execute,
  scope: Scope,
  input: Readonly<{ projectId: string; repoId: string; baseRef: string; branchName: string }>
): Promise<DevNavActionResult<unknown>> {
  return run(runtime, devOperationMetadataFor_dev_worktree_create, {
    scope,
    body: { ...input },
    idempotencyKey: crypto.randomUUID(),
  })
}

export function renameWorktree(
  runtime: Execute,
  scope: Scope,
  record: DevNavWorktreeRecord,
  title: string
): Promise<DevNavActionResult<unknown>> {
  return run(runtime, devOperationMetadataFor_dev_worktree_rename, {
    scope,
    body: { worktreeId: record.id, expectedVersion: record.version ?? 1, title },
    resource: worktreeResource(record),
  })
}

export function archiveWorktree(
  runtime: Execute,
  scope: Scope,
  record: DevNavWorktreeRecord
): Promise<DevNavActionResult<unknown>> {
  return run(runtime, devOperationMetadataFor_dev_worktree_archive, {
    scope,
    body: { worktreeId: record.id, expectedGeneration: record.generation ?? 1 },
    resource: worktreeResource(record),
  })
}

export type DevCleanupPlan = Readonly<{
  id: string
  digest: string
  /** What the commit will do, in order, as words. */
  steps: readonly string[]
  /** Why the plan cannot run yet; a blocked plan is never committed. */
  blockers: readonly string[]
}>

/** Plan deleting a worktree (`dev.worktree.cleanupPlan`); nothing changes yet. */
export async function planWorktreeCleanup(
  runtime: Execute,
  scope: Scope,
  record: DevNavWorktreeRecord
): Promise<DevNavActionResult<DevCleanupPlan>> {
  const result = await run<Record<string, unknown>>(
    runtime,
    devOperationMetadataFor_dev_worktree_cleanupPlan,
    {
      scope,
      body: {
        worktreeId: record.id,
        expectedGeneration: record.generation ?? 1,
        selectedOwnedResourceIds: [],
        allowedSteps: [...CLEANUP_STEPS],
      },
      resource: worktreeResource(record),
    }
  )
  if (!result.ok) return result
  const plan = result.value
  if (typeof plan?.id !== 'string' || typeof plan.digest !== 'string')
    return { ok: false, message: 'The runtime returned an unreadable cleanup plan.' }
  const steps = Array.isArray(plan.steps) ? plan.steps : []
  const blockers = Array.isArray(plan.blockers) ? plan.blockers : []
  return {
    ok: true,
    value: {
      id: plan.id,
      digest: plan.digest,
      steps: steps.map((step) => {
        const kind = (step as { kind?: unknown })?.kind
        return typeof kind === 'string' ? (cleanupStepLabels[kind] ?? kind) : 'Cleanup step'
      }),
      blockers: blockers.map((blocker) => {
        const message = (blocker as { message?: unknown })?.message
        return typeof message === 'string' ? message : 'Blocked'
      }),
    },
  }
}

/** Run a reviewed cleanup plan (`dev.worktree.cleanupCommit`). */
export function commitWorktreeCleanup(
  runtime: Execute,
  scope: Scope,
  record: DevNavWorktreeRecord,
  plan: DevCleanupPlan
): Promise<DevNavActionResult<unknown>> {
  return run(runtime, devOperationMetadataFor_dev_worktree_cleanupCommit, {
    scope,
    body: { planId: plan.id, planDigest: plan.digest },
    resource: worktreeResource(record),
  })
}

/** Reveal a worktree's root in the system file manager (`dev.files.openExternal`). */
export function openWorktreeExternally(
  runtime: Execute,
  scope: Scope,
  record: DevNavWorktreeRecord
): Promise<DevNavActionResult<unknown>> {
  if (!record.rootIdentity)
    return Promise.resolve({ ok: false, message: 'This worktree has no verified root yet.' })
  return run(runtime, devOperationMetadataFor_dev_files_openExternal, {
    scope,
    body: {
      worktreeId: record.id,
      path: { worktreeId: record.id, rootIdentity: record.rootIdentity, relativePath: '' },
      expectedIdentity: record.rootIdentity,
    },
    resource: worktreeResource(record, 'workspace_root'),
  })
}

/** Start a session on a worktree that has none (`dev.session.create`). */
export async function createSessionOn(
  runtime: Execute,
  scope: Scope,
  projectId: string,
  record: DevNavWorktreeRecord
): Promise<DevNavActionResult<string>> {
  if (!record.repoId)
    return { ok: false, message: 'This worktree is not linked to a registered repository.' }
  const result = await run<{ id?: unknown }>(runtime, devOperationMetadataFor_dev_session_create, {
    scope,
    body: { projectId, repoId: record.repoId, worktreeId: record.id },
    idempotencyKey: crypto.randomUUID(),
  })
  if (!result.ok) return result
  return typeof result.value?.id === 'string'
    ? { ok: true, value: result.value.id }
    : { ok: false, message: 'The runtime returned an unreadable session.' }
}

/** Remove a project's local binding (`dev.project.unbind`); files are never touched. */
export function unbindProject(
  runtime: Execute,
  scope: Scope,
  projectId: string,
  expectedVersion: number
): Promise<DevNavActionResult<unknown>> {
  return run(runtime, devOperationMetadataFor_dev_project_unbind, {
    scope,
    body: { projectId, expectedVersion },
    resource: { kind: 'project', id: projectId, generation: expectedVersion },
  })
}
