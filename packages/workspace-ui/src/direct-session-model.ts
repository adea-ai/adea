import type {
  ApiModelChoice,
  ApiModelConnectionsResponse,
  ApiModelDefaultsResponse,
} from '@adea-ai/api-client/model-connections'
import {
  modelReadinessRemedy,
  projectModelReadiness,
  projectSelectableModels,
  type ModelReadinessReasonCode,
  type ModelReadinessRemedy,
  type SelectableModel,
} from './lead-model-state'

/**
 * Initial model for a NEW direct session (#1211). The stored `direct` default only initializes
 * a session at creation; an existing session keeps the provider/model it was created with, and an
 * explicit per-session choice always wins. A chosen model that is unavailable or unauthorized
 * blocks the start with its recovery path: nothing substitutes another model, and a blocked
 * default never falls back to the harness's own model.
 *
 * `connections` is the listing for the direct session's own execution target. Readiness is a
 * projection only; Control Plane decides eligibility again when the session starts.
 */
export type DirectSessionModel =
  | Readonly<{ kind: 'existing'; choice: ApiModelChoice }>
  | Readonly<{ kind: 'explicit'; model: SelectableModel }>
  | Readonly<{ kind: 'workspace_default'; model: SelectableModel }>
  | Readonly<{
      kind: 'blocked'
      source: 'explicit' | 'workspace_default'
      /** Absent when the stored default itself could not be read. */
      choice?: ApiModelChoice
      reasonCode: Exclude<ModelReadinessReasonCode, 'READY'>
      remedy: ModelReadinessRemedy
    }>
  /**
   * The harness's own model decides, but only after a verified fact: the defaults were read and
   * name no direct model (`absent`), or this host reported model metadata inactive (`inactive`).
   * A missing, loading or failed read never reaches this state.
   */
  | Readonly<{ kind: 'harness_default'; verified: 'absent' | 'inactive' }>

export function resolveDirectSessionModel(input: {
  /** The model pinned on an already-created session, if any. Never replaced here. */
  existing?: ApiModelChoice | null
  explicit?: ApiModelChoice | null
  /** The defaults read; null or undefined means not read (loading or failed), never "none". */
  defaults: ApiModelDefaultsResponse | null | undefined
  connections: unknown
}): DirectSessionModel {
  if (input.existing) return { kind: 'existing', choice: input.existing }
  const source = input.explicit ? 'explicit' : 'workspace_default'
  let choice = input.explicit ?? undefined
  if (!choice) {
    const read = input.defaults
    if (!read || (read.availability !== 'available' && read.availability !== 'unavailable'))
      return unreadable()
    if (read.availability === 'unavailable')
      return { kind: 'harness_default', verified: 'inactive' }
    // Available with no stored record is verified absence; a malformed record is not.
    if (read.defaults === null) return { kind: 'harness_default', verified: 'absent' }
    if (typeof read.defaults !== 'object' || !Number.isSafeInteger(read.defaults.revision))
      return unreadable()
    choice = read.defaults.direct
    if (!choice) return { kind: 'harness_default', verified: 'absent' }
  }
  const model = projectSelectableModels(input.connections).find(
    (item) =>
      item.choice.connectionRef === choice.connectionRef &&
      item.choice.providerModel === choice.providerModel
  )
  if (model)
    return source === 'explicit'
      ? { kind: 'explicit', model }
      : { kind: 'workspace_default', model }
  const reasonCode = unreadyReason(input.connections, choice)
  return { kind: 'blocked', source, choice, reasonCode, remedy: modelReadinessRemedy(reasonCode)! }
}

function unreadable(): DirectSessionModel {
  return {
    kind: 'blocked',
    source: 'workspace_default',
    reasonCode: 'READINESS_UNAVAILABLE',
    remedy: modelReadinessRemedy('READINESS_UNAVAILABLE')!,
  }
}

/** The named reason when the listing says why; otherwise the choice is missing from it. */
function unreadyReason(
  connections: unknown,
  choice: ApiModelChoice
): Exclude<ModelReadinessReasonCode, 'READY'> {
  const listing = connections as Partial<ApiModelConnectionsResponse> | null
  if (!listing || listing.availability !== 'available' || !Array.isArray(listing.connections))
    return 'READINESS_UNAVAILABLE'
  const connection = listing.connections.find(
    (item) => item?.connectionRef === choice.connectionRef
  )
  if (!connection) return 'CONNECTION_MISSING'
  if (connection.status !== 'active') return 'CONNECTION_REVOKED'
  const models: readonly { providerModel?: string; readiness?: unknown }[] = Array.isArray(
    connection.models
  )
    ? connection.models
    : []
  const model = models.find((item) => item?.providerModel === choice.providerModel)
  if (!model) return 'MODEL_UNAVAILABLE'
  const readiness = projectModelReadiness(model.readiness)
  // A ready model that still failed the listing projection is malformed, so it is not verifiable.
  return readiness.reasonCode === 'READY' ? 'READINESS_UNAVAILABLE' : readiness.reasonCode
}

/** What the Dev chat host launches with; structurally the same as its `initialModel` result. */
export type DirectLaunchModel =
  | Readonly<{ kind: 'model'; modelId: string }>
  | Readonly<{ kind: 'harness_default' }>
  | Readonly<{ kind: 'blocked'; message: string }>

type ModelReads = Readonly<{
  getWorkspaceModelDefaults(workspaceId: string): Promise<ApiModelDefaultsResponse>
  listModelConnections(workspaceId: string): Promise<ApiModelConnectionsResponse>
}>

/**
 * Reads the workspace's stored direct default for a new session. Any failed read blocks: only a
 * successful read that names no direct model (or an inactive host) leaves the harness's own model.
 * The default's `providerModel` is sent as the launch `modelId`; the host rejects one it cannot
 * run, which is a visible refusal, never a substitute.
 */
export async function readDirectLaunchModel(
  client: ModelReads,
  workspaceId: string
): Promise<DirectLaunchModel> {
  const defaults = await client.getWorkspaceModelDefaults(workspaceId).catch(() => null)
  // The listing is only needed when a default names a model, so a workspace without one never reads it.
  const needsListing =
    defaults?.availability === 'available' && defaults.defaults?.direct !== undefined
  const connections = needsListing
    ? await client.listModelConnections(workspaceId).catch(() => null)
    : null
  const decision = resolveDirectSessionModel({ defaults, connections })
  switch (decision.kind) {
    case 'harness_default':
      return { kind: 'harness_default' }
    case 'workspace_default':
    case 'explicit':
      return { kind: 'model', modelId: decision.model.choice.providerModel }
    case 'existing':
      return { kind: 'model', modelId: decision.choice.providerModel }
    case 'blocked':
      return {
        kind: 'blocked',
        message: `The direct session did not start. ${
          decision.choice
            ? 'The workspace default model is not ready.'
            : 'The workspace default model could not be read.'
        } ${decision.remedy.message} No other model was substituted.`,
      }
  }
}
