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
  /** How many live sessions the account holds, zero when it does not exist. */
  sessionCount(email: string): Promise<number>
  /** The account's verification state and identifier, or null when it is absent. */
  account(email: string): Promise<{ emailVerified: boolean; id: string } | null>
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
  /** How many raced redemptions of one reset token reported success. */
  concurrentResetRedemptions: number
  /** The status each raced redemption of one reset token returned. */
  concurrentResetStatuses: readonly number[]
  /** The status each raced verification returned. */
  concurrentVerificationStatuses: readonly number[]
  deliveryFailureClosed: boolean
  deliveryFailureRecovered: boolean
  /**
   * A signup the provider refused created no account and no session. The
   * refusal was a validation of the password before any write, so it says
   * nothing about a transaction that fails after a write.
   */
  refusedWriteLeftNoAccount: boolean
  /**
   * The provider does not promise that it rolls a write back: the account a
   * refused delivery created is still there, unverified. The proof does not claim
   * that the provider's own transaction rolls back.
   */
  providerWriteRollbackUnproven: boolean
  redacted: boolean
  replayedResetRefused: boolean
  replayedVerificationAccepted: boolean
  restartContinues: boolean
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
 * The outcome of one response: its status and its body, read once. A response
 * body can only be read once, so the status, the code and the text are taken
 * together, and a fulfilled request is never read as a successful one.
 */
async function outcomeOf(
  response: Response
): Promise<{ code?: string; cookies: string; status: number; text: string }> {
  const sessionCookies = cookies(response)
  const text = await response.text()
  let code: string | undefined
  try {
    code = (JSON.parse(text) as { code?: string }).code
  } catch {
    code = undefined
  }
  return { code, cookies: sessionCookies, status: response.status, text }
}

/**
 * Asserts that a refusal is the refusal the provider promises: the exact status
 * and the exact code. A different status, a different code or a missing code
 * fails the assertion, so a refusal cannot pass as the expected refusal for the
 * wrong reason, and a server error can never stand in for a refusal.
 */
