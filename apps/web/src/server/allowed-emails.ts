/**
 * Optional account allowlist. When ADEA_ALLOWED_EMAILS is set to a
 * comma-separated list, only sessions for those email addresses may resolve a
 * workspace principal and guest (temporary) sessions are disabled. Unset or
 * empty restores the default open behavior.
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
