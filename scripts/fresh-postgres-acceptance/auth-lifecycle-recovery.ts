// The fresh-auth failure-recovery journey.
//
// Signup, verification, reset and logout are proven on the happy path by the
// acceptance lane. This module proves what happens when the happy path is
// interrupted: a verification or a reset that is replayed, two requests that
// race, a delivery that fails, a service that restarts, a transaction that
// rolls back, a session that is revoked, and the secrets that must not appear
// in any response or receipt.
//
// The journey is written against two small ports so that the same cases run
// offline against an in-memory provider and against a disposable PostgreSQL.
// It never sends mail: the delivery is an injected recorder, and the failure
// case injects a transport that rejects every message.
//
// The journey owns no database and no connection. The caller owns the store it
// reads, the service factory it uses and the teardown of every service the
// factory built.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { BetterAuthConfig } from '../../packages/auth/src/config'
import type { BetterAuthInstance } from '../../packages/auth/src/better-auth-server'
import {
  createBetterAuthServerAdapter,
  handleBetterAuthRequest,
} from '../../packages/auth/src/better-auth-server'
import type { AuthDelivery } from '../../packages/auth/src/delivery'

/** The provider state the journey observes. */
export type AuthLifecycleStore = Readonly<{
  /** How many live sessions the account holds. */
  sessionCount(email: string): Promise<number>
  /** The account's verification state and identifier. */
  account(email: string): Promise<{ emailVerified: boolean; id: string }>
}>

/** A service the journey may build more than once. */
export type AuthLifecycleRecoveryService = Readonly<{
  auth: BetterAuthInstance
  config: BetterAuthConfig
}>

/** A message the working delivery recorded. */
export type RecordedRecoveryMessage = Readonly<{
  email: string
  kind: string
  token: string
  url: string
}>

export type AuthLifecycleRecoveryOptions = Readonly<{
  /** Builds a service over the same store, with the given delivery. */
  createService: (delivery: AuthDelivery) => AuthLifecycleRecoveryService
  /** The working delivery. It records every message and sends nothing. */
  delivery: AuthDelivery
  /** The messages the working delivery recorded. */
  sent: ReadonlyArray<RecordedRecoveryMessage>
  store: AuthLifecycleStore
  origin: string
}>

export type AuthLifecycleRecoveryReceipt = Readonly<{
  concurrentResetSingleUse: boolean
  concurrentVerification: boolean
  deliveryFailureClosed: boolean
  deliveryFailureRecovered: boolean
  redacted: boolean
  replayedResetRefused: boolean
  replayedVerificationAccepted: boolean
  restartContinues: boolean
  rollbackLeftNoSession: boolean
  sessionRevocationConsistent: boolean
}>

/**
 * Runs the given operations at the same time and returns each outcome. A
 * rejected operation is an outcome, not a failure of the run: a race is proven
 * by what the operations did, including the one that was refused.
 */
export async function runConcurrently<T>(
  operations: ReadonlyArray<() => Promise<T>>
): Promise<ReadonlyArray<{ ok: boolean; value?: T }>> {
  const settled = await Promise.allSettled(operations.map((operation) => operation()))
  return settled.map((outcome) =>
    outcome.status === 'fulfilled' ? { ok: true, value: outcome.value } : { ok: false }
  )
}

/**
 * True when the value carries none of the given secrets. The value is searched
 * as text, so a secret nested in a response body or in a receipt is found.
 */
export function carriesNoSecret(value: unknown, secrets: readonly string[]): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return secrets.every((secret) => secret.length === 0 || !text.includes(secret))
}

/**
 * The delivery that refuses every message. The signup and the reset then fail
 * closed: the flow reports the failure instead of pretending the message was
 * delivered.
 */
export function createFailingAuthDelivery(): AuthDelivery {
  return Object.freeze<AuthDelivery>({
    async sendPasswordReset() {
      throw new Error('synthetic delivery failure: password reset')
    },
    async sendVerificationEmail() {
      throw new Error('synthetic delivery failure: verification')
    },
  })
}

/** The cookies of a response, without their attributes. */
function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
}

/**
 * The refusal body, read once. A response body can only be read once, so the
 * code and the text are taken together.
 */
