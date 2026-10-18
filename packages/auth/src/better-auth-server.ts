import 'server-only'

import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { applySetCookies, parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies'
import { Pool, type PoolConfig } from 'pg'

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
 * Cookie attributes a context can persist. It matches the shape the existing
 * app request-context adapters expose, so route code keeps passing the same
 * context.
 */
export type AuthCookieOptions = Readonly<{
  domain?: string
  expires?: Date
  httpOnly?: boolean
  maxAge?: number
  partitioned?: boolean
  path?: string
  sameSite?: 'lax' | 'none' | 'strict'
  secure?: boolean
}>

/**
 * The request view a caller must supply without importing a server framework.
 * `setCookie` is required: the auth service issues, renews, and clears session
 * cookies, and a context that silently drops them would leave a successful
 * sign-in with no session.
 */
export type AuthRequestContext = Readonly<{
  getCookies(): string
  getHeader(name: string): string | null | undefined
  getOrigin(): string
  setCookie(name: string, value: string, options: AuthCookieOptions): void
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
// stays decoupled from the inference. `returnHeaders: true` asks Better Auth to
// hand back the response `Set-Cookie` values so the context can persist them;
// endpoints that do not return headers simply yield their payload.
type BetterAuthCallResult<T> = T | { headers: Headers; response: T }

type RawBetterAuthApi = {
  getSession(input: {
    headers: Headers
    query?: { disableCookieCache?: boolean; disableRefresh?: boolean }
    returnHeaders: true
  }): Promise<BetterAuthCallResult<BetterAuthSessionPayload>>
  listSessions(input: { headers: Headers }): Promise<Array<{ id: string; token: string }>>
  revokeSession(input: {
    body: { token: string }
    headers: Headers
    returnHeaders: true
  }): Promise<BetterAuthCallResult<unknown>>
  signInEmail(input: {
    body: { email: string; password: string }
    headers: Headers
    returnHeaders: true
  }): Promise<BetterAuthCallResult<unknown>>
  signOut(input: { headers: Headers; returnHeaders: true }): Promise<BetterAuthCallResult<unknown>>
  signUpEmail(input: {
    body: { email: string; name: string; password: string }
    headers: Headers
    returnHeaders: true
  }): Promise<BetterAuthCallResult<unknown>>
}

function splitCallResult<T>(result: BetterAuthCallResult<T>): {
  headers: Headers | undefined
  data: T
} {
  if (result && typeof result === 'object' && 'headers' in result && 'response' in result) {
    const shaped = result as { headers?: Headers; response: T }
    return { headers: shaped.headers, data: shaped.response }
  }
  return { headers: undefined, data: result as T }
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
 * Persists whatever `Set-Cookie` values Better Auth returned into the request
 * context. Better Auth owns the cookie names, signing, and attributes; this
 * only routes them onto the framework response. It runs for every call, so a
 * session renewal or a cleared session cookie issued by a plain read, a
 * credential call, a revocation, or a sign-out all reach the browser.
 */
function persistResponseCookies(
  context: AuthRequestContext,
  responseHeaders: Headers | undefined
): void {
  const setCookies = responseHeaders?.getSetCookie?.() ?? []
  for (const raw of setCookies) {
    for (const [name, attributes] of parseSetCookieHeader(raw)) {
      const options = toCookieOptions(attributes)
      context.setCookie(name, attributes.value, {
        ...(options.domain !== undefined ? { domain: options.domain } : {}),
        ...(options.expires ? { expires: options.expires } : {}),
        ...(options.httpOnly !== undefined ? { httpOnly: options.httpOnly } : {}),
        ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
        ...(options.partitioned !== undefined ? { partitioned: options.partitioned } : {}),
        ...(options.path !== undefined ? { path: options.path } : {}),
        ...(options.sameSite !== undefined ? { sameSite: options.sameSite } : {}),
        ...(options.secure !== undefined ? { secure: options.secure } : {}),
      })
    }
  }
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

function createServerApi(auth: BetterAuthInstance, context: AuthRequestContext) {
  const api = auth.api as unknown as RawBetterAuthApi
  const requestHeaders = contextToHeaders(context)

  const readSession = async (
    sessionHeaders: Headers,
    options?: { disableCookieCache?: boolean; disableRefresh?: boolean }
  ): Promise<{ data: ProviderSessionInput | null; error: unknown }> => {
    try {
      const result = splitCallResult(
        await api.getSession({
          headers: sessionHeaders,
          returnHeaders: true,
          ...(options ? { query: options } : {}),
        })
      )
      persistResponseCookies(context, result.headers)
      return { data: result.data, error: null }
    } catch (error) {
      return { data: null, error }
    }
  }

  // A credential call reads its session back through the cookies it just
  // issued, never the request's incoming cookies. After sign-in the fresh
  // cookie names the new account; the pre-login cookie may still identify
  // whichever account (or none) the browser held before.
  const finishCredentialCall = (
    responseHeaders: Headers | undefined
  ): Promise<{ data: ProviderSessionInput | null; error: unknown }> => {
    persistResponseCookies(context, responseHeaders)
    return readSession(sessionCookieHeaders(responseHeaders ?? new Headers()))
  }

  return {
    getSession: (options?: Parameters<typeof readSession>[1]) =>
      readSession(requestHeaders, options),
    async listSessions(): Promise<{
      data: Array<{ id: string; token: string }> | null
      error: unknown
    }> {
      try {
        const sessions = await api.listSessions({ headers: requestHeaders })
        return { data: sessions.map(({ id, token }) => ({ id, token })), error: null }
      } catch (error) {
        return { data: null, error }
      }
    },
    async revokeSession(input: { token: string }): AuthResponse<unknown> {
      try {
        const result = splitCallResult(
          await api.revokeSession({
            body: { token: input.token },
            headers: requestHeaders,
            returnHeaders: true,
          })
        )
        persistResponseCookies(context, result.headers)
        return { data: result.data, error: null }
      } catch (error) {
        return { data: null, error }
      }
    },
    async signInEmail(credentials: { email: string; password: string }) {
      try {
        const result = splitCallResult(
          await api.signInEmail({ body: credentials, headers: requestHeaders, returnHeaders: true })
        )
        return finishCredentialCall(result.headers)
      } catch (error) {
        return { data: null, error }
      }
    },
    async signUpEmail(registration: { email: string; name: string; password: string }) {
      try {
        const result = splitCallResult(
          await api.signUpEmail({
            body: registration,
            headers: requestHeaders,
            returnHeaders: true,
          })
        )
        return finishCredentialCall(result.headers)
      } catch (error) {
        return { data: null, error }
      }
    },
    async signOut(): AuthResponse<unknown> {
      try {
        const result = splitCallResult(
          await api.signOut({ headers: requestHeaders, returnHeaders: true })
        )
        persistResponseCookies(context, result.headers)
        return { data: result.data, error: null }
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
  return createAuthAdapter(
    createBetterAuthDriver(
      createServerApi(auth, {
        getCookies: () => headers.get('cookie') ?? '',
        getHeader: (name) => headers.get(name),
        getOrigin: () => headers.get('origin') ?? '',
        // A caller that only hands over request headers has nowhere to put the
        // response cookies; the context adapter is the supported way to persist
        // them.
        setCookie: () => undefined,
      })
    ),
    {
      provider: 'better-auth',
    }
  )
}

export function createBetterAuthContextAdapter(
  auth: BetterAuthInstance,
  factory: AuthRequestContextFactory
): AuthAdapter {
  // Resolve the context per adapter call so each request reads and writes its
  // own cookies rather than capturing the first caller's context.
  const apiFor = async () => createServerApi(auth, await factory())
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

export type AuthDatabaseHandle = Readonly<{
  /** The value handed to Better Auth as its `database`. */
  database: NonNullable<BetterAuthOptions['database']>
  /** Releases the connection so the caller can let it die with the request. */
  close(): Promise<void>
}>

/**
 * Creates the PostgreSQL pool the built-in Better Auth Kysely adapter supports.
 * The pool stays auth-owned so it can be sized for auth traffic without
 * touching the application database pool, and the returned `close()` releases
 * its connections with the request instead of retaining a process-global pool.
 * The validated connection URL carries the TLS mode; node-postgres parses its
 * SSL options from that URL.
 */
export function createPostgresAuthDatabase(
  databaseUrl: string,
  options: PoolConfig = {}
): AuthDatabaseHandle {
  const client = new Pool({
    connectionString: databaseUrl,
    max: 1,
    ...options,
  })
  return {
    database: client,
    close: () => client.end(),
  }
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
