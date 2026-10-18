import 'server-only'

import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { applySetCookies } from 'better-auth/cookies'
import postgres from 'postgres'

import { createAuthAdapter, type AuthAdapter } from './adapter'
import { createBetterAuthDriver } from './better-auth-driver'
import type { BetterAuthConfig } from './config'
import type { AuthDelivery } from './delivery'
import { assertTrustedOrigin } from './security'
import type { ProviderSessionInput } from './session'

/**
 * The structural view of a constructed Better Auth instance this package uses.
 * The concrete `Auth<Options>` type is invariant in its options, so callers
 * depend on this narrow shape instead of the full generic.
 */
export type BetterAuthInstance = Readonly<{
  api: unknown
  handler(request: Request): Promise<Response>
}>

/**
 * The cookie + origin view a caller can supply without importing a server
 * framework. It matches the shape the existing app request-context adapter
 * already exposes, so route code keeps passing the same context.
 */
export type AuthRequestContext = Readonly<{
  getCookies(): string
  getHeader(name: string): string | null | undefined
  getOrigin(): string
}>

export type AuthRequestContextFactory = () => Promise<AuthRequestContext> | AuthRequestContext

type AuthResponse<T> = Promise<{ data: T | null; error: unknown }>

type BetterAuthSessionPayload = {
  session: { expiresAt: Date | string; id: string; token?: string }
  user: {
    email?: string | null
    emailVerified?: boolean
    id: string
    name?: string | null
  }
} | null

// The real `auth.api` endpoint type is deeply inferred from the options passed
// to betterAuth(). This structural view records exactly the supported call
// shapes this module uses, so the composition stays readable and the driver
// stays decoupled from the inference.
type RawBetterAuthApi = {
  getSession(input: {
    headers: Headers
    query?: { disableCookieCache?: boolean; disableRefresh?: boolean }
  }): Promise<BetterAuthSessionPayload>
  listSessions(input: { headers: Headers }): Promise<Array<{ id: string; token: string }>>
  revokeSession(input: { body: { token: string }; headers: Headers }): Promise<unknown>
  signInEmail(input: {
    body: { email: string; password: string }
    headers: Headers
    returnHeaders: true
  }): Promise<{ headers: Headers; response: unknown }>
  signOut(input: { headers: Headers }): Promise<unknown>
  signUpEmail(input: {
    body: { email: string; name: string; password: string }
    headers: Headers
    returnHeaders: true
  }): Promise<{ headers: Headers; response: unknown }>
}

function contextToHeaders(context: AuthRequestContext): Headers {
  const headers = new Headers()
  const cookie = context.getCookies()
  if (cookie) headers.set('cookie', cookie)
  const origin = context.getOrigin()
  if (origin) headers.set('origin', origin)
  return headers
}

/**
 * Translates a credential call's `Set-Cookie` response headers into request
 * `Cookie` headers so the freshly issued session can be read back through the
 * same supported `getSession` endpoint. Better Auth owns the cookie names and
 * signing; nothing is reimplemented here.
 */
function sessionCookieHeaders(responseHeaders: Headers): Headers {
  const headers = new Headers()
  const setCookie = responseHeaders.getSetCookie?.() ?? []
  if (setCookie.length > 0) applySetCookies(headers, setCookie)
  return headers
}

function createServerApi(auth: BetterAuthInstance, headers: Headers) {
  const api = auth.api as unknown as RawBetterAuthApi

  const readSession = async (
    sessionHeaders: Headers,
    options?: { disableCookieCache?: boolean; disableRefresh?: boolean }
  ): Promise<{ data: ProviderSessionInput | null; error: unknown }> => {
    try {
      return {
        data: await api.getSession({
          headers: sessionHeaders,
          ...(options ? { query: options } : {}),
        }),
        error: null,
      }
    } catch (error) {
      return { data: null, error }
    }
  }

  const finishCredentialCall = (
    responseHeaders: Headers
  ): Promise<{ data: ProviderSessionInput | null; error: unknown }> =>
    readSession(sessionCookieHeaders(responseHeaders))

  return {
    getSession: (options?: Parameters<typeof readSession>[1]) => readSession(headers, options),
    async listSessions(): Promise<{
      data: Array<{ id: string; token: string }> | null
      error: unknown
    }> {
      try {
        const sessions = await api.listSessions({ headers })
        return { data: sessions.map(({ id, token }) => ({ id, token })), error: null }
      } catch (error) {
        return { data: null, error }
      }
    },
    async revokeSession(input: { token: string }): AuthResponse<unknown> {
      try {
        return {
          data: await api.revokeSession({ body: { token: input.token }, headers }),
          error: null,
        }
      } catch (error) {
        return { data: null, error }
      }
    },
    async signInEmail(credentials: { email: string; password: string }) {
      try {
        const result = await api.signInEmail({ body: credentials, headers, returnHeaders: true })
        return finishCredentialCall(result.headers)
      } catch (error) {
        return { data: null, error }
      }
    },
    async signUpEmail(registration: { email: string; name: string; password: string }) {
      try {
        const result = await api.signUpEmail({ body: registration, headers, returnHeaders: true })
        return finishCredentialCall(result.headers)
      } catch (error) {
        return { data: null, error }
      }
    },
    async signOut(): AuthResponse<unknown> {
      try {
        return { data: await api.signOut({ headers }), error: null }
      } catch (error) {
        return { data: null, error }
      }
    },
  }
}

