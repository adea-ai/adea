/*
 * A project's default harness and model (project settings, desktop only).
 *
 * These are `HarnessPreference` records with a `projectId`: launch resolution
 * already reads an explicit project default before the workspace and device
 * defaults, so "Inherit" is simply the absence of a project record and a pick
 * is one stored record. Nothing here touches a session: a new session resolves
 * its harness when it launches, and a running one keeps the harness and model
 * it started with.
 *
 * Reads fail closed to an unavailable result (the dialog says so and offers no
 * picks); the model list comes from the installation the user picked, exactly
 * as the runtime reported it.
 */
import type {
  DevCommand,
  DevReply,
  HarnessModel,
  HarnessPreference,
  RuntimeConnectionInventoryEntry,
  Scope,
} from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_harness_inventory,
  devOperationMetadataFor_dev_harness_preferenceReset,
  devOperationMetadataFor_dev_harness_preferenceUpdate,
  devOperationMetadataFor_dev_harness_preferences,
} from '@adea-ai/types/dev-runtime-operation-metadata'

import {
  buildDevCommandFromMetadata,
  type BoundDevOperationMetadata,
} from '../browser/command-core'

type Execute = (command: DevCommand) => Promise<DevReply>

export type ProjectDefaultsHarness = Readonly<{
  installationId: string
  name: string
  models: readonly HarnessModel[]
}>

/** The project's own default, absent while the project inherits. */
export type ProjectDefaultsSelection = Readonly<{
  installationId: string
  modelId?: string
}>

export type ProjectDefaults = Readonly<{
  harnesses: readonly ProjectDefaultsHarness[]
  /** The stored project-level default; undefined means Inherit. */
  current?: ProjectDefaultsSelection & Readonly<{ version: number }>
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function run(
  execute: Execute,
  metadata: BoundDevOperationMetadata,
  scope: Scope,
  body: Record<string, unknown>
): Promise<DevReply | undefined> {
  try {
    return await execute(buildDevCommandFromMetadata(metadata, { scope, body }))
  } catch {
    return undefined
  }
}

function harnessRows(value: unknown): ProjectDefaultsHarness[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return (value.items as readonly RuntimeConnectionInventoryEntry[])
    .filter((entry) => entry.eligibility?.eligible !== false)
    .map((entry) => ({
      installationId: entry.id,
      name: entry.displayName,
      models: entry.models ?? [],
    }))
}

/** The harnesses the runtime reports and the project's stored default; undefined when unreadable. */
export async function readProjectDefaults(
  execute: Execute,
  scope: Scope,
  projectId: string
): Promise<ProjectDefaults | undefined> {
  const [inventory, preferences] = await Promise.all([
    run(execute, devOperationMetadataFor_dev_harness_inventory, scope, {}),
    run(execute, devOperationMetadataFor_dev_harness_preferences, scope, { projectId }),
  ])
  if (!inventory?.ok || !preferences?.ok) return undefined
  const page = preferences.value
  const stored = isRecord(page) && Array.isArray(page.items) ? page.items : []
  const own = (stored as readonly HarnessPreference[]).find(
    (preference) =>
      preference.projectId === projectId && preference.default && preference.rootDefault !== true
  )
  return {
    harnesses: harnessRows(inventory.value),
    ...(own
      ? {
          current: {
            installationId: own.harnessInstallationId,
            ...(own.modelId ? { modelId: own.modelId } : {}),
            version: own.version,
          },
        }
      : {}),
  }
}

function failureOf(reply: DevReply | undefined, fallback: string): string | undefined {
  if (!reply) return fallback
  return reply.ok ? undefined : reply.error.message || fallback
}

/** Whether a selection differs from what is stored, so an untouched form writes nothing. */
export function sameProjectDefault(
  current: ProjectDefaults['current'],
  next: ProjectDefaultsSelection | undefined
): boolean {
  if (!current || !next) return !current && !next
  return current.installationId === next.installationId && current.modelId === next.modelId
}

/**
 * Store the picked default, or clear it (Inherit). Resolves to a failure
 * message, or undefined on success. Clearing the model alone is a reset
 * followed by the harness pick again, because a stored record's model can only
 * be unset by resetting the record.
 */
export async function saveProjectDefaults(
  execute: Execute,
  scope: Scope,
  projectId: string,
  previous: ProjectDefaults['current'],
  next: ProjectDefaultsSelection | undefined
): Promise<string | undefined> {
  if (sameProjectDefault(previous, next)) return undefined
  const fallback = 'The default harness could not be saved.'
  const needsReset = previous && (!next || (previous.modelId && !next.modelId))
  if (needsReset) {
    const reset = await run(execute, devOperationMetadataFor_dev_harness_preferenceReset, scope, {
      projectId,
    })
    const failure = failureOf(reset, fallback)
    if (failure) return failure
  }
  if (!next) return undefined
  const base = needsReset ? 0 : (previous?.version ?? 0)
  const update = (expectedVersion: number) =>
    run(execute, devOperationMetadataFor_dev_harness_preferenceUpdate, scope, {
      installationId: next.installationId,
      projectId,
      expectedVersion,
      patch: { default: true, ...(next.modelId ? { modelId: next.modelId } : {}) },
    })
  let reply = await update(base)
  // One retry at the version a stale refusal reports, like every other fenced write.
  if (reply && !reply.ok && reply.error.code === 'stale_version') {
    const current = reply.error.currentVersion
    if (current !== undefined) reply = await update(current)
  }
  return failureOf(reply, fallback)
}
