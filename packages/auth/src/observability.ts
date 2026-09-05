const ALLOWED_FIELDS = new Set(['outcome', 'reason', 'requestId'])

export type AuthEventName =
  'session.lookup' | 'session.refresh' | 'session.revoke' | 'session.sign_in' | 'session.sign_out'

export function createAuthEvent(
  name: AuthEventName,
  metadata: Record<string, unknown>
): Readonly<Record<string, unknown>> {
  const event: Record<string, unknown> = { event: `auth.${name}` }
  for (const [key, value] of Object.entries(metadata)) {
    if (ALLOWED_FIELDS.has(key) && (typeof value === 'string' || typeof value === 'number')) {
      event[key] = value
    }
  }
  return Object.freeze(event)
}
