import {
  MODEL_READINESS_REASON_CODES,
  type ModelReadinessReasonCode,
} from './model-selection-readiness'

export type LeadReadinessReason = Exclude<ModelReadinessReasonCode, 'READY'>

/** Bounded, secret-free reason a Control Plane readiness check refused a lead turn. */
export class LeadRuntimeRefusal extends Error {
  constructor(readonly readinessReason: LeadReadinessReason) {
    super('MODEL_NOT_READY')
    this.name = 'LeadRuntimeRefusal'
  }
}

/** Only the agreed readiness vocabulary crosses; any other text is discarded. */
export function leadReadinessReason(value: unknown): LeadReadinessReason | undefined {
  return typeof value === 'string' &&
    value !== 'READY' &&
    (MODEL_READINESS_REASON_CODES as readonly string[]).includes(value)
    ? (value as LeadReadinessReason)
    : undefined
}

/** CP's agreed lead refusal: `PI_LEAD_MODEL_NOT_READY` names its reason in `details.reasonCode`. */
export const LEAD_MODEL_NOT_READY_CODE = 'PI_LEAD_MODEL_NOT_READY'

/**
 * The bounded reason of a Control Plane client error, or undefined when it is not a readiness
 * refusal. Only a client-error or readiness status with a matching request ID counts. An older
 * SDK may not carry `details`, in which case the refusal is known but its reason is not.
 */
export function leadRefusalReason(
  error: { code?: unknown; status?: unknown; details?: unknown },
  requestMatches: boolean
): LeadReadinessReason | undefined {
  if (!requestMatches) return undefined
  const status = typeof error.status === 'number' ? error.status : 0
  if (error.code === LEAD_MODEL_NOT_READY_CODE && (status === 409 || status === 503)) {
    const details = error.details
    const reason =
      details && typeof details === 'object'
        ? leadReadinessReason((details as { reasonCode?: unknown }).reasonCode)
        : undefined
    return reason ?? 'READINESS_UNAVAILABLE'
  }
  return [400, 403, 404, 409, 422].includes(status) ? leadReadinessReason(error.code) : undefined
}
