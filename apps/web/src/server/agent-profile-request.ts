import type { ApiAgentProfileInput } from '@adea-ai/api-client'
import { isRecord } from './control-plane-client'

const PROFILE = /^prf_[0-9A-HJKMNP-TV-Z]{26}$/u
const VERSION = /^pfv_[0-9A-HJKMNP-TV-Z]{26}$/u

export function isAgentProfilePin(
  input: unknown
): input is Record<string, unknown> & { profileId: string; profileVersion: string } {
  return (
    isRecord(input) &&
    typeof input.profileId === 'string' &&
    PROFILE.test(input.profileId) &&
    typeof input.profileVersion === 'string' &&
    VERSION.test(input.profileVersion)
  )
}

export function parseAgentProfileChange(input: unknown): ApiAgentProfileInput | null {
  if (
    !isRecord(input) ||
    !isAgentProfilePin(input) ||
    Object.keys(input).some(
      (key) => !['profileId', 'profileVersion', 'expectedRevision'].includes(key)
    ) ||
    typeof input.expectedRevision !== 'number' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    return null
  return {
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    expectedRevision: input.expectedRevision,
  }
}