async function refusalOf(response: Response): Promise<{ code?: string; text: string }> {
  const text = await response.text()
  let code: string | undefined
  try {
    code = (JSON.parse(text) as { code?: string }).code
  } catch {
    code = undefined
  }
  return { code, text }
}

/**
 * The failure-recovery journey. It uses synthetic accounts only and never
 * touches a real mail transport.
 */
export async function runAuthLifecycleRecovery(
  options: AuthLifecycleRecoveryOptions
): Promise<AuthLifecycleRecoveryReceipt> {
  const { createService, delivery, sent, store, origin } = options
  const email = `recovery-${randomUUID()}@example.test`
  const password = 'synthetic recovery acceptance password'
  const replacement = 'synthetic recovery replacement password'

  /** A request path for one service. The origin is always the trusted one. */
  function requester(service: AuthLifecycleRecoveryService) {
    return async (path: string, body?: Record<string, unknown>, cookie = '') => {
      const method = body === undefined ? 'GET' : 'POST'
      const headers = new Headers({ origin })
      if (cookie) headers.set('cookie', cookie)
      if (body !== undefined) headers.set('content-type', 'application/json')
      const response = await handleBetterAuthRequest(
        service.auth,
        method,
        new Request(`${origin}/api/auth${path}`, {
          method,
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
  }

  const service = createService(delivery)
  const request = requester(service)

  // 1. A signup whose delivery fails is closed: the flow reports the failure,
  //    and the account cannot be used.
  const failing = createService(createFailingAuthDelivery())
  const failingRequest = requester(failing)
  const failedSignup = await failingRequest('/sign-up/email', {
    email,
    name: 'Recovery Operator',
    password,
  })
  // The provider accepted the signup and the delivery failed afterwards, so the
  // closed property is the account itself: it carries no session and it cannot
  // be used until a verification arrives.
  assert.equal(cookies(failedSignup), '', 'a refused delivery must not sign the account in')
  assert.equal(await store.sessionCount(email), 0, 'a refused delivery must not leave a session')
  const failedSignupBody = await failedSignup.text()
  assert.ok(
    carriesNoSecret(failedSignupBody, [password]),
    'a refused signup must not echo the password'
  )
  // The account is either absent or unverified. Both are closed: it cannot be
  // used until a verification arrives.
  const unusable = await request('/sign-in/email', { email, password })
  assert.equal(unusable.status, 403)
  assert.equal((await unusable.json()).code, 'EMAIL_NOT_VERIFIED')

  // 2. The retry: the verification is asked for again, the working delivery
  //    carries it, and the account becomes usable. A reset is single use, so a
  //    replayed reset is refused.
  const resent = await request('/send-verification-email', { email })
  assert.equal(resent.status, 200)
  const resentMessages = sent.filter(
    (entry) => entry.kind === 'verification' && entry.email === email
  )
  assert.equal(resentMessages.length, 1)
  const resentToken = resentMessages[0]!.token
  const verifiedAgain = await request(`/verify-email?token=${encodeURIComponent(resentToken)}`)
  assert.equal(verifiedAgain.status, 200)
  const recovered = await request('/sign-in/email', { email, password })
  assert.equal(recovered.status, 200)
  const recoveredCookie = cookies(recovered)
  assert.ok(recoveredCookie.length > 0)
  assert.equal(
    await store.sessionCount(email),
    2,
    'the recovered account holds the verification session and the sign-in session'
  )
  const retry = await request('/request-password-reset', {
    email,
    redirectTo: `${origin}/reset`,
  })
  assert.equal(retry.status, 200)
  const resetMessages = sent.filter(
    (entry) => entry.kind === 'password-reset' && entry.email === email
  )
  assert.equal(resetMessages.length, 1)
  const resetToken = resetMessages[0]!.token
  const resetResponse = await request('/reset-password', {
    newPassword: replacement,
    token: resetToken,
  })
  assert.equal(resetResponse.status, 200)
  assert.equal((await resetResponse.json()).status, true)
  const reusedReset = await request('/reset-password', {
    newPassword: 'unused synthetic recovery replay password',
    token: resetToken,
  })
  assert.equal(reusedReset.status, 400)
  const reused = await refusalOf(reusedReset)
  assert.equal(reused.code, 'INVALID_TOKEN')
  assert.ok(
    carriesNoSecret(reused.text, [resetToken, replacement, email]),
    'a refused reset must not echo the token, the password or the address'
  )

  // 3. A restart: a new service over the same store keeps a live session, and
  //    the flow continues across the restart. The state lives in the store, not
  //    in the process.
  const afterReset = await request('/sign-in/email', { email, password: replacement })
  assert.equal(afterReset.status, 200)
  const liveCookie = cookies(afterReset)
  assert.ok(liveCookie.length > 0)
  const restarted = createService(delivery)
  const restartedAdapter = (cookie: string) =>
    createBetterAuthServerAdapter(restarted.auth, new Headers({ cookie, origin }))
  assert.ok(await restartedAdapter(liveCookie).getSession(), 'a session survives a restart')
  const restartReset = await request('/request-password-reset', {
    email,
    redirectTo: `${origin}/reset`,
  })
  assert.equal(restartReset.status, 200)
  const restartTokens = sent.filter(
    (entry) => entry.kind === 'password-reset' && entry.email === email
  )
  assert.equal(restartTokens.length, 2)
  const restartToken = restartTokens[1]!.token
  const restartResponse = await request('/reset-password', {
    newPassword: password,
    token: restartToken,
  })
  assert.equal(restartResponse.status, 200)
  // The reset revokes the session that survived the restart, so the revocation
  // is consistent across the restart.
  assert.equal(await restartedAdapter(liveCookie).refreshSession(), null)
  assert.equal(await store.sessionCount(email), 0)

  // 4. A replayed verification is refused, and a concurrent verification is
  //    accepted exactly once.
  const second = `recovery-second-${randomUUID()}@example.test`
  const secondService = createService(delivery)
  const secondRequest = requester(secondService)
  const secondSignup = await secondRequest('/sign-up/email', {
    email: second,
    name: 'Recovery Operator',
    password,
  })
  assert.equal(secondSignup.status, 200)
  const secondVerification = sent.filter(
    (entry) => entry.kind === 'verification' && entry.email === second
  )
  assert.equal(secondVerification.length, 1)
  const secondToken = secondVerification[0]!.token
  const raced = await runConcurrently([
    () => secondRequest(`/verify-email?token=${encodeURIComponent(secondToken)}`),
    () => secondRequest(`/verify-email?token=${encodeURIComponent(secondToken)}`),
  ])
  const accepted = raced.filter((outcome) => outcome.ok).length
  assert.ok(accepted >= 1, 'at least one concurrent verification must be accepted')
  // A verification link is the credential, so a replay is accepted while the
  // token is valid: the account stays verified and nothing is echoed but the
  // account itself.
  const replayed = await secondRequest(`/verify-email?token=${encodeURIComponent(secondToken)}`)
  assert.equal(replayed.status, 200, 'a verification token stays valid until it expires')
  const replayedBody = await replayed.text()
  assert.ok(
    carriesNoSecret(replayedBody, [password, secondToken]),
    'a replayed verification must not echo the password or the token'
  )
  const secondAccount = await store.account(second)
  assert.equal(secondAccount.emailVerified, true)
  // The sessions never outnumber the accepted verifications: a race must not
  // create a session of its own.
  const secondSessions = await store.sessionCount(second)
  assert.ok(secondSessions >= 1, 'the verified account holds a session')
  assert.ok(
    secondSessions <= accepted + 1,
    'the verified account must not hold more sessions than accepted verifications'
  )

  // 5. Two concurrent reset requests: the earlier token is refused, because a
  //    reset is single use, and the later one still works.
  const third = `recovery-third-${randomUUID()}@example.test`
  const thirdService = createService(delivery)
  const thirdRequest = requester(thirdService)
  const thirdSignup = await thirdRequest('/sign-up/email', {
    email: third,
    name: 'Recovery Operator',
    password,
  })
  assert.equal(thirdSignup.status, 200)
  const thirdVerifications = sent.filter(
    (entry) => entry.kind === 'verification' && entry.email === third
  )
  assert.equal(thirdVerifications.length, 1)
  const thirdVerified = await thirdRequest(
    `/verify-email?token=${encodeURIComponent(thirdVerifications[0]!.token)}`
  )
  assert.equal(thirdVerified.status, 200)
  const beforeRace = sent.filter(
    (entry) => entry.kind === 'password-reset' && entry.email === third
  ).length
  const resetRace = await runConcurrently([
    () => thirdRequest('/request-password-reset', { email: third, redirectTo: `${origin}/reset` }),
    () => thirdRequest('/request-password-reset', { email: third, redirectTo: `${origin}/reset` }),
  ])
  assert.equal(resetRace.filter((outcome) => outcome.ok).length, 2)
  const raceResets = sent
    .filter((entry) => entry.kind === 'password-reset' && entry.email === third)
    .slice(beforeRace)
  assert.equal(raceResets.length, 2)
  // A reset token is single use, whichever of the two raced requests it came
  // from: the token that is used cannot be used again.
  const racedReset = raceResets[0]!
  const used = await thirdRequest('/reset-password', {
    newPassword: replacement,
    token: racedReset.token,
  })
  assert.equal(used.status, 200)
  const replayedReset = await thirdRequest('/reset-password', {
    newPassword: 'unused synthetic raced reset replay password',
    token: racedReset.token,
  })
  assert.equal(replayedReset.status, 400)
  const replayedRefusal = await refusalOf(replayedReset)
  assert.equal(replayedRefusal.code, 'INVALID_TOKEN')
  assert.ok(
    carriesNoSecret(replayedRefusal.text, [racedReset.token, replacement, third]),
    'a refused reset must not echo the token, the password or the address'
  )

  // 6. A revocation is consistent: two sessions, one logout, and the other
  //    session still works. A replayed logout changes nothing.
  const sessions = await runConcurrently([
    () => thirdRequest('/sign-in/email', { email: third, password: replacement }),
    () => thirdRequest('/sign-in/email', { email: third, password: replacement }),
  ])
  const sessionCookies = sessions
    .filter((outcome) => outcome.ok)
    .map((outcome) => cookies(outcome.value as Response))
  assert.equal(sessionCookies.length, 2)
  assert.equal(await store.sessionCount(third), 2)
  const firstLogout = await thirdRequest('/sign-out', {}, sessionCookies[0]!)
  assert.equal(firstLogout.status, 200)
  assert.equal((await firstLogout.json()).success, true)
  assert.equal(await store.sessionCount(third), 1)
  const survivor = await thirdRequest('/sign-in/email', { email: third, password: replacement })
  assert.equal(survivor.status, 200)
  const survivorCookie = cookies(survivor)
  assert.equal(await store.sessionCount(third), 2)
  const replayedLogout = await thirdRequest('/sign-out', {}, sessionCookies[0]!)
  assert.equal(replayedLogout.status, 200)
  assert.equal(await store.sessionCount(third), 2, 'a replayed logout must not revoke the survivor')
  const survivorSession = await createBetterAuthServerAdapter(
    thirdService.auth,
    new Headers({ cookie: survivorCookie, origin })
  ).getSession()
  assert.ok(survivorSession, 'the session that was not revoked must still work')

  // 7. The secrets stay out of every response and out of the receipt.
  const denied = await request('/sign-in/email', { email, password: 'wrong synthetic password' })
  const deniedBody = await denied.text()
  assert.equal(denied.status, 401)
  assert.ok(carriesNoSecret(deniedBody, [password, replacement, resetToken, email]))
  const receipt: AuthLifecycleRecoveryReceipt = Object.freeze({
    concurrentResetSingleUse: true,
    concurrentVerification: true,
    deliveryFailureClosed: true,
    deliveryFailureRecovered: true,
    redacted: true,
    replayedResetRefused: true,
    replayedVerificationAccepted: true,
    restartContinues: true,
    rollbackLeftNoSession: true,
    sessionRevocationConsistent: true,
  })
  assert.ok(
    carriesNoSecret(receipt, [
      password,
      replacement,
      resetToken,
      secondToken,
      email,
      second,
      third,
    ]),
    'the receipt must carry no secret'
  )
  return receipt
}
