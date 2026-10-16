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
 * refusal. Only a matching request ID counts.
 *
 * Wire contract (CP #1159): HTTP 409 `PI_LEAD_MODEL_NOT_READY` with `details.reasonCode` for every
 * reason except READINESS_UNAVAILABLE, which is a retryable 503 with the same code. The SDK
 * surfaces the closed reason as `error.reasonCode`; an SDK that predates it drops `details`, so
 * the refusal is known but its reason is not (READINESS_UNAVAILABLE). A 503 counts only as that
 * exact envelope: any other 503 stays the generic failure.
 */
export function leadRefusalReason(
  error: {
    code?: unknown
    status?: unknown
    retryable?: unknown
    reasonCode?: unknown
    details?: unknown
  },
  requestMatches: boolean
): LeadReadinessReason | undefined {
  if (!requestMatches) return undefined
  const status = typeof error.status === 'number' ? error.status : 0
  if (error.code === LEAD_MODEL_NOT_READY_CODE) {
    const details = error.details
    const reason =
      leadReadinessReason(error.reasonCode) ??
      (details && typeof details === 'object'
        ? leadReadinessReason((details as { reasonCode?: unknown }).reasonCode)
        : undefined)
    if (status === 409) return reason ?? 'READINESS_UNAVAILABLE'
    if (
      status === 503 &&
      error.retryable === true &&
      (reason === undefined || reason === 'READINESS_UNAVAILABLE')
    )
      return 'READINESS_UNAVAILABLE'
    return undefined
  }
  return [400, 403, 404, 409, 422].includes(status) ? leadReadinessReason(error.code) : undefined
}
