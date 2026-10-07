import type { AgentProfileState } from '@adea-ai/types'

export function agentProfileStateNotice(state: AgentProfileState): string {
  if (state === 'available') return 'The selected profile version is configured.'
  if (state === 'unavailable')
    return 'Profile check unavailable. Refresh to retry; the selected version is unchanged.'
  return `This profile version is ${state}. Choose an approved, compatible version in Customize.`
}
