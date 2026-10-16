import type {
  ApiModelChoice,
  ApiModelConnectionsResponse,
  ApiWorkspaceModelDefaults,
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
      choice: ApiModelChoice
      reasonCode: Exclude<ModelReadinessReasonCode, 'READY'>
      remedy: ModelReadinessRemedy
    }>
  /** No default and no choice: the harness's own model decides. This is not a fallback. */
  | Readonly<{ kind: 'harness_default' }>

export function resolveDirectSessionModel(input: {
  /** The model pinned on an already-created session, if any. Never replaced here. */
  existing?: ApiModelChoice | null
  explicit?: ApiModelChoice | null
  defaults: ApiWorkspaceModelDefaults | null | undefined
  connections: unknown
}): DirectSessionModel {
  if (input.existing) return { kind: 'existing', choice: input.existing }
  const source = input.explicit ? 'explicit' : 'workspace_default'
  const choice = input.explicit ?? input.defaults?.direct
  if (!choice) return { kind: 'harness_default' }
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
