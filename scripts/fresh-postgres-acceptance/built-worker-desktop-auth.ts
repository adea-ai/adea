// The built-Worker desktop authorization qualification.
//
// The desktop principal lifecycle proves the request path the exchange route
// composes: the brokers, the parser and the database functions, in process.
// It does not prove that the Worker that *registers* the desktop routes serves
// them. This module closes that gap. It drives the actual locally built Worker
// over HTTP and asserts what the built routes do:
//
//   - the authorize route is registered and refuses a request without a session
//     by sending the caller to sign in;
//   - the authorize route refuses a request that carries a parameter the
//     desktop contract does not define;
//   - the authorize route issues an authorization code to a signed-in fresh
//     account, and the code never leaves the callback fragment;
//   - the exchange route turns that code into a desktop session;
//   - the exchange route refuses a wrong PKCE verifier, an untrusted origin and
//     a replayed code;
//   - the exchange preflight refuses an untrusted origin;
//   - no response carries a secret.
//
// The module holds no transport of its own. Every request goes through the
// injected transport, so the assertions can be exercised without a Worker, a
// database or a network, and a transport that answers wrongly makes the
// assertions fail instead of passing vacuously.
//
// A step that cannot be judged because the transport failed is retried with
// fresh material, and the receipt records how many attempts each step took. A
// step that produced a response is judged by that response: a refusal is a
// refusal, and a 5xx is not a refusal.

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { BuiltWorkerFailure, sanitizeReceipt, withoutTopLevelField } from './built-worker-failures'

/** The route the built Worker serves for a desktop authorization request. */
export const DESKTOP_AUTHORIZE_PATH = '/api/auth/desktop/authorize'

/** The route the built Worker serves for a desktop authorization exchange. */
export const DESKTOP_EXCHANGE_PATH = '/api/auth/desktop/exchange'

/** The redirect the desktop contract names, and the only one the routes accept. */
export const DESKTOP_CALLBACK_URI = 'adea://auth/callback'

/** The path the authorize route sends a completed request to. */
export const DESKTOP_COMPLETION_PATH = '/auth/desktop/complete'

/**
 * The transport envelopes the local runtime answers with.
 *
 * The list is closed and narrow on purpose. A body that merely starts with
 * "Error: " is not an envelope: an application may answer with a text body of
 * its own, and treating that as an infrastructure failure would let an
 * application failure be retried into a pass.
 */
export const TRANSPORT_ENVELOPE_BODIES: readonly string[] = [
  'Error: Network connection lost.',
  'Error: The socket was closed unexpectedly.',
  'Error: The server closed the connection without sending a response.',
]

/** The origin the desktop shell sends, and one the routes trust. */
export const DESKTOP_TRUSTED_ORIGIN = 'http://127.0.0.1:4789'

/** An origin no desktop request may come from. */
export const HOSTILE_ORIGIN = 'https://hostile.example.test'

/** The kind of proof this receipt is. */
export const BUILT_WORKER_DESKTOP_AUTH_PROOF_KIND = 'built-worker-desktop-auth'