export function createBetterAuthServerAdapter(
  auth: BetterAuthInstance,
  headers: Headers
): AuthAdapter {
  return createAuthAdapter(createBetterAuthDriver(createServerApi(auth, headers)), {
    provider: 'better-auth',
  })
}

export function createBetterAuthContextAdapter(
  auth: BetterAuthInstance,
  factory: AuthRequestContextFactory
): AuthAdapter {
  // Resolve the context per adapter call so each request reads its own cookies
  // rather than capturing the first caller's headers.
  const apiFor = async () => createServerApi(auth, contextToHeaders(await factory()))
  const driver = createBetterAuthDriver({
    getSession: async (options) => (await apiFor()).getSession(options),
    listSessions: async () => (await apiFor()).listSessions(),
    revokeSession: async (input) => (await apiFor()).revokeSession(input),
    signInEmail: async (credentials) => (await apiFor()).signInEmail(credentials),
    signUpEmail: async (registration) => (await apiFor()).signUpEmail(registration),
    signOut: async () => (await apiFor()).signOut(),
  })
  return createAuthAdapter(driver, { provider: 'better-auth' })
}

export type BetterAuthServerOptions = Readonly<{
  config: BetterAuthConfig
  database: NonNullable<BetterAuthOptions['database']>
  delivery: AuthDelivery
}>

/**
 * Builds the self-hosted Better Auth service for a fresh Railway PostgreSQL
 * instance. Email/password and (optional) Google OAuth are enabled; email
 * verification and password reset delegate to the injected, provider-neutral
 * delivery so no transport is baked in. CSRF and origin checking stay enabled
 * (Better Auth's defaults are not disabled) and secure HTTP-only cookies are
 * forced from configuration.
 */
export function createBetterAuthServer({
  config,
  database,
  delivery,
}: BetterAuthServerOptions): BetterAuthInstance {
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

  return betterAuth({
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
  }) as unknown as BetterAuthInstance
}

/**
 * Creates the PostgreSQL client the Better Auth Kysely adapter runs on. The
 * connection stays auth-owned so it can be sized for auth traffic without
 * touching the application database pool.
 */
export function createPostgresAuthDatabase(
  databaseUrl: string,
  options: Record<string, unknown> = {}
): ReturnType<typeof postgres> {
  return postgres(databaseUrl, {
    max: 1,
    ...options,
  } as Parameters<typeof postgres>[1])
}

type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

/**
 * Serves a Better Auth HTTP request through the same-origin proxy. State
 * changing requests and any request that supplies an Origin must match an exact
 * trusted origin before the handler runs; then Better Auth's own CSRF/origin
 * checks run as a second layer. Every auth response is marked no-store.
 */
export async function handleBetterAuthRequest(
  auth: BetterAuthInstance,
  method: RouteMethod,
  request: Request,
  config: BetterAuthConfig
): Promise<Response> {
  const origin = request.headers.get('origin') ?? undefined
  if (origin || method !== 'GET') {
    try {
      assertTrustedOrigin(origin, config.trustedOrigins)
    } catch {
      return withNoStore(Response.json({ error: 'Forbidden' }, { status: 403 }))
    }
  }

  return withNoStore(await auth.handler(request))
}

// Auth responses carry cookies and session data; they must never be cached by a
// browser, proxy, or CDN, including denial responses.
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'no-store')
  headers.set('pragma', 'no-cache')
  headers.set('expires', '0')
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}
