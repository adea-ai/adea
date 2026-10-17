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

/** CP's agreed lead refusal code; the reason is the SDK's bounded `reasonCode`. */
export const LEAD_MODEL_NOT_READY_CODE = 'PI_LEAD_MODEL_NOT_READY'

/**
 * The bounded reason of a Control Plane client error, or undefined when it is not a readiness
 * refusal. Only a matching request ID counts.
 *
 * Wire contract (CP #1159): HTTP 409 (class `conflict`, not retryable) `PI_LEAD_MODEL_NOT_READY`
 * for every reason except READINESS_UNAVAILABLE, which is a retryable 503 (class
 * `runtime_unavailable`) with the same code. The HTTP body carries the reason in
 * `error.details.reasonCode`; the SDK parses it into the closed `error.reasonCode` and drops the
 * rest. An SDK that predates the field leaves it unset, so the refusal is known but its reason is
 * not (READINESS_UNAVAILABLE). A 503 counts only as that exact envelope: any other 503 stays the
 * generic failure.
 */
export function leadRefusalReason(
  error: {
    code?: unknown
    status?: unknown
    retryable?: unknown
    errorClass?: unknown
    reasonCode?: unknown
  },
  requestMatches: boolean
): LeadReadinessReason | undefined {
  if (!requestMatches) return undefined
  const status = typeof error.status === 'number' ? error.status : 0
  if (error.code === LEAD_MODEL_NOT_READY_CODE) {
    // The SDK deliberately keeps only this closed field; raw `details` are never read.
    const reason = leadReadinessReason(error.reasonCode)
    if (status === 409)
      return error.retryable === false &&
        error.errorClass === 'conflict' &&
        reason !== 'READINESS_UNAVAILABLE'
        ? (reason ?? 'READINESS_UNAVAILABLE')
        : undefined
    if (
      status === 503 &&
      error.retryable === true &&
      error.errorClass === 'runtime_unavailable' &&
      (reason === undefined || reason === 'READINESS_UNAVAILABLE')
    )
      return 'READINESS_UNAVAILABLE'
    return undefined
  }
  return [400, 403, 404, 409, 422].includes(status) ? leadReadinessReason(error.code) : undefined
}