export function assertRefusedWith(
  outcome: { code?: string; status: number },
  expected: { code: string; status: number }
): void {
  assert.equal(
    outcome.status,
    expected.status,
    `the refusal must answer ${expected.status}, not ${outcome.status}`
  )
  assert.equal(
    outcome.code,
    expected.code,
    `the refusal must answer ${expected.code}, not ${outcome.code ?? 'no code'}`
  )
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
  // be used until a verification arrives. The account is in place, so the write
  // was not rolled back: the provider does not promise that it is.
  assert.equal(cookies(failedSignup), '', 'a refused delivery must not sign the account in')
  assert.equal(await store.sessionCount(email), 0, 'a refused delivery must not leave a session')
  const unverifiedAccount = await store.account(email)
  assert.ok(unverifiedAccount, 'the account of the refused delivery is in place')
  assert.equal(
    unverifiedAccount.emailVerified,
    false,
    'a refused delivery must leave the account unverified'
  )
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

  // 2. A write the provider refuses leaves no partial state: the account is
  //    still unverified and it still holds no session.
  const refusedEmail = `recovery-refused-${randomUUID()}@example.test`
  // A password the provider refuses, and one that is not a substring of the
  // message it answers with, so the redaction check below measures the response
  // and not the wording.
  const refusedPassword = 'p4ss'
  const refused = await outcomeOf(
    await request('/sign-up/email', {
      email: refusedEmail,
      name: 'Recovery Operator',
      password: refusedPassword,
    })
  )
  // The refusal is pinned: the provider answers this validation with this
  // status and this code, and a different status or a different code fails the
  // assertion.
  assertRefusedWith(refused, { code: 'PASSWORD_TOO_SHORT', status: 400 })
  assert.ok(
    carriesNoSecret(refused.text, [refusedPassword]),
    'a refused signup must not echo the password it was sent with'
  )
  // The refused account is inspected where it would have been: it does not
  // exist, and it holds no session. The refusal was a validation of the
  // password, before any write: it proves that a refused signup writes nothing,
  // and it says nothing about a transaction that fails after a write.
  assert.equal(
    await store.account(refusedEmail),
    null,
    'a refused signup must not create the account'
  )
  assert.equal(
    await store.sessionCount(refusedEmail),
    0,
    'a refused signup must not leave a session'
  )
  const refusedAccount = await store.account(email)
  assert.ok(refusedAccount, 'the account of the refused delivery is still there')
  assert.equal(
    refusedAccount.emailVerified,
    false,
    'a refused delivery must leave the account unverified'
  )
  assert.equal(await store.sessionCount(email), 0, 'a refused delivery must not leave a session')

  // 3. The retry: the verification is asked for again, the working delivery
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
  const recoveryReplayPassword = 'unused synthetic recovery replay password'
  const reusedReset = await request('/reset-password', {
    newPassword: recoveryReplayPassword,
    token: resetToken,
  })
  assert.equal(reusedReset.status, 400)
  const reused = await outcomeOf(reusedReset)
  assert.equal(reused.code, 'INVALID_TOKEN')
  assert.ok(
    carriesNoSecret(reused.text, [resetToken, recoveryReplayPassword]),
    'a refused reset must not echo the token or the password it was sent with'
  )

  // 4. A restart: a new service over the same store keeps a live session, and
  //    the flow continues across the restart. The state lives in the store, not
  //    in the process.
  const afterReset = await request('/sign-in/email', { email, password: replacement })
  assert.equal(afterReset.status, 200)
  const liveCookie = cookies(afterReset)
  assert.ok(liveCookie.length > 0)
  const restarted = createService(delivery)
  // The restarted service is its own service: it has its own request path and
  // its own adapter, over the same store.
  const restartedRequest = requester(restarted)
  const restartedAdapter = (cookie: string) =>
    createBetterAuthServerAdapter(restarted.auth, new Headers({ cookie, origin }))
  assert.ok(await restartedAdapter(liveCookie).getSession(), 'a session survives a restart')
  const restartReset = await restartedRequest('/request-password-reset', {
    email,
    redirectTo: `${origin}/reset`,
  })
  assert.equal(restartReset.status, 200)
  const restartTokens = sent.filter(
    (entry) => entry.kind === 'password-reset' && entry.email === email
  )
  assert.equal(restartTokens.length, 2)
  const restartToken = restartTokens[1]!.token
  const restartResponse = await restartedRequest('/reset-password', {
    newPassword: password,
    token: restartToken,
  })
  assert.equal(restartResponse.status, 200)
  // The reset revokes the session that survived the restart, so the revocation
  // is consistent across the restart.
  assert.equal(await restartedAdapter(liveCookie).refreshSession(), null)
  assert.equal(await store.sessionCount(email), 0)

  // 5. A concurrent verification reports the provider's own statuses, and a
  //    replayed verification is accepted while the token is valid.
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
    () => secondRequest(`/verify-email?token=${encodeURIComponent(secondToken)}`).then(outcomeOf),
    () => secondRequest(`/verify-email?token=${encodeURIComponent(secondToken)}`).then(outcomeOf),
  ])
  const verificationOutcomes = raced
    .filter((outcome) => outcome.ok)
    .map((outcome) => outcome.value as { code?: string; status: number; text: string })
  const concurrentVerificationStatuses = verificationOutcomes.map((outcome) => outcome.status)
  const verified = concurrentVerificationStatuses.filter((status) => status === 200).length
  // The provider's own statuses: a verification link is a credential, so both
  // raced verifications are accepted while the token is valid.
  assert.equal(verified, 2, 'both concurrent verifications are accepted while the token is valid')
  for (const status of concurrentVerificationStatuses) {
    assert.equal(status, 200, 'each concurrent verification must have been accepted')
  }
  for (const outcome of verificationOutcomes) {
    assert.ok(
      carriesNoSecret(outcome.text, [secondToken, password]),
      'a verification must not echo the token or the password'
    )
  }
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
  assert.ok(secondAccount, 'the verified account is in place')
  assert.equal(secondAccount.emailVerified, true)
  // The sessions never outnumber the accepted verifications: a race must not
  // create a session of its own.
  // The sessions correspond to the verifications that actually succeeded: the
  // provider reuses the session it already made, so the accepted verifications
  // do not add one session each.
  const secondSessions = await store.sessionCount(second)
  assert.ok(secondSessions >= 1, 'the verified account holds a session')
  assert.ok(
    secondSessions <= verified + 1,
    'the verified account must not hold more sessions than the verifications that succeeded'
  )

  // 6. Two concurrent reset requests, and then the same reset token redeemed
  //    twice at the same time. The provider's contract decides how many of the
  //    raced redemptions succeed, and the proof states what it observed.
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
  const racedReset = raceResets[0]!
  const racedReplayPassword = 'unused synthetic raced reset replay password'
  // The same token is redeemed twice at the same time, with two different
  // passwords. The statuses are the provider's, not an assumption: the proof
  // records them and bounds what follows from them.
  const redemptions = await runConcurrently([
    () =>
      thirdRequest('/reset-password', {
        newPassword: replacement,
        token: racedReset.token,
      }).then(outcomeOf),
    () =>
      thirdRequest('/reset-password', {
        newPassword: racedReplayPassword,
        token: racedReset.token,
      }).then(outcomeOf),
  ])
  // The outcomes keep the order of the requests that produced them, so each
  // raced redemption stays mapped to the password it carried.
  const redemptionPasswords = [replacement, racedReplayPassword] as const
  const redemptionOutcomes = redemptions
    .filter((outcome) => outcome.ok)
    .map((outcome) => outcome.value as { code?: string; status: number; text: string })
  assert.equal(redemptionOutcomes.length, 2, 'both redemptions must have answered')
  const concurrentResetStatuses = redemptionOutcomes.map((outcome) => outcome.status)
  const concurrentResetRedemptions = redemptionOutcomes.filter(
    (outcome) => outcome.status === 200
  ).length
  // A reset token is single use: exactly one of the two redemptions may succeed
  // and the other must be refused. If the provider ever lets both through, this
  // assertion fails and the race is reported rather than relaxed.
  const winnerIndex = redemptionOutcomes.findIndex((outcome) => outcome.status === 200)
  const loserIndex = redemptionOutcomes.findIndex((outcome) => outcome.status !== 200)
  assert.equal(
    concurrentResetRedemptions,
    1,
    'exactly one redemption of the raced reset token may succeed'
  )
  assert.ok(winnerIndex >= 0, 'one redemption of the raced token must have succeeded')
  assert.ok(loserIndex >= 0, 'the other redemption of the raced token must have been refused')
  // The refused redemption is a refusal, never a server error.
  assertRefusedWith(redemptionOutcomes[loserIndex]!, { code: 'INVALID_TOKEN', status: 400 })
  for (const outcome of redemptionOutcomes) {
    assert.ok(
      carriesNoSecret(outcome.text, [racedReset.token, replacement, racedReplayPassword]),
      'a redemption must not echo the token or either password'
    )
  }
  // The token is consumed by the race: a later redemption of the same token is
  // refused, whatever the race itself did.
  const replayedReset = await thirdRequest('/reset-password', {
    newPassword: racedReplayPassword,
    token: racedReset.token,
  })
  assert.equal(replayedReset.status, 400)
  const replayedRefusal = await outcomeOf(replayedReset)
  assert.equal(replayedRefusal.code, 'INVALID_TOKEN')
  assert.ok(
    carriesNoSecret(replayedRefusal.text, [racedReset.token, racedReplayPassword]),
    'a refused reset must not echo the token or the password it was sent with'
  )
  // Each raced request stays mapped to the password it carried: the password of
  // the successful redemption authenticates, and the password of the refused one
  // is refused with the sign-in refusal, never with a server error.
  const winnerPassword = redemptionPasswords[winnerIndex]!
  const loserPassword = redemptionPasswords[loserIndex]!
  const winnerSignIn = await outcomeOf(
    await thirdRequest('/sign-in/email', { email: third, password: winnerPassword })
  )
  assert.equal(
    winnerSignIn.status,
    200,
    'the password of the successful redemption must authenticate'
  )
  // The check's own session is closed again, so the session count still
  // describes the race and not the check.
  const winnerCookie = winnerSignIn.cookies
  if (winnerCookie) {
    await thirdRequest('/sign-out', {}, winnerCookie)
  }
  const loserSignIn = await outcomeOf(
    await thirdRequest('/sign-in/email', { email: third, password: loserPassword })
  )
  assert.equal(
    loserSignIn.status,
    401,
    'the password of the refused redemption must not authenticate'
  )
  assert.equal(await store.sessionCount(third), 0, 'the sign-in checks must not leave a session')

  // 7. A revocation is consistent: the original first session is revoked by its
  //    own logout, and the original second session keeps working, immediately
  //    after the logout and after the logout is replayed.
  const sessions = await runConcurrently([
    () =>
      thirdRequest('/sign-in/email', { email: third, password: winnerPassword }).then(outcomeOf),
    () =>
      thirdRequest('/sign-in/email', { email: third, password: winnerPassword }).then(outcomeOf),
  ])
  const sessionCookies = sessions
    .filter((outcome) => outcome.ok)
    .map((outcome) => (outcome.value as { cookies: string; status: number }).cookies)
  assert.equal(sessionCookies.length, 2)
  assert.equal(await store.sessionCount(third), 2)
  const thirdAdapter = (cookie: string) =>
    createBetterAuthServerAdapter(thirdService.auth, new Headers({ cookie, origin }))
  const firstLogout = await thirdRequest('/sign-out', {}, sessionCookies[0]!)
  assert.equal(firstLogout.status, 200)
  assert.equal((await firstLogout.json()).success, true)
  assert.equal(await store.sessionCount(third), 1)
  assert.equal(
    await thirdAdapter(sessionCookies[0]!).refreshSession(),
    null,
    'the session that was logged out must be revoked'
  )
  assert.ok(
    await thirdAdapter(sessionCookies[1]!).refreshSession(),
    'the session that was not logged out must still work'
  )
  const replayedLogout = await thirdRequest('/sign-out', {}, sessionCookies[0]!)
  assert.equal(replayedLogout.status, 200)
  assert.equal(
    await store.sessionCount(third),
    1,
    'a replayed logout must not revoke the session that was not logged out'
  )
  assert.equal(await thirdAdapter(sessionCookies[0]!).refreshSession(), null)
  assert.ok(
    await thirdAdapter(sessionCookies[1]!).refreshSession(),
    'the session that was not logged out must still work after the replay'
  )

  // 8. The secrets stay out of every response and out of the receipt. Each
  //    refusal is checked against the secret the request actually carried.
  const wrongPassword = 'wrong synthetic password'
  const denied = await request('/sign-in/email', { email, password: wrongPassword })
  const deniedBody = await denied.text()
  assert.equal(denied.status, 401)
  assert.ok(
    carriesNoSecret(deniedBody, [wrongPassword, password, replacement, resetToken]),
    'a refused sign-in must not echo the password it was sent with'
  )
  const receipt: AuthLifecycleRecoveryReceipt = Object.freeze({
    concurrentResetRedemptions,
    concurrentResetStatuses,
    concurrentVerificationStatuses,
    deliveryFailureClosed: true,
    deliveryFailureRecovered: true,
    refusedWriteLeftNoAccount: true,
    providerWriteRollbackUnproven: true,
    redacted: true,
    replayedResetRefused: true,
    replayedVerificationAccepted: true,
    restartContinues: true,
    sessionRevocationConsistent: true,
  })
  assert.ok(
    carriesNoSecret(receipt, [
      password,
      replacement,
      recoveryReplayPassword,
      racedReplayPassword,
      wrongPassword,
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
