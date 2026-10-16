import type { ApiLeadTurnStatus } from '@adea-ai/api-client'
import { modelReadinessRemedy } from './lead-model-state'

const labels: Readonly<Record<ApiLeadTurnStatus['state'], string>> = {
  blocked: 'Setup blocked',
  prepared: 'Ready for review',
  dispatch_pending: 'Dispatch pending',
  starting: 'Starting',
  running: 'Running',
  awaiting_input: 'Waiting for input',
  cancelling: 'Cancellation requested',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
  unknown: 'Execution outcome unknown',
}

/** Execution observation and public answer delivery are separate facts. */
export function leadTurnPresentation(
  turn: ApiLeadTurnStatus | null,
  preparationCurrent: boolean,
  /** The last refused readiness check this view observed, kept until the next check. */
  lastRefusal?: string | null
) {
  if (!turn) return { label: 'Workspace lead', notice: null }
  const fresh = turn.reasonCode === 'MODEL_NOT_READY'
  const refusal = fresh
    ? turn.readinessReason
    : turn.state === 'blocked' &&
        !turn.reasonCode?.match(/^(REQUESTED_MODEL_MISMATCH|PUBLICATION_WITHHELD)$/)
      ? lastRefusal
      : undefined
  if (fresh || refusal) {
    // Remedies come from the bounded vocabulary; an unknown reason reads as "could not verify".
    const remedy =
      modelReadinessRemedy(refusal)?.message ??
      modelReadinessRemedy('READINESS_UNAVAILABLE')!.message
    return {
      label: labels[turn.state],
      notice: {
        kind: 'readiness',
        text: turn.dispatchId
          ? `Model authorization changed during this turn. ${remedy} Refresh lead status to see the recorded outcome; refreshing does not start another model call. Your saved message and draft are preserved.`
          : `Nothing ran and no other model was substituted. ${remedy} Then choose Review model and payer to check again. Your saved message, draft and lead customization are preserved.`,
      },
    }
  }
  if (turn.reasonCode === 'PUBLICATION_WITHHELD')
    return {
      label: labels[turn.state],
      notice: {
        kind: 'publication',
        text: 'Answer publication is withheld by current authorization. Refresh checks the existing outcome without starting another model call. Your saved message and draft are preserved.',
      },
    }
  if (turn.reasonCode === 'REQUESTED_MODEL_MISMATCH')
    return {
      label: labels[turn.state],
      notice: {
        kind: 'model',
        text: 'The model you chose could not be prepared, so nothing ran and no other model was substituted. Choose a model again or use the workspace default. Your saved message and draft are preserved.',
      },
    }
  if (turn.state === 'blocked')
    return {
      label: labels[turn.state],
      notice: {
        kind: 'setup',
        text: 'Lead setup is unavailable. Review model connections in workspace settings, then refresh. Your saved message, draft and lead customization are preserved.',
      },
    }
  if (turn.availability === 'unavailable')
    return {
      label: `Last reported: ${labels[turn.state]}`,
      notice: {
        kind: 'read',
        text: 'Current lead status is unavailable. The last reported state does not confirm a new runtime action or answer delivery. Refresh this existing turn; your saved message and draft are preserved.',
      },
    }
  return {
    label:
      turn.state === 'prepared' && !preparationCurrent ? 'Preparation expired' : labels[turn.state],
    notice: null,
  }
}
