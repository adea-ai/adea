/**
 * Public, secret-free projection of model-selection/v1 readiness. Connector
 * credential metadata is not a model assessment. This module neither resolves
 * a model selection nor authorizes inference; admission must resolve and pin
 * the immutable upstream selection and recheck authority before execution.
 *
 * Kept server-side with no transport wiring until the Control Plane publishes
 * the corresponding versioned API schemas. Unknown/malformed assessments fail
 * closed and cannot expose upstream text, credential refs or secret material.
 */
export const MODEL_READINESS_REASON_CODES = Object.freeze([
  'READY',
  'CONNECTION_MISSING',
  'CONNECTION_REVOKED',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_EXPIRED',
  'CREDENTIAL_REVOKED',
  'CREDENTIAL_REVISION_CHANGED',
  'WORKSPACE_GRANT_EXPIRED',
  'WORKSPACE_GRANT_REVOKED',
  'QUOTA_EXHAUSTED',
  'INCOMPATIBLE_HARNESS',
  'INCOMPATIBLE_LOCATION',
  'AUTH_MODE_UNSUPPORTED',
  'PROVIDER_POLICY_DENIED',
  'MODEL_UNAVAILABLE',
  'SELECTION_CHANGED',
  'READINESS_UNAVAILABLE',
] as const)

export type ModelReadinessReasonCode = (typeof MODEL_READINESS_REASON_CODES)[number]
export type ModelReadinessRemedyAction =
  | 'choose_model_connection'
  | 'manage_credentials'
  | 'review_workspace_access'
  | 'review_provider_quota'
  | 'choose_compatible_target'
  | 'choose_supported_auth'
  | 'review_provider_policy'
  | 'choose_available_model'
  | 'refresh_selection'
  | 'retry_readiness'

export type ModelReadiness = Readonly<{
  ready: boolean
  reasonCode: ModelReadinessReasonCode
  remedy: Readonly<{ action: ModelReadinessRemedyAction; message: string }> | null
}>

const REMEDIES = {
  CONNECTION_MISSING: {
    action: 'choose_model_connection',
    message: 'Choose a model connection in workspace settings.',
  },
  CONNECTION_REVOKED: {
    action: 'choose_model_connection',
    message: 'Choose another model connection in workspace settings.',
  },
  CREDENTIAL_MISSING: credentialRemedy(),
  CREDENTIAL_EXPIRED: credentialRemedy(),
  CREDENTIAL_REVOKED: credentialRemedy(),
  CREDENTIAL_REVISION_CHANGED: {
    action: 'refresh_selection',
    message: 'Refresh the model selection to use the current credential revision.',
  },
  WORKSPACE_GRANT_EXPIRED: grantRemedy(),
  WORKSPACE_GRANT_REVOKED: grantRemedy(),
  QUOTA_EXHAUSTED: {
    action: 'review_provider_quota',
    message: 'Check the provider account quota or choose another model connection.',
  },
  INCOMPATIBLE_HARNESS: targetRemedy(),
  INCOMPATIBLE_LOCATION: targetRemedy(),
  AUTH_MODE_UNSUPPORTED: {
    action: 'choose_supported_auth',
    message: 'Choose a model connection with an authentication method supported by this runtime.',
  },
  PROVIDER_POLICY_DENIED: {
    action: 'review_provider_policy',
    message: 'Review workspace provider policy or choose an allowed model connection.',
  },
  MODEL_UNAVAILABLE: {
    action: 'choose_available_model',
    message: 'Choose an available model for this connection.',
  },
  SELECTION_CHANGED: {
    action: 'refresh_selection',
    message: 'Refresh the model selection before trying again.',
  },
  READINESS_UNAVAILABLE: {
    action: 'retry_readiness',
    message: 'Model readiness could not be verified. Try again.',
  },
} as const satisfies Record<Exclude<ModelReadinessReasonCode, 'READY'>, ModelReadiness['remedy']>

/** Accepts only the exact agreed readiness object; all other data is discarded. */
export function modelReadiness(value: unknown): ModelReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable()
  const assessment = value as Record<string, unknown>
  const keys = Object.keys(assessment)
  const reasonCode = assessment.reasonCode
  if (
    keys.length !== 2 ||
    !keys.includes('ready') ||
    !keys.includes('reasonCode') ||
    typeof assessment.ready !== 'boolean' ||
    typeof reasonCode !== 'string' ||
    !MODEL_READINESS_REASON_CODES.includes(reasonCode as ModelReadinessReasonCode) ||
    assessment.ready !== (reasonCode === 'READY')
  )
    return unavailable()
  if (reasonCode === 'READY') return { ready: true, reasonCode, remedy: null }
  const deniedReason = reasonCode as Exclude<ModelReadinessReasonCode, 'READY'>
  return { ready: false, reasonCode: deniedReason, remedy: { ...REMEDIES[deniedReason] } }
}

function unavailable(): ModelReadiness {
  return {
    ready: false,
    reasonCode: 'READINESS_UNAVAILABLE',
    remedy: { ...REMEDIES.READINESS_UNAVAILABLE },
  }
}

function credentialRemedy() {
  return {
    action: 'manage_credentials',
    message: 'Choose a model connection with a valid credential in workspace settings.',
  } as const
}

function grantRemedy() {
  return {
    action: 'review_workspace_access',
    message: 'Review model connection access for this workspace in settings.',
  } as const
}

function targetRemedy() {
  return {
    action: 'choose_compatible_target',
    message: 'Choose a model connection compatible with this runtime and location.',
  } as const
}
