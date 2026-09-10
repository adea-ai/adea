/**
 * No framework, cookies, or environment access here. Keep the existing entry
 * policy identical for the Next page and the staged Start gateway.
 * @param {{ configured: boolean, resolveEmail: () => Promise<string | null | undefined>, isAllowed: (email: string) => boolean }} options
 * @returns {Promise<'allowed' | 'sign-in' | 'denied'>}
 */
export async function evaluateEntryAccess({ configured, resolveEmail, isAllowed }) {
  if (!configured) return 'allowed'
  let email
  try {
    email = await resolveEmail()
  } catch {
    return 'sign-in'
  }
  if (!email) return 'sign-in'
  return isAllowed(email) ? 'allowed' : 'denied'
}
