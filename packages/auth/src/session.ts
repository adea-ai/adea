export type ProviderSessionInput = {
  session?: {
    expiresAt?: Date | string
    id?: string
  }
  user?: {
    email?: string | null
    emailVerified?: boolean
    id?: string
    name?: string | null
  }
}

/**
 * The provider name retained on a normalized identity. It is the value the
 * `AuthIdentity(provider, subject)` pair keys on, so a replacement provider
 * must choose its own name rather than reuse another provider's.
 */
export type AuthProviderName = string

export type AuthResult = Readonly<{
  identity: Readonly<{
    provider: AuthProviderName
    subject: string
  }>
  profile: Readonly<{
    displayName?: string
    email?: string
  }>
  session: Readonly<{
    expiresAt: string
    id: string
  }>
}>

export type NormalizeSessionOptions = Readonly<{
  now?: Date
  provider?: AuthProviderName
}>

/**
 * Normalizes any provider session payload into the provider-neutral result.
 * The provider label defaults to the historical Neon name so existing callers
 * keep their identity key; a replacement provider passes its own label.
 */
export function normalizeProviderSession(
  value: ProviderSessionInput | null | undefined,
  options: NormalizeSessionOptions = {}
): AuthResult | null {
  const provider = options.provider ?? 'neon'
  const now = options.now ?? new Date()
  if (!value) return null

  const sessionId = value.session?.id
  const subject = value.user?.id
  // Email is only surfaced once the provider has proven the mailbox. Callers use
  // `profile.email` for allowlists, invitations, and desktop-session authority,
  // so an unverified address must not reach them: a fresh signup that never
  // opened its verification link keeps its subject and display name but carries
  // no email.
  const verifiedEmail = value.user?.emailVerified === true ? value.user?.email : undefined
  const expiresAt = value.session?.expiresAt ? new Date(value.session.expiresAt) : undefined
  if (!sessionId || !subject || !expiresAt || Number.isNaN(expiresAt.valueOf())) {
    throw new Error('Authentication provider returned a malformed session')
  }
  if (expiresAt <= now) {
    throw new Error('Authentication provider session is expired')
  }

  return Object.freeze({
    identity: Object.freeze({ provider, subject }),
    session: Object.freeze({ expiresAt: expiresAt.toISOString(), id: sessionId }),
    profile: Object.freeze({
      ...(value.user?.name ? { displayName: value.user.name } : {}),
      ...(verifiedEmail ? { email: verifiedEmail } : {}),
    }),
  })
}

export function normalizeNeonSession(
  value: ProviderSessionInput | null | undefined,
  now = new Date()
): AuthResult | null {
  return normalizeProviderSession(value, { provider: 'neon', now })
}
