// The Railway R3 fresh-account desktop principal lifecycle.
//
// This phase proves, against a real disposable PostgreSQL instance and the
// real self-hosted Better Auth provider, that:
//
//   - a provider identity (better-auth, subject = the provider user id) maps to
//     exactly one application user;
//   - repeated and concurrent provisioning of that identity is idempotent;
//   - a second fresh identity stays a separate application user;
//   - the desktop PKCE authorization exchange persists the mapped identity;
//   - a refresh invalidates the predecessor credential and a logout revokes the
//     persisted credential.
//
// Every step uses the production composition: the provider request path
// (`handleBetterAuthRequest`, `createBetterAuthServerAdapter`), the production
// principal resolution (`resolveOrProvisionDesktopPrincipal`), the production
// database identity functions, and the production desktop code and session
// brokers over the production PostgreSQL stores. Nothing here mocks an identity
// mapping, and no identity state is kept in memory: the application users, the
// authorization codes and the desktop sessions are all rows in the disposable
// database.
//
// The caller owns the scratch database, the applied migrations, the provider
// schema and the runtime connection. This phase closes none of them, and it
// never logs a password, a token, a code or a credential.
//
// The built-Worker route registration of this path is a later dependency: the
// route handlers in `apps/web/src/start/routes/api/auth/desktop/*` bind the
// framework request scope and, for the authorize route, the hosted provider
// adapter. This phase exercises the request path the exchange route composes,
// not the Worker that registers it.

import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  createBetterAuthServerAdapter,
  handleBetterAuthRequest,
} from '../../packages/auth/src/better-auth-server'
import {
  createDesktopAuthorizationCodeBroker,
  createDesktopSessionService,
} from '../../packages/auth/src/desktop-server'
import { parseDesktopExchangeRequest } from '../../packages/auth/src/desktop-http-server'
import { resolveOrProvisionDesktopPrincipal } from '../../apps/web/src/server/desktop-principal'
import { desktopTrustedOrigins } from '../../apps/web/src/server/desktop-workspace'
import {
  createUserWithAuthIdentity,
  findUserPrincipalsByAuthIdentity,
  getUserDisplayName,
  revokeAuthIdentity,
  setUserDisplayNameIfMissing,
} from '../../packages/db/src/identity'
import {
  consumeDesktopAuthorizationCode,
  createDesktopSessionRecord,
  resolveDesktopSessionRecord,
  revokeDesktopSessionRecord,
  rotateDesktopSessionRecord,
  saveDesktopAuthorizationCode,
} from '../../packages/db/src/desktop-auth'
import { desktopSessions } from '../../packages/db/src/schema/desktop-auth'
import { createDatabase } from '../../packages/db/src/connection'
import type { createRecordingAuthDelivery } from '../../packages/auth/src/delivery'
import type { createBetterAuthService } from '../../packages/auth/src/server'
import type { AuthResult } from '../../packages/auth/src/session'

type ProviderSql = ReturnType<
  typeof import('../../packages/db/src/connection').createDatabase
>['client']

/** The provider this phase drives. */
const PROVIDER = 'better-auth'

/** The desktop redirect the authorization code and the exchange use. */
const REDIRECT_URI = 'adea://auth/callback'

/** What the phase needs. The caller owns all of it. */
export type DesktopPrincipalLifecycleInput = {
  /** The self-hosted auth service. The caller closes its connection. */
  readonly service: ReturnType<typeof createBetterAuthService>
  /** The recording verification delivery. The caller owns it. */
  readonly recorder: ReturnType<typeof createRecordingAuthDelivery>
  /**
   * The runtime-role URL of the application database. The phase opens this
   * connection and closes it again, so the caller owns only the runtime
   * connection of the auth service.
   */
  readonly applicationDatabaseUrl: string
  /** The provider schema client, reached with the runtime role. */
  readonly providerSql: ProviderSql
  /** The provider schema the auth tables live in. */
  readonly providerSchema: string
}

/** The receipt the phase returns. It carries no credential and no address. */
export type DesktopPrincipalLifecycleReceipt = {
  readonly status: 'passed'
  readonly provider: typeof PROVIDER
  /** The measured provider accounts this phase created. */
  readonly accounts: number
  /** The measured application users this phase created. */
  readonly mappedUsers: number
  /** The measured application users that carry no provider identity. */
  readonly orphanUsers: number
  readonly desktopSessions: number
  readonly exchanges: number
  readonly refused: {
    readonly origin: number
    readonly pkce: number
    readonly replay: number
  }
}

