/**
 * Optional account allowlist. When ADEA_ALLOWED_EMAILS is set to a
 * comma-separated list, only sessions for those email addresses may resolve a
 * workspace principal and guest (temporary) sessions are disabled. Unset or
 * empty restores the default open behavior.
 *
 * Applies to EVERY session kind, browser and desktop alike, and is checked at
 * RESOLVE time rather than only at issuance: a desktop session records the
 * provider email, so tightening this list stops already-issued device sessions
 * immediately. A session with no email on record is denied while the allowlist
 * is configured, so a record predating the email column cannot be a way past it.
 *
 * Read per call: on Workers the environment is request-scoped, and keeping the
 * read inside the functions makes dashboard edits take effect on the next
 * request without a redeploy.
 */
function rawAllowlist(): string[] {
  return (process.env.ADEA_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

export function emailAllowlistConfigured(): boolean {
  return rawAllowlist().length > 0
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!emailAllowlistConfigured()) return true
  if (!email) return false
  return rawAllowlist().includes(email.trim().toLowerCase())
}
