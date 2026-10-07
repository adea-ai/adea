/** Fixed remediation; never render upstream error text. */
export function agentProfileActionNotice(error: unknown): string {
  const { code, status } =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; status?: unknown })
      : {}
  if (code === 'AGENT_PROFILE_CONFLICT' || code === 'AGENT_PROFILE_CHANGED')
    return 'Profile changed. Close, refresh and review the current version.'
  if (typeof code === 'string' && /^(?:AGENT_PROFILE_|PROFILE_)/u.test(code))
    return 'Profile unavailable or unapproved. Choose a published, compatible version.'
  if (status === 422 || status === 403) return 'Choose a permitted, compatible profile.'
  return 'Save unavailable. Check IDs; retry.'
}