/** One request the qualification makes against the built Worker. */
export type BuiltWorkerRequest = {
  readonly method: 'GET' | 'POST' | 'OPTIONS'
  readonly path: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

/** One response the built Worker returned. */
export type BuiltWorkerResponse = {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** The transport the qualification drives the built Worker through. */
export type BuiltWorkerTransport = (request: BuiltWorkerRequest) => Promise<BuiltWorkerResponse>

/**
 * How one attempt ended.
 *
 * The vocabulary is fixed, so a receipt cannot grow a value that carries a
 * secret, and so a reader can tell an application failure from an
 * infrastructure failure without parsing prose.
 */
export type DesktopAttemptOutcome =
  | 'passed'
  | 'refused'
  | 'application-failure'
  | 'infrastructure-failure'
  | 'transport-failure'
  | 'assertion-failed'

/** One named assertion and what it found. */
export type DesktopEndpointAssertion = {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
  /** How many attempts the assertion made. */
  readonly attempts: number
  /** How each attempt ended, in order. */
  readonly outcomes: readonly DesktopAttemptOutcome[]
}

/** The auth lifecycle evidence the receipt carries. */
export type AuthLifecycleEvidence = {
  readonly suite: string
  readonly assertions: readonly string[]
  readonly passed: number
}

/** The receipt the qualification publishes. It carries no credential. */
export type BuiltWorkerDesktopAuthReceipt = {
  readonly status: 'passed' | 'failed'
  readonly proofKind: typeof BUILT_WORKER_DESKTOP_AUTH_PROOF_KIND
  readonly evidence: 'local-disposable' | 'ci' | 'simulated'
  readonly worker: {
    readonly built: true
    readonly baseUrl: string
    readonly routes: readonly string[]
    /** The artifact the qualification actually proved. */
    readonly artifact: {
      readonly digest: string
      readonly sha: string
      readonly dirty: boolean | null
      /** True when the artifact was proved to belong to this checkout. */
      readonly verified: boolean
    }
  }
  /** Every assertion the qualification made, in the order it made them. */
  readonly assertions: readonly DesktopEndpointAssertion[]
  /** How many assertions passed. */
  readonly passed: number
  /** How many assertions failed. A passed proof has none. */
  readonly failed: number
  /** The full auth lifecycle assertions, preserved and not reduced to a status. */
  readonly authLifecycle: AuthLifecycleEvidence
  /**
   * The verdict of the teardown that ran after the qualification.
   *
   * The runner fills it in: a receipt is published only after the Worker was
   * stopped, the container was removed and the runtime material was removed,
   * and the receipt says which of those happened.
   */
  readonly cleanup?: {
    readonly workerStopped: boolean
    readonly containerRemoved: boolean
    readonly materialRemoved: boolean
  }
  readonly checkout: {
    readonly sha: string
    readonly dirty: boolean | null
    readonly source: string
  }
  readonly module: {
    readonly sha: string
    readonly dirty: boolean | null
    readonly source: string
  }
}

/** What the qualification needs to run. */
export type BuiltWorkerDesktopAuthInput = {
  /** The transport that reaches the built Worker. */
  readonly transport: BuiltWorkerTransport
  /** The base URL the built Worker serves. */
  readonly baseUrl: string
  /** The artifact the qualification proves. */
  readonly artifact: BuiltWorkerDesktopAuthReceipt['worker']['artifact']
  /** The origin the desktop shell sends. */
  readonly desktopOrigin?: string
  /**
   * Values that must never appear in a response. The qualification adds the
   * values it observed itself: the session cookie, the authorization code and
   * the desktop credential.
   */
  readonly secrets?: readonly string[]
  /** How many attempts a step gets before it counts as failed. */
  readonly attempts?: number
  /** The auth lifecycle evidence the receipt carries. */
  readonly authLifecycle: AuthLifecycleEvidence
  /** The class of this run's evidence. */
  readonly evidence: 'local-disposable' | 'ci' | 'simulated'
  /** The provenance of the checkout the qualification ran in. */
  readonly checkout: BuiltWorkerDesktopAuthReceipt['checkout']
  /** The provenance of the tree the qualification code came from. */
  readonly module: BuiltWorkerDesktopAuthReceipt['module']
}

/** The result of one step: what it observed and how many attempts it took. */
type StepOutcome = {
  readonly assertion: DesktopEndpointAssertion
  readonly attempts: number
}

/**
 * What one step found.
 *
 * A step that reached the Worker is judged by the response it produced, a
 * refusal included. A step that never received a response carries the outcome
 * of the attempt itself, so the receipt can show what happened.
 */
type StepResult = {
  readonly passed: boolean
  readonly detail: string
  readonly outcome: DesktopAttemptOutcome
}

/** A step the qualification runs. */
type Step = {
  readonly name: string
  /**
   * True when the step changes state. A step that changes state is never
   * replayed: a request whose outcome is unknown may already have changed the
   * instance, and repeating it would turn an unknown outcome into a second
   * mutation rather than an answer.
   */
  readonly mutating: boolean
  readonly run: (attempt: number) => Promise<StepResult>
}

/** How many attempts a step gets by default. */
const DEFAULT_ATTEMPTS = 3

/**
 * The assertions a test run reported as passing.
 *
 * The auth lifecycle is a test suite, so its proof is the list of the
 * assertions that passed. The receipt carries that list: a suite name and a
 * status say that something ran, not what was proved.
 */
export function parseAuthLifecycleAssertions(output: string): {
  readonly assertions: readonly string[]
  readonly passed: number
} {
  const assertions: string[] = []
  for (const line of String(output ?? '').split('\n')) {
    const match = /^\(pass\)\s+(.+?)(?:\s+\[\d[\d.]*m?s\])?$/u.exec(line.trim())
    if (!match) continue
    const name = match[1]?.trim()
    if (name) assertions.push(name)
  }
  return { assertions, passed: assertions.length }
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/** A fresh PKCE verifier and the challenge that names it. */
export function desktopPkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = base64url(randomBytes(48))
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

/** A fresh bounded nonce and state, as the desktop contract requires. */
export function desktopNonceAndState(): { readonly nonce: string; readonly state: string } {
  return { nonce: base64url(randomBytes(24)), state: base64url(randomBytes(24)) }
}

/** The authorize request the desktop shell sends. */
export function desktopAuthorizePath(input: {
  readonly challenge: string
  readonly nonce: string
  readonly state: string
  readonly extra?: string
}): string {
  const url = new URL(DESKTOP_AUTHORIZE_PATH, 'https://desktop.invalid')
  url.searchParams.set('client', 'desktop')
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('nonce', input.nonce)
  url.searchParams.set('redirect_uri', DESKTOP_CALLBACK_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', input.state)
  if (input.extra) url.searchParams.set(input.extra, 'unexpected')
  return `${url.pathname}${url.search}`
}

/**
 * The authorization code the built Worker issued, read out of the completion
 * fragment the authorize route redirects to.
 *
 * The route sends the caller to the desktop completion page with the callback
 * in the fragment, so the code never travels in the query string.
 */
export function readIssuedAuthorizationCode(location: string): {
  readonly code: string
  readonly nonce: string
} {
  const fragment = location.split('#')[1] ?? ''
  const callback = new URLSearchParams(fragment).get('callback') ?? ''
  let parsed: URL
  try {
    parsed = new URL(callback)
  } catch {
    return { code: '', nonce: '' }
  }
  return {
    code: parsed.searchParams.get('code') ?? '',
    nonce: parsed.searchParams.get('nonce') ?? '',
  }
}

/** What a validated authorization carries. */
export type ValidatedAuthorization = {
  readonly code: string
  readonly nonce: string
  readonly state: string
}

/** The result of reading an authorization out of a redirect. */
export type AuthorizationValidation =
  | { readonly ok: true; readonly authorization: ValidatedAuthorization }
  | { readonly ok: false; readonly reason: string }

/**
 * Reads the authorization out of the redirect the authorize route answered.
 *
 * The redirect is validated, not merely parsed: the route must have answered
 * `303`, the destination must be exactly the desktop completion page, and the
 * callback must be exactly the desktop callback with exactly the code, nonce
 * and state the client sent. A redirect that carries anything else is not an
 * authorization, and the caller must not exchange anything with it.
 */
export function validateIssuedAuthorization(input: {
  readonly status: number
  readonly location: string
  readonly expectedOrigin: string
  readonly expectedState: string
  readonly expectedNonce: string
}): AuthorizationValidation {
  if (input.status !== 303) {
    return { ok: false, reason: 'the authorize route did not complete the request' }
  }
  let destination: URL
  try {
    // The route answers with a relative location, the way the product sends it.
    // It is resolved against the origin the Worker serves, so a relative
    // redirect is the valid one and a location on another origin is not.
    destination = new URL(input.location, `${input.expectedOrigin}/`)
  } catch {
    return { ok: false, reason: 'the authorize route answered with an unusable location' }
  }
  if (destination.origin !== input.expectedOrigin) {
    return { ok: false, reason: 'the authorize route sent the caller to another origin' }
  }
  if (destination.pathname !== DESKTOP_COMPLETION_PATH) {
    return {
      ok: false,
      reason: 'the authorize route did not send the caller to the completion page',
    }
  }
  if (destination.search) {
    return { ok: false, reason: 'the authorize route answered with an unexpected query' }
  }
  const fragment = input.location.split('#')[1] ?? ''
  const fragmentKeys = [...new URLSearchParams(fragment).keys()]
  if (fragmentKeys.length !== 1 || fragmentKeys[0] !== 'callback') {
    return { ok: false, reason: 'the authorize route answered with unexpected fragment parameters' }
  }
  const callback = new URLSearchParams(fragment).get('callback') ?? ''
  let parsed: URL
  try {
    parsed = new URL(callback)
  } catch {
    return { ok: false, reason: 'the authorize route answered without a desktop callback' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'the desktop callback carried credentials' }
  }
  if (parsed.hash) {
    return { ok: false, reason: 'the desktop callback carried a fragment' }
  }
  if (`${parsed.protocol}//${parsed.host}${parsed.pathname}` !== DESKTOP_CALLBACK_URI) {
    return { ok: false, reason: 'the authorize route answered with another callback destination' }
  }
  const names = [...parsed.searchParams.keys()].toSorted()
  if (names.join(',') !== 'code,nonce,state') {
    return { ok: false, reason: 'the desktop callback carried unexpected parameters' }
  }
  const code = parsed.searchParams.get('code') ?? ''
  const nonce = parsed.searchParams.get('nonce') ?? ''
  const state = parsed.searchParams.get('state') ?? ''
  if (code.length < 8 || code.length > 512) {
    return { ok: false, reason: 'the desktop callback carried no usable authorization code' }
  }
  if (nonce !== input.expectedNonce) {
    return { ok: false, reason: 'the desktop callback carried another nonce' }
  }
  if (state !== input.expectedState) {
    return { ok: false, reason: 'the desktop callback carried another state' }
  }
  return { ok: true, authorization: { code, nonce, state } }
}

/** The sign-up request that creates the fresh account. */
export function freshAccountSignUpRequest(input: {
  readonly baseUrl: string
  readonly email: string
  readonly password: string
}): BuiltWorkerRequest {
  return {
    method: 'POST',
    path: '/api/auth/sign-up/email',
    headers: {
      'content-type': 'application/json',
      origin: input.baseUrl,
    },
    body: JSON.stringify({
      email: input.email,
      name: 'Built Worker Qualification',
      password: input.password,
    }),
  }
}

/**
 * The raw values of the cookies the sign-up response issued.
 *
 * Every cookie is tracked separately: a value that leaves the Worker anywhere
 * else is a leak, and a leak of one cookie is a leak even when another cookie
 * travels in the same header.
 */
export function sessionCookieValues(response: BuiltWorkerResponse): string[] {
  const header = response.headers['set-cookie']
  if (!header) return []
  return header
    .split(/,(?=[^;,]+=)/u)
    .map((value) => value.split(';')[0]?.trim() ?? '')
    .filter((value) => value.includes('='))
    .map((value) => value.slice(value.indexOf('=') + 1))
    .filter((value) => value.length > 0)
}

/** The session token the sign-up response carried in its body, if it carried one. */
export function signupTokenFrom(response: BuiltWorkerResponse): string {
  return /"token"\s*:\s*"([^"]+)"/u.exec(response.body)?.[1] ?? ''
}

/** The session cookie the sign-up response issued, if it issued one. */
export function sessionCookieFrom(response: BuiltWorkerResponse): string {
  const header = response.headers['set-cookie']
  if (!header) return ''
  const values = header.split(/,(?=[^;,]+=)/u)
  const cookies = values
    .map((value) => value.split(';')[0]?.trim() ?? '')
    .filter((value) => value.includes('='))
  return cookies.join('; ')
}

/** The exchange request the desktop shell sends. */
export function desktopExchangeRequest(input: {
  readonly code: string
  readonly verifier: string
  readonly nonce: string
  readonly origin: string
}): BuiltWorkerRequest {
  return {
    method: 'POST',
    path: DESKTOP_EXCHANGE_PATH,
    headers: {
      'content-type': 'application/json',
      origin: input.origin,
    },
    body: JSON.stringify({
      code: input.code,
      codeVerifier: input.verifier,
      nonce: input.nonce,
      redirectUri: DESKTOP_CALLBACK_URI,
    }),
  }
}

/**
 * True when the response is the local runtime's own error envelope.
 *
 * The local runtime answers a failed request with its own envelope, which
 * names the transport failure. An application error is the application's own
 * answer, and the two must not be confused: an application failure is a
 * failure of the product and is never retried into a pass.
 */
export function isInfrastructureErrorEnvelope(body: string): boolean {
  const text = String(body ?? '').trim()
  if (!text) return false
  return TRANSPORT_ENVELOPE_BODIES.includes(text)
}

/** The outcome a response that did not satisfy an assertion carries. */
export function failureOutcome(response: BuiltWorkerResponse): DesktopAttemptOutcome {
  if (response.status >= 500) {
    return isInfrastructureErrorEnvelope(response.body)
      ? 'infrastructure-failure'
      : 'application-failure'
  }
  return 'assertion-failed'
}

/**
 * The result of a request that answered with something the assertion did not
 * expect. The detail is a fixed sentence: it names the status and the kind of
 * failure, never a body and never a value.
 */
export function serverFailure(response: BuiltWorkerResponse, what: string): StepResult {
  const outcome = failureOutcome(response)
  return {
    passed: false,
    detail:
      outcome === 'infrastructure-failure'
        ? `${what} failed in the local runtime (${response.status})`
        : `${what} answered ${response.status}`,
    outcome,
  }
}

/** True when the response body names a desktop session credential. */
export function responseCarriesCredential(body: string): boolean {
  return /"credential"\s*:\s*"[^"]{8,}"/u.test(body)
}

/**
 * Runs the qualification against the built Worker and returns the receipt.
 *
 * The run fails when an assertion fails, when the auth lifecycle evidence the
 * receipt must carry is missing, or when no assertion passed at all. A receipt
 * that says less than that is not a receipt.
 */
export async function runBuiltWorkerDesktopAuth(
  input: BuiltWorkerDesktopAuthInput
): Promise<BuiltWorkerDesktopAuthReceipt> {
  if (!input.authLifecycle || input.authLifecycle.assertions.length === 0) {
    throw new Error(
      'the built-Worker qualification must carry the full auth lifecycle assertions; a status is not enough'
    )
  }
  if (input.authLifecycle.passed <= 0) {
    throw new Error('the built-Worker qualification must carry a passing auth lifecycle')
  }

  const attempts = Math.max(1, input.attempts ?? DEFAULT_ATTEMPTS)
  const desktopOrigin = input.desktopOrigin ?? DESKTOP_TRUSTED_ORIGIN
  const observedSecrets: string[] = [...(input.secrets ?? [])]
  const responses: BuiltWorkerResponse[] = []
  let sessionCookie = ''

  /**
   * Where a value was legitimately issued.
   *
   * A value the Worker had to hand out travels in one field of one response:
   * a cookie in the `set-cookie` header, the sign-up token in the `token` field,
   * the authorization code in the `location` header, the desktop credential in
   * the `credential` field. The leakage check exempts that field and no
   * other: the rest of the issuing response is checked like any other, so a
   * value that is duplicated into the same response is a leak.
   */
  type Exemption = {
    readonly index: number
    readonly header?: string
    /**
     * Only this part of the header may carry the value. The authorization
     * code is allowed in the fragment of the location, not in its query.
     */
    readonly headerPart?: 'fragment'
    /**
     * Only the first top-level occurrence of this body field may carry the
     * value. A nested copy and a duplicate key are not the authorized
     * occurrence.
     */
    readonly bodyField?: string
  }
  const issuedIn = new Map<string, Exemption[]>()

  const send = async (request: BuiltWorkerRequest): Promise<number> => {
    const response = await input.transport(request)
    responses.push(response)
    return responses.length - 1
  }

  /**
   * Records a value the Worker had to hand out, and the field it came from.
   *
   * Every occurrence is recorded: the same value may be authorized in two
   * fields of the same response, and a second occurrence must not overwrite
   * the first one.
   */
  const observeIssued = (
    value: string,
    index: number,
    exemption: {
      readonly header?: string
      readonly headerPart?: 'fragment'
      readonly bodyField?: string
    }
  ): void => {
    if (!value) return
    observedSecrets.push(value)
    const occurrences = issuedIn.get(value) ?? []
    occurrences.push({ index, ...exemption })
    issuedIn.set(value, occurrences)
  }

  /**
   * True when the response carries the secret outside the one field that is
   * allowed to carry it.
   */
  const carriesSecret = (
    response: BuiltWorkerResponse,
    secret: string,
    exemptions: readonly Exemption[]
  ): boolean => {
    const headers = Object.entries(response.headers)
      .flatMap(([name, value]) => {
        const exemption = exemptions.find((entry) => entry.header === name)
        if (!exemption) return [value]
        if (exemption.headerPart === 'fragment') {
          const hash = value.indexOf('#')
          return hash < 0 ? [] : [value.slice(0, hash)]
        }
        return []
      })
      .join(' ')
    const body = exemptions
      .filter((exemption) => exemption.bodyField)
      .reduce((text, exemption) => withoutTopLevelField(text, exemption.bodyField!), response.body)
    return `${headers}\n${body}`.includes(secret)
  }

  /**
   * Runs one step and records how every attempt ended.
   *
   * A step is retried only when it changed nothing and the failure was not the
   * application refusing or failing. An application failure is never retried
   * into a pass, and a step that changes state is never replayed: its outcome
   * may already be unknown, and repeating it would change the instance twice
   * instead of answering the question once.
   */
  const runStep = async (step: Step): Promise<StepOutcome> => {
    let used = 0
    const outcomes: DesktopAttemptOutcome[] = []
    let last: StepResult = {
      passed: false,
      detail: 'the step did not run',
      outcome: 'assertion-failed',
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      used = attempt + 1
      try {
        last = await step.run(attempt)
      } catch {
        last = {
          passed: false,
          detail: 'the request never reached the Worker',
          outcome: 'transport-failure',
        }
      }
      outcomes.push(last.outcome)
      if (last.passed) {
        return {
          assertion: {
            name: step.name,
            passed: true,
            detail: last.detail,
            attempts: used,
            outcomes,
          },
          attempts: used,
        }
      }
      const retryable =
        !step.mutating &&
        (last.outcome === 'transport-failure' || last.outcome === 'infrastructure-failure')
      if (!retryable) break
    }
    return {
      assertion: {
        name: step.name,
        passed: false,
        detail: last.detail,
        attempts: used,
        outcomes,
      },
      attempts: used,
    }
  }

  const steps: Step[] = []

  // The fresh account. The Worker signs it up through its own auth API, so the
  // session the authorize route reads is a session the built Worker issued.
  const email = `built-worker-${randomUUID()}@example.test`
  const password = base64url(randomBytes(24))
  const signUp = await runStep({
    name: 'the-built-worker-signs-up-a-fresh-account',
    mutating: true,
    run: async () => {
      const index = await send(
        freshAccountSignUpRequest({ baseUrl: input.baseUrl, email, password })
      )
      const response = responses[index]!
      if (response.status >= 500) {
        return serverFailure(response, 'the sign-up returned ')
      }
      const cookie = sessionCookieFrom(response)
      if (response.status !== 200 || !cookie) {
        return {
          passed: false,
          detail: `the sign-up did not issue a session cookie (status ${response.status})`,
          outcome: 'assertion-failed',
        }
      }
      sessionCookie = cookie
      for (const value of sessionCookieValues(response)) {
        observeIssued(value, index, { header: 'set-cookie' })
      }
      const token = signupTokenFrom(response)
      if (token) observeIssued(token, index, { bodyField: 'token' })
      return {
        passed: true,
        detail: 'the built Worker issued a session for a fresh account',
        outcome: 'passed',
      }
    },
  })

  const authorizeWithSession = async (): Promise<{
    readonly ok: boolean
    readonly reason: string
    readonly code: string
    readonly nonce: string
    readonly verifier: string
  }> => {
    const pkce = desktopPkcePair()
    const { nonce, state } = desktopNonceAndState()
    const index = await send({
      method: 'GET',
      path: desktopAuthorizePath({
        challenge: pkce.challenge,
        nonce,
        state,
      }),
      headers: { cookie: sessionCookie },
    })
    const response = responses[index]!
    const location = response.headers.location ?? ''
    // The code is tracked whether or not the redirect turns out to be valid: a
    // code that came from an unexpected place is still a value that must not
    // travel anywhere else.
    const issued = readIssuedAuthorizationCode(location)
    if (issued.code) {
      observeIssued(issued.code, index, { header: 'location', headerPart: 'fragment' })
    }
    const validation = validateIssuedAuthorization({
      status: response.status,
      location,
      expectedOrigin: new URL(input.baseUrl).origin,
      expectedState: state,
      expectedNonce: nonce,
    })
    if (!validation.ok) {
      return { ok: false, reason: validation.reason, code: '', nonce: '', verifier: pkce.verifier }
    }
    return {
      ok: true,
      reason: '',
      code: validation.authorization.code,
      nonce: validation.authorization.nonce,
      verifier: pkce.verifier,
    }
  }

  steps.push({
    name: 'the-desktop-authorize-route-refuses-a-request-without-a-session',
    mutating: false,
    run: async () => {
      const pkce = desktopPkcePair()
      const { nonce, state } = desktopNonceAndState()
      const index = await send({
        method: 'GET',
        path: desktopAuthorizePath({ challenge: pkce.challenge, nonce, state }),
      })
      const response = responses[index]!
      if (response.status >= 500) {
        return serverFailure(response, 'the authorize route returned ')
      }
      const location = response.headers.location ?? ''
      if (response.status !== 303) {
        return {
          passed: false,
          detail: `the authorize route answered ${response.status} instead of refusing the caller`,
          outcome: 'assertion-failed',
        }
      }
      if (!location.includes('/auth/sign-in')) {
        return {
          passed: false,
          detail: 'the authorize route did not send the caller to sign in',
          outcome: 'assertion-failed',
        }
      }
      return {
        passed: true,
        detail: 'the authorize route sent the unsigned caller to sign in',
        outcome: 'refused',
      }
    },
  })

  steps.push({
    name: 'the-desktop-authorize-route-refuses-an-undefined-parameter',
    mutating: false,
    run: async () => {
      const pkce = desktopPkcePair()
      const { nonce, state } = desktopNonceAndState()
      const index = await send({
        method: 'GET',
        path: desktopAuthorizePath({
          challenge: pkce.challenge,
          nonce,
          state,
          extra: 'access_token',
        }),
      })
      const response = responses[index]!
      if (response.status >= 500) {
        return serverFailure(response, 'the authorize route returned ')
      }
      if (response.status !== 400) {
        return {
          passed: false,
          detail: `the authorize route answered ${response.status} instead of refusing the request`,
          outcome: 'assertion-failed',
        }
      }
      return {
        passed: true,
        detail: 'the authorize route refused a parameter it does not define',
        outcome: 'refused',
      }
    },
  })

  steps.push({
    name: 'the-desktop-authorize-route-issues-an-authorization-code',
    mutating: true,
    run: async () => {
      const issued = await authorizeWithSession()
      if (!issued.ok) {
        return {
          passed: false,
          detail: issued.reason,
          outcome: 'assertion-failed',
        }
      }
      return {
        passed: true,
        detail: 'the authorize route issued an authorization code in the completion fragment',
        outcome: 'passed',
      }
    },
  })

  let exchangedCode = ''
  let exchangedNonce = ''
  let exchangedVerifier = ''

  steps.push({
    name: 'the-desktop-exchange-route-issues-a-session',
    mutating: true,
    run: async () => {
      const issued = await authorizeWithSession()
      if (!issued.ok) {
        return { passed: false, detail: issued.reason, outcome: 'assertion-failed' }
      }
      const index = await send(
        desktopExchangeRequest({
          code: issued.code,
          verifier: issued.verifier,
          nonce: issued.nonce,
          origin: desktopOrigin,
        })
      )
      const response = responses[index]!
      if (response.status >= 500) {
        return serverFailure(response, 'the exchange route returned ')
      }
      if (response.status !== 200) {
        return {
          passed: false,
          detail: `the exchange route answered ${response.status} instead of issuing a session`,
          outcome: 'assertion-failed',
        }
      }
      if (!responseCarriesCredential(response.body)) {
        return {
          passed: false,
          detail: 'the exchange route issued no desktop session credential',
          outcome: 'assertion-failed',
        }
      }
      if (response.headers['access-control-allow-origin'] !== desktopOrigin) {
        return {
          passed: false,
          detail: 'the exchange route did not allow the trusted desktop origin',
          outcome: 'assertion-failed',
        }
      }
      const credential = response.body.match(/"credential"\s*:\s*"([^"]+)"/u)?.[1] ?? ''
      observeIssued(credential, index, { bodyField: 'credential' })
      exchangedCode = issued.code
      exchangedNonce = issued.nonce
      exchangedVerifier = issued.verifier
      return {
        passed: true,
        detail: 'the exchange route turned the code into a desktop session',
        outcome: 'passed',
      }
    },
  })

  steps.push({
    name: 'the-desktop-exchange-route-refuses-a-wrong-pkce-verifier',
    mutating: true,
    run: async () => {
      const issued = await authorizeWithSession()
      if (!issued.ok) {
        return { passed: false, detail: issued.reason, outcome: 'assertion-failed' }
      }
      const wrong = base64url(randomBytes(48))
      const index = await send(
        desktopExchangeRequest({
          code: issued.code,
          verifier: wrong,
          nonce: issued.nonce,
          origin: desktopOrigin,
        })
      )
      const response = responses[index]!
      if (response.status >= 500) {
        return serverFailure(response, 'the exchange route returned ')
      }
      if (response.status !== 400) {
        return {
          passed: false,
          detail: `the exchange route answered ${response.status} instead of refusing the verifier`,
          outcome: 'assertion-failed',
        }
      }
      if (responseCarriesCredential(response.body)) {
        return {
          passed: false,
          detail: 'the exchange route issued a credential for a wrong verifier',
          outcome: 'assertion-failed',
        }
      }
      return {
        passed: true,
        detail: 'the exchange route refused a wrong PKCE verifier',
        outcome: 'refused',
      }
    },
  })

  steps.push({
    name: 'the-desktop-exchange-route-refuses-an-untrusted-origin',
    mutating: true,
    run: async () => {
      const issued = await authorizeWithSession()
      if (!issued.ok) {
        return { passed: false, detail: issued.reason, outcome: 'assertion-failed' }
      }
      const index = await send(
        desktopExchangeRequest({
          code: issued.code,
          verifier: issued.verifier,
          nonce: issued.nonce,
          origin: HOSTILE_ORIGIN,
        })
      )
      const response = responses[index]!
      if (response.status >= 500) {
        return serverFailure(response, 'the exchange route returned ')
      }
      if (response.status !== 400) {
        return {
          passed: false,
          detail: `the exchange route answered ${response.status} instead of refusing the origin`,
          outcome: 'assertion-failed',
        }
      }
      if (responseCarriesCredential(response.body)) {
        return {
          passed: false,
          detail: 'the exchange route issued a credential for an untrusted origin',
          outcome: 'assertion-failed',
        }
      }
      if (response.headers['access-control-allow-origin']) {
        return {
          passed: false,
          detail: 'the exchange route allowed an untrusted origin in its CORS headers',
          outcome: 'assertion-failed',
        }
      }
      return {
        passed: true,
        detail: 'the exchange route refused an untrusted origin',
        outcome: 'refused',
      }
    },
  })

  steps.push({
    name: 'the-desktop-exchange-route-refuses-a-replayed-code',
    mutating: true,
    run: async () => {
      if (!exchangedCode) {
        return {
          passed: false,
          detail: 'no exchanged code was available to replay',
          outcome: 'assertion-failed',
        }
      }
      const index = await send(
        desktopExchangeRequest({
          code: exchangedCode,
          verifier: exchangedVerifier,
          nonce: exchangedNonce,
          origin: desktopOrigin,
        })
      )
      const response = responses[index]!
      if (response.status >= 500) {
        return serverFailure(response, 'the exchange route returned ')
      }
      if (response.status !== 400) {
        return {
          passed: false,
          detail: `the exchange route answered ${response.status} instead of refusing the replay`,
          outcome: 'assertion-failed',
        }
      }
      if (responseCarriesCredential(response.body)) {
        return {
          passed: false,
          detail: 'the exchange route issued a second credential for one code',
          outcome: 'assertion-failed',
        }
      }
      return {
        passed: true,
        detail: 'the exchange route refused the replayed code',
        outcome: 'refused',
      }
    },
  })

  steps.push({
    name: 'the-desktop-exchange-preflight-refuses-an-untrusted-origin',
    mutating: false,
    run: async () => {
      const index = await send({
        method: 'OPTIONS',
        path: DESKTOP_EXCHANGE_PATH,
        headers: { origin: HOSTILE_ORIGIN },
      })
      const response = responses[index]!
      if (response.status >= 500) {
        return serverFailure(response, 'the exchange preflight returned ')
      }
      if (response.status !== 403) {
        return {
          passed: false,
          detail: `the exchange preflight answered ${response.status} instead of refusing the origin`,
          outcome: 'assertion-failed',
        }
      }
      if (response.headers['access-control-allow-origin']) {
        return {
          passed: false,
          detail: 'the exchange preflight allowed an untrusted origin',
          outcome: 'assertion-failed',
        }
      }
      return {
        passed: true,
        detail: 'the exchange preflight refused an untrusted origin',
        outcome: 'refused',
      }
    },
  })

  const outcomes: StepOutcome[] = [signUp]
  for (const step of steps) {
    outcomes.push(await runStep(step))
  }

  // Nothing the Worker answered may carry a secret: not the auth secret, not
  // the database password, not the session cookie, not the authorization code
  // and not the desktop credential.
  const leaked = observedSecrets.filter((secret) => {
    if (!secret) return false
    const occurrences = issuedIn.get(secret) ?? []
    return responses.some((response, index) => {
      const allowed = occurrences.filter((occurrence) => occurrence.index === index)
      return carriesSecret(response, secret, allowed)
    })
  })
  const assertions: DesktopEndpointAssertion[] = [
    ...outcomes.map((outcome) => outcome.assertion),
    {
      name: 'no-response-carries-a-secret',
      passed: leaked.length === 0,
      detail:
        leaked.length === 0
          ? 'no response carried the auth secret, the session cookie, the code or the credential'
          : 'a response carried a value that must never leave the Worker',
      attempts: 1,
      outcomes: [leaked.length === 0 ? 'passed' : 'assertion-failed'],
    },
  ]

  const passed = assertions.filter((assertion) => assertion.passed).length
  const failed = assertions.length - passed
  // The stored receipt is sanitized before it is returned: a receipt is
  // published as the evidence of a run, and a value that the Worker produced
  // must not travel out with it, whatever field it sits in.
  const receipt = sanitizeReceipt(
    {
      status: failed === 0 && passed > 0 ? 'passed' : 'failed',
      proofKind: BUILT_WORKER_DESKTOP_AUTH_PROOF_KIND,
      evidence: input.evidence,
      worker: {
        built: true,
        baseUrl: input.baseUrl,
        routes: [DESKTOP_AUTHORIZE_PATH, DESKTOP_EXCHANGE_PATH],
        artifact: input.artifact,
      },
      assertions,
      passed,
      failed,
      authLifecycle: input.authLifecycle,
      checkout: input.checkout,
      module: input.module,
    },
    [...observedSecrets, ...(input.secrets ?? [])]
  ) as BuiltWorkerDesktopAuthReceipt
  return receipt
}

/**
 * Fails when the receipt does not prove what the qualification promises.
 *
 * The receipt is returned either way: a failed qualification still publishes
 * the assertions it made, how many attempts each made and how every attempt
 * ended, because a failure that cannot be read cannot be acted on. This
 * helper is the fail-closed gate the runner applies.
 */
export function assertBuiltWorkerDesktopAuthPassed(receipt: BuiltWorkerDesktopAuthReceipt): void {
  const failed = receipt.assertions.filter((assertion) => !assertion.passed)
  if (failed.length === 0 && receipt.passed > 0) return
  const names = failed.map((assertion) => assertion.name).join(', ')
  throw new BuiltWorkerFailure(
    'assertion-failed',
    names
      ? `the built-Worker qualification failed: ${names}`
      : 'the built-Worker qualification proved nothing'
  )
}
