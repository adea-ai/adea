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
