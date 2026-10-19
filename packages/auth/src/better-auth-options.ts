import type { BetterAuthOptions } from 'better-auth'

import type { BetterAuthConfig } from './config'
import type { AuthDelivery } from './delivery'

/**
 * Inputs shared by the runtime Better Auth service and the explicit schema
 * initializer. The schema initializer must describe the same tables the
 * runtime expects, so both build their options here.
 */
export type BetterAuthOptionSources = Readonly<{
  config: BetterAuthConfig
  database: NonNullable<BetterAuthOptions['database']>
  delivery: AuthDelivery
}>

/**
 * The Better Auth options for the self-hosted service. Kept free of any
 * server-only import so the schema-initialization CLI can use the identical
 * options without the React Server export condition.
 *
 * Email/password and (optional) Google OAuth are enabled; email verification
 * and password reset delegate to the injected, provider-neutral delivery so no
 * transport is baked in. CSRF and origin checking stay enabled (Better Auth's
 * defaults are not disabled) and secure HTTP-only cookies are forced from
 * configuration.
 */
export function createBetterAuthOptions({
  config,
  database,
  delivery,
}: BetterAuthOptionSources): BetterAuthOptions {
  const sendVerificationEmail = async (data: {
    token: string
    url: string
    user: { email: string }
  }) => {
    await delivery.sendVerificationEmail({
      email: data.user.email,
      token: data.token,
      url: data.url,
    })
  }
  const sendResetPassword = async (data: {
    token: string
    url: string
    user: { email: string }
  }) => {
    await delivery.sendPasswordReset({
      email: data.user.email,
      token: data.token,
      url: data.url,
    })
  }

  return {
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
      },
      useSecureCookies: config.secureCookies,
    },
    baseURL: config.baseUrl,
    database,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: config.emailVerificationRequired,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword,
    },
    emailVerification: {
      autoSignInAfterVerification: true,
      sendOnSignUp: config.emailVerificationRequired,
      sendVerificationEmail,
    },
    ...(config.google
      ? {
          socialProviders: {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
            },
          },
        }
      : {}),
    secret: config.secret,
    session: {
      expiresIn: config.sessionExpiresInSeconds,
      updateAge: config.sessionUpdateAgeSeconds,
    },
    // Better Auth only understands HTTP(S) origins. The custom `adea://`
    // callback stays owned by the desktop broker and is validated separately.
    trustedOrigins: config.trustedOrigins.filter((origin) => origin.startsWith('http')),
  }
}