/**
 * How many provider accounts, application users and orphan application users
 * exist at one point of the phase.
 */
export type IdentityMeasurements = {
  readonly applicationUsers: number
  readonly orphanUsers: number
  readonly providerAccounts: number
}

/**
 * The measured difference between two points of the phase.
 *
 * The counts are always derived from the database, never assumed. A losing
 * concurrent insert that left an application user behind would show up as an
 * orphan user, and a provisioned identity that never reached a user would show
 * up as a missing mapping.
 */
export function deriveIdentityDeltas(
  before: IdentityMeasurements,
  after: IdentityMeasurements
): IdentityMeasurements {
  return {
    applicationUsers: after.applicationUsers - before.applicationUsers,
    orphanUsers: after.orphanUsers - before.orphanUsers,
    providerAccounts: after.providerAccounts - before.providerAccounts,
  }
}

/**
 * Checks the measured deltas against the identities the phase created.
 *
 * One fresh account and one application user per identity are required, and no
 * orphan user may survive: a concurrent provisioning loser that left a user
 * behind would raise the application user count without raising the mapping
 * count, and that is a failure, not a pass.
 */
export function assertIdentityMeasurements(
  measured: IdentityMeasurements,
  expected: Readonly<{ identities: number }>
): void {
  // The orphan check comes first: an orphan user is the specific evidence that
  // a concurrent insert lost its race and left a user behind, and it is the
  // reason the user count can exceed the identity count.
  if (measured.orphanUsers !== 0) {
    throw new Error(
      `the phase left ${measured.orphanUsers} application users without a provider identity`
    )
  }
  if (measured.providerAccounts !== expected.identities) {
    throw new Error(
      `the phase created ${measured.providerAccounts} provider accounts, expected ${expected.identities}`
    )
  }
  if (measured.applicationUsers !== expected.identities) {
    throw new Error(
      `the phase created ${measured.applicationUsers} application users, expected ${expected.identities}`
    )
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function randomBase64url(size: number): string {
  return base64url(randomBytes(size))
}

/** The S256 PKCE challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
}

/**
 * Runs the desktop principal lifecycle against the real provider and the real
 * database. Throws on the first failed expectation; the caller owns the
 * cleanup of everything it provisioned.
 */
export async function runDesktopPrincipalLifecycle(
  input: DesktopPrincipalLifecycleInput
): Promise<DesktopPrincipalLifecycleReceipt> {
  const { providerSql, recorder, service } = input
  const origin = new URL(service.config.baseUrl).origin
  const trustedOrigins = desktopTrustedOrigins()

  assert.equal(service.config.emailVerificationRequired, true)
  assert.ok(service.config.trustedOrigins.includes(origin), 'the fixture origin must be trusted')

  const application = createDatabase(input.applicationDatabaseUrl)
  const database = application.db
  try {
    /** The production principal composition, over the production database. */
    const mapping = {
      findUserPrincipals: (identity: Readonly<{ provider: string; subject: string }>) =>
        findUserPrincipalsByAuthIdentity(database, identity),
      provision: (provisionInput: Parameters<typeof createUserWithAuthIdentity>[1]) =>
        createUserWithAuthIdentity(database, provisionInput),
      setDisplayNameIfMissing: (display: Readonly<{ displayName: string; userId: string }>) =>
        setUserDisplayNameIfMissing(database, display),
    }

    /** The production desktop stores, over the production database. */
    const codeStore = {
      consume: (codeDigest: string) => consumeDesktopAuthorizationCode(database, codeDigest),
      save: (record: Parameters<typeof saveDesktopAuthorizationCode>[1]) =>
        saveDesktopAuthorizationCode(database, record),
    }
    const sessionStore = {
      create: (record: Parameters<typeof createDesktopSessionRecord>[1]) =>
        createDesktopSessionRecord(database, record),
      revoke: (input_: Parameters<typeof revokeDesktopSessionRecord>[1]) =>
        revokeDesktopSessionRecord(database, input_),
      resolve: (input_: Parameters<typeof resolveDesktopSessionRecord>[1]) =>
        resolveDesktopSessionRecord(database, input_),
      rotate: (input_: Parameters<typeof rotateDesktopSessionRecord>[1]) =>
        rotateDesktopSessionRecord(database, input_),
    }
    const sessions = createDesktopSessionService({ store: sessionStore })
    const broker = createDesktopAuthorizationCodeBroker({
      issueSession: sessions.issue,
      store: codeStore,
    })

    /** The number of live application users the production join resolves. */
    const identityRows = async (identity: Readonly<{ provider: string; subject: string }>) =>
      (await findUserPrincipalsByAuthIdentity(database, identity)).length

    /** The persisted desktop session rows, read through the production schema. */
    const desktopSessionRows = async (): Promise<
      ReadonlyArray<{
        credentialDigest: string
        providerSessionId: string
        revokedAt: Date | null
        sessionId: string
        userId: string
      }>
    > => {
      const rows = await database
        .select({
          credentialDigest: desktopSessions.credentialDigest,
          providerSessionId: desktopSessions.providerSessionId,
          revokedAt: desktopSessions.revokedAt,
          sessionId: desktopSessions.sessionId,
          userId: desktopSessions.userId,
        })
        .from(desktopSessions)
      return rows
    }

    async function providerRequest(
      path: string,
      body?: Record<string, unknown>,
      cookie = '',
      requestOrigin: string | null = origin
    ): Promise<Response> {
      const headers = new Headers()
      if (requestOrigin !== null) headers.set('origin', requestOrigin)
      if (cookie) headers.set('cookie', cookie)
      if (body !== undefined) headers.set('content-type', 'application/json')
      const response = await handleBetterAuthRequest(
        service.auth,
        body === undefined ? 'GET' : 'POST',
        new Request(`${origin}/api/auth${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        service.config
      )
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('pragma'), 'no-cache')
      assert.equal(response.headers.get('expires'), '0')
      return response
    }

    async function providerUserId(email: string): Promise<string> {
      const rows = await providerSql<{ id: string }[]>`
        SELECT id FROM ${providerSql(`${input.providerSchema}.user`)} WHERE email = ${email}
      `
      assert.equal(rows.length, 1, 'the provider must hold exactly one user for the address')
      return rows[0]!.id
    }

    /**
     * The measured provider accounts, application users and orphan application
     * users. An orphan is a user that carries no provider identity row at all,
     * which is what a losing concurrent insert would leave behind.
     */
    const measureIdentities = async (): Promise<IdentityMeasurements> => {
      const provider = await providerSql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ${providerSql(`${input.providerSchema}.user`)}
      `
      const applicationUsers = await application.client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.users
      `
      const orphanUsers = await application.client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.users u
        WHERE NOT EXISTS (SELECT 1 FROM app.auth_identities i WHERE i.user_id = u.id)
      `
      return {
        applicationUsers: Number(applicationUsers[0]?.count ?? 0),
        orphanUsers: Number(orphanUsers[0]?.count ?? 0),
        providerAccounts: Number(provider[0]?.count ?? 0),
      }
    }

    /** Creates a fresh account and signs it in through the provider request path. */
    async function freshAccount(): Promise<{ authentication: AuthResult; email: string }> {
      const email = `r3-desktop-${randomUUID()}@example.test`
      const password = 'synthetic r3 desktop acceptance password'
      const before = recorder.sent.length
      const signup = await providerRequest('/sign-up/email', {
        email,
        name: 'R3 Desktop Operator',
        password,
      })
      assert.equal(signup.status, 200)
      assert.equal(cookies(signup), '', 'a fresh account must not receive a session')
      assert.equal(recorder.sent.length, before + 1, 'verification must be requested exactly once')
      const verification = recorder.sent.at(-1)!
      assert.equal(verification.kind, 'verification')
      assert.equal(verification.email, email)
      assert.ok(verification.token.length > 0)

      const verified = await providerRequest(
        `/verify-email?token=${encodeURIComponent(verification.token)}`
      )
      assert.equal(verified.status, 200)
      const cookie = cookies(verified)
      assert.ok(cookie.length > 0, 'a verified account must receive a session cookie')

      const authentication = await createBetterAuthServerAdapter(
        service.auth,
        new Headers({ cookie, origin })
      ).getSession()
      assert.ok(authentication, 'the verified account must have a provider session')
      assert.equal(authentication.identity.provider, PROVIDER)
      assert.equal(authentication.profile.email, email)
      assert.equal(
        authentication.identity.subject,
        await providerUserId(email),
        'the provider subject must be the provider user id'
      )
      return { authentication, email }
    }

    // --- one provider identity maps to one application user -------------------
    // The baseline is measured, so the deltas below are observed and never
    // assumed.
    const baseline = await measureIdentities()
    const first = await freshAccount()
    const principal = await resolveOrProvisionDesktopPrincipal(first.authentication, mapping)
    assert.ok(principal, 'a fresh provider identity must resolve to an application user')
    assert.equal(principal.kind, 'user')

    const resolved = await findUserPrincipalsByAuthIdentity(database, first.authentication.identity)
    assert.equal(resolved.length, 1, 'the provider identity must map to exactly one user')
    assert.equal(resolved[0]!.userId, principal.userId)
    assert.equal(
      await identityRows(first.authentication.identity),
      1,
      'the provider identity must be persisted once'
    )
    assert.equal(
      await getUserDisplayName(database, principal),
      'R3 Desktop Operator',
      'the provisioned user must carry the provider display name'
    )

    // --- repeated and concurrent provisioning are idempotent ----------------
    const repeated = await resolveOrProvisionDesktopPrincipal(first.authentication, mapping)
    assert.equal(repeated?.userId, principal.userId, 'repeated provisioning must be idempotent')
    assert.equal(
      (await findUserPrincipalsByAuthIdentity(database, first.authentication.identity)).length,
      1,
      'repeated provisioning must not create a second mapping'
    )

    const concurrentAccount = await freshAccount()
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        resolveOrProvisionDesktopPrincipal(concurrentAccount.authentication, mapping)
      )
    )
    assert.ok(concurrent[0], 'concurrent provisioning must resolve a user')
    const concurrentUsers = new Set(concurrent.map((entry) => entry?.userId))
    assert.equal(concurrentUsers.size, 1, 'concurrent provisioning must converge on one user')
    assert.equal(
      (await findUserPrincipalsByAuthIdentity(database, concurrentAccount.authentication.identity))
        .length,
      1,
      'concurrent provisioning must persist one mapping'
    )
    assert.equal(
      await identityRows(concurrentAccount.authentication.identity),
      1,
      'a failed concurrent insert must not leave a second mapping behind'
    )

    // --- a second fresh identity stays separate ------------------------------
    const second = await freshAccount()
    assert.notEqual(
      second.authentication.identity.subject,
      first.authentication.identity.subject,
      'two fresh accounts must be different provider identities'
    )
    const secondPrincipal = await resolveOrProvisionDesktopPrincipal(second.authentication, mapping)
    assert.ok(secondPrincipal)
    assert.notEqual(
      secondPrincipal.userId,
      principal.userId,
      'a second fresh identity must be a separate application user'
    )

    // --- the three identities are distinct, and nothing was orphaned ---------
    const subjects = new Set([
      first.authentication.identity.subject,
      concurrentAccount.authentication.identity.subject,
      second.authentication.identity.subject,
    ])
    assert.equal(subjects.size, 3, 'the phase must create three distinct provider identities')
    const concurrentUser = concurrent[0]!
    assert.notEqual(
      concurrentUser.userId,
      principal.userId,
      'the concurrent identity must be a separate application user'
    )
    assert.notEqual(
      concurrentUser.userId,
      secondPrincipal.userId,
      'the concurrent identity must not share the second application user'
    )

    // The measured deltas. A concurrent provisioning loser that left an
    // application user behind would raise the user count without raising the
    // mapping count, and that is a failure rather than a pass.
    const measured = deriveIdentityDeltas(baseline, await measureIdentities())
    assertIdentityMeasurements(measured, { identities: 3 })

    // --- the desktop PKCE exchange persists the mapped identity --------------
    const verifier = randomBase64url(32)
    const challenge = pkceChallenge(verifier)
    const nonce = randomBase64url(24)
    const state = randomBase64url(24)
    const issue = async () => {
      const callback = await broker.issue({
        codeChallenge: challenge,
        email: first.authentication.profile.email ?? null,
        nonce,
        providerExpiresAt: Date.parse(first.authentication.session.expiresAt),
        providerSessionId: first.authentication.session.id,
        redirectUri: REDIRECT_URI,
        state,
        userId: principal.userId,
      })
      const issued = new URL(callback).searchParams.get('code')
      assert.ok(issued, 'the authorization broker must issue a code')
      return issued
    }
    const code = await issue()

    const desktopOrigin = trustedOrigins[0]!
    const exchangeRequest = (body: Record<string, unknown>, requestOrigin = desktopOrigin) =>
      new Request(`${origin}/api/auth/desktop/exchange`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: requestOrigin,
        },
        body: JSON.stringify(body),
      })

    const exchangeBody = {
      code,
      codeVerifier: verifier,
      nonce,
      redirectUri: REDIRECT_URI,
    }
    const exchange = await parseDesktopExchangeRequest(
      exchangeRequest(exchangeBody),
      trustedOrigins
    )
    const desktopSession = await broker.exchange(exchange)
    assert.ok(desktopSession.credential.length > 0)
    assert.ok(desktopSession.sessionId.length > 0)

    const persisted = (await desktopSessionRows()).filter(
      (row) => row.sessionId === desktopSession.sessionId
    )
    assert.equal(persisted.length, 1, 'the desktop session must be persisted once')
    assert.equal(persisted[0]!.userId, principal.userId)
    assert.equal(persisted[0]!.providerSessionId, first.authentication.session.id)
    assert.equal(persisted[0]!.revokedAt, null)
    assert.notEqual(
      persisted[0]!.credentialDigest,
      desktopSession.credential,
      'the persisted credential must be a digest, not the credential'
    )

    const resolvedSession = await sessions.resolve({
      credential: desktopSession.credential,
      sessionId: desktopSession.sessionId,
    })
    assert.ok(resolvedSession, 'the issued desktop session must resolve')
    assert.equal(
      resolvedSession.userId,
      principal.userId,
      'the desktop session must carry the mapped application user'
    )

    // --- the refused exchange paths leave no session behind ------------------
    const sessionsBefore = (await desktopSessionRows()).length
    let refusedOrigin = 0
    try {
      await parseDesktopExchangeRequest(
        exchangeRequest(exchangeBody, 'https://hostile.example.test'),
        trustedOrigins
      )
    } catch {
      refusedOrigin += 1
    }
    assert.equal(refusedOrigin, 1, 'an untrusted origin must be refused')

    const secondCode = await issue()
    let refusedPkce = 0
    try {
      const wrong = await parseDesktopExchangeRequest(
        exchangeRequest({ ...exchangeBody, code: secondCode, codeVerifier: randomBase64url(32) }),
        trustedOrigins
      )
      await broker.exchange(wrong)
    } catch {
      refusedPkce += 1
    }
    assert.equal(refusedPkce, 1, 'a wrong PKCE verifier must be refused')

    let refusedReplay = 0
    try {
      const replayed = await parseDesktopExchangeRequest(
        exchangeRequest(exchangeBody),
        trustedOrigins
      )
      await broker.exchange(replayed)
    } catch {
      refusedReplay += 1
    }
    assert.equal(refusedReplay, 1, 'a replayed code must be refused')

    assert.equal(
      (await desktopSessionRows()).length,
      sessionsBefore,
      'a refused exchange must not persist a session'
    )

    // --- refresh invalidates the predecessor, logout revokes -----------------
    const refreshed = await sessions.refresh({
      credential: desktopSession.credential,
      sessionId: desktopSession.sessionId,
    })
    assert.notEqual(
      refreshed.credential,
      desktopSession.credential,
      'a refresh must issue a new credential'
    )
    assert.equal(refreshed.sessionId, desktopSession.sessionId)
    assert.equal(
      await sessions.resolve({
        credential: desktopSession.credential,
        sessionId: desktopSession.sessionId,
      }),
      null,
      'the predecessor credential must stop resolving after a refresh'
    )
    const refreshedPrincipal = await sessions.resolve({
      credential: refreshed.credential,
      sessionId: refreshed.sessionId,
    })
    assert.equal(refreshedPrincipal?.userId, principal.userId)

    await sessions.logout({ credential: refreshed.credential, sessionId: refreshed.sessionId })
    assert.equal(
      await sessions.resolve({
        credential: refreshed.credential,
        sessionId: refreshed.sessionId,
      }),
      null,
      'a logged-out credential must stop resolving'
    )
    const revoked = (await desktopSessionRows()).filter(
      (row) => row.sessionId === refreshed.sessionId
    )
    assert.ok(revoked[0]?.revokedAt, 'a logout must revoke the persisted session')

    // --- the identity join honours a revoked identity ------------------------
    assert.equal(
      (await findUserPrincipalsByAuthIdentity(database, second.authentication.identity)).length,
      1
    )
    assert.equal(await revokeAuthIdentity(database, second.authentication.identity), true)
    assert.equal(
      (await findUserPrincipalsByAuthIdentity(database, second.authentication.identity)).length,
      0,
      'a revoked identity must stop joining to a user'
    )
    assert.equal(
      await identityRows(second.authentication.identity),
      0,
      'a revoked identity must not stay resolvable'
    )

    return {
      status: 'passed',
      provider: PROVIDER,
      accounts: measured.providerAccounts,
      mappedUsers: measured.applicationUsers,
      orphanUsers: measured.orphanUsers,
      desktopSessions: 1,
      exchanges: 1,
      refused: { origin: refusedOrigin, pkce: refusedPkce, replay: refusedReplay },
    }
  } finally {
    await application.close()
  }
}
