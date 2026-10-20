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

/** The route the built Worker serves for a desktop authorization request. */
export const DESKTOP_AUTHORIZE_PATH = '/api/auth/desktop/authorize'

/** The route the built Worker serves for a desktop authorization exchange. */
export const DESKTOP_EXCHANGE_PATH = '/api/auth/desktop/exchange'

/** The redirect the desktop contract names, and the only one the routes accept. */
export const DESKTOP_CALLBACK_URI = 'adea://auth/callback'

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

/** One named assertion and what it found. */
export type DesktopEndpointAssertion = {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

/** The auth lifecycle evidence the receipt carries. */
export type AuthLifecycleEvidence = {
  readonly suite: string
  readonly assertions: readonly string[]
  readonly passed: number
}

/** The receipt the qualification publishes. It carries no credential. */
export type BuiltWorkerDesktopAuthReceipt = {
  readonly status: 'passed'
  readonly proofKind: typeof BUILT_WORKER_DESKTOP_AUTH_PROOF_KIND
  readonly evidence: 'local-disposable' | 'ci' | 'simulated'
  readonly worker: {
    readonly built: true
    readonly baseUrl: string
    readonly routes: readonly string[]
  }
  /** Every assertion the qualification made, in the order it made them. */
  readonly assertions: readonly DesktopEndpointAssertion[]
  /** How many assertions passed. */
  readonly passed: number
  /** How many assertions failed. A passed proof has none. */
  readonly failed: number
  /** The full auth lifecycle assertions, preserved and not reduced to a status. */
  readonly authLifecycle: AuthLifecycleEvidence
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

/** What one step found. */
type StepResult = {
  readonly passed: boolean
  readonly detail: string
  /**
   * True when the step could not be judged because the transport failed. Such
   * a step is retried with fresh material; a step that reached the Worker is
   * judged by the response it produced, refusal included.
   */
  readonly transportFailure?: boolean
}

/** A step the qualification runs. */
type Step = {
  readonly name: string
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
   * The response that issued a value the Worker had to hand out itself. The
   * session cookie, the authorization code and the desktop credential each
   * travel in exactly one response, and the leakage check excludes that one
   * response and no other.
   */
  const issuedIn = new Map<string, number>()

  const send = async (request: BuiltWorkerRequest): Promise<number> => {
    const response = await input.transport(request)
    responses.push(response)
    return responses.length - 1
  }

  /** Records a value the Worker had to hand out, and the response that did. */
  const observeIssued = (value: string, index: number): void => {
    if (!value) return
    observedSecrets.push(value)
    issuedIn.set(value, index)
  }

  /**
   * A step that could not be judged because the transport failed is retried.
   * A response the Worker produced, including a refusal, is never retried.
   */
  const runStep = async (step: Step): Promise<StepOutcome> => {
    let used = 0
    let last: StepResult = { passed: false, detail: 'the step did not run' }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      used = attempt + 1
      try {
        last = await step.run(attempt)
      } catch (error) {
        last = {
          passed: false,
          detail: `the transport failed: ${error instanceof Error ? error.message : 'unknown'}`,
          transportFailure: true,
        }
      }
      if (!last.transportFailure) {
        return {
          assertion: { name: step.name, passed: last.passed, detail: last.detail },
          attempts: used,
        }
      }
    }
    return {
      assertion: { name: step.name, passed: false, detail: last.detail },
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
    run: async () => {
      const index = await send(
        freshAccountSignUpRequest({ baseUrl: input.baseUrl, email, password })
      )
      const response = responses[index]!
      if (response.status >= 500) {
        return {
          passed: false,
          detail: `the sign-up returned ${response.status}`,
          transportFailure: true,
        }
      }
      const cookie = sessionCookieFrom(response)
      if (response.status !== 200 || !cookie) {
        return {
          passed: false,
          detail: `the sign-up did not issue a session cookie (status ${response.status})`,
        }
      }
      sessionCookie = cookie
      observeIssued(cookie, index)
      return { passed: true, detail: 'the built Worker issued a session for a fresh account' }
    },
  })

  const authorizeWithSession = async (): Promise<{
    readonly code: string
    readonly nonce: string
    readonly verifier: string
    readonly status: number
    readonly location: string
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
    const issued = readIssuedAuthorizationCode(location)
    observeIssued(issued.code, index)
    return {
      code: issued.code,
      nonce: issued.nonce || nonce,
      verifier: pkce.verifier,
      status: response.status,
      location: location.split('#')[0] ?? '',
    }
  }

  steps.push({
    name: 'the-desktop-authorize-route-refuses-a-request-without-a-session',
    run: async () => {
      const pkce = desktopPkcePair()
      const { nonce, state } = desktopNonceAndState()
      const index = await send({
        method: 'GET',
        path: desktopAuthorizePath({ challenge: pkce.challenge, nonce, state }),
      })
      const response = responses[index]!
      if (response.status >= 500) {
        return {
          passed: false,
          detail: `the authorize route returned ${response.status}`,
          transportFailure: true,
        }
      }
      const location = response.headers.location ?? ''
      if (response.status !== 303) {
        return {
          passed: false,
          detail: `the authorize route answered ${response.status} instead of refusing the caller`,
        }
      }
      if (!location.includes('/auth/sign-in')) {
        return { passed: false, detail: 'the authorize route did not send the caller to sign in' }
      }
      return { passed: true, detail: 'the authorize route sent the unsigned caller to sign in' }
    },
  })

  steps.push({
    name: 'the-desktop-authorize-route-refuses-an-undefined-parameter',
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
        return {
          passed: false,
          detail: `the authorize route returned ${response.status}`,
          transportFailure: true,
        }
      }
      if (response.status !== 400) {
        return {
          passed: false,
          detail: `the authorize route answered ${response.status} instead of refusing the request`,
        }
      }
      return { passed: true, detail: 'the authorize route refused a parameter it does not define' }
    },
  })

  steps.push({
    name: 'the-desktop-authorize-route-issues-an-authorization-code',
    run: async () => {
      const issued = await authorizeWithSession()
      if (!issued.code) {
        return {
          passed: false,
          detail: `the authorize route answered ${issued.status} at ${issued.location} without an authorization code`,
        }
      }
      return {
        passed: true,
        detail: 'the authorize route issued an authorization code in the completion fragment',
      }
    },
  })

  let exchangedCode = ''
  let exchangedNonce = ''
  let exchangedVerifier = ''

  steps.push({
    name: 'the-desktop-exchange-route-issues-a-session',
    run: async () => {
      const issued = await authorizeWithSession()
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
        return {
          passed: false,
          detail: `the exchange route returned ${response.status}`,
          transportFailure: true,
        }
      }
      if (response.status !== 200) {
        return {
          passed: false,
          detail: `the exchange route answered ${response.status} instead of issuing a session`,
        }
      }
      if (!responseCarriesCredential(response.body)) {
        return { passed: false, detail: 'the exchange route issued no desktop session credential' }
      }
      if (response.headers['access-control-allow-origin'] !== desktopOrigin) {
        return {
          passed: false,
          detail: 'the exchange route did not allow the trusted desktop origin',
        }
      }
      const credential = response.body.match(/"credential"\s*:\s*"([^"]+)"/u)?.[1] ?? ''
      observeIssued(credential, index)
      exchangedCode = issued.code
      exchangedNonce = issued.nonce
      exchangedVerifier = issued.verifier
      return { passed: true, detail: 'the exchange route turned the code into a desktop session' }
    },
  })

  steps.push({
    name: 'the-desktop-exchange-route-refuses-a-wrong-pkce-verifier',
    run: async () => {
      const issued = await authorizeWithSession()
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
        return {
          passed: false,
          detail: `the exchange route returned ${response.status}`,
          transportFailure: true,
        }
      }
      if (response.status !== 400) {
        return {
          passed: false,
          detail: `the exchange route answered ${response.status} instead of refusing the verifier`,
        }
      }
      if (responseCarriesCredential(response.body)) {
        return {
          passed: false,
          detail: 'the exchange route issued a credential for a wrong verifier',
        }
      }
      return { passed: true, detail: 'the exchange route refused a wrong PKCE verifier' }
    },
  })

  steps.push({
    name: 'the-desktop-exchange-route-refuses-an-untrusted-origin',
    run: async () => {
      const issued = await authorizeWithSession()
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
        return {
          passed: false,
          detail: `the exchange route returned ${response.status}`,
          transportFailure: true,
        }
      }
      if (response.status !== 400) {
        return {
          passed: false,
          detail: `the exchange route answered ${response.status} instead of refusing the origin`,
        }
      }
      if (responseCarriesCredential(response.body)) {
        return {
          passed: false,
          detail: 'the exchange route issued a credential for an untrusted origin',
        }
      }
      if (response.headers['access-control-allow-origin']) {
        return {
          passed: false,
          detail: 'the exchange route allowed an untrusted origin in its CORS headers',
        }
      }
      return { passed: true, detail: 'the exchange route refused an untrusted origin' }
    },
  })

  steps.push({
    name: 'the-desktop-exchange-route-refuses-a-replayed-code',
    run: async () => {
      if (!exchangedCode) {
        return { passed: false, detail: 'no exchanged code was available to replay' }
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
        return {
          passed: false,
          detail: `the exchange route returned ${response.status}`,
          transportFailure: true,
        }
      }
      if (response.status !== 400) {
        return {
          passed: false,
          detail: `the exchange route answered ${response.status} instead of refusing the replay`,
        }
      }
      if (responseCarriesCredential(response.body)) {
        return {
          passed: false,
          detail: 'the exchange route issued a second credential for one code',
        }
      }
      return { passed: true, detail: 'the exchange route refused the replayed code' }
    },
  })

  steps.push({
    name: 'the-desktop-exchange-preflight-refuses-an-untrusted-origin',
    run: async () => {
      const index = await send({
        method: 'OPTIONS',
        path: DESKTOP_EXCHANGE_PATH,
        headers: { origin: HOSTILE_ORIGIN },
      })
      const response = responses[index]!
      if (response.status >= 500) {
        return {
          passed: false,
          detail: `the exchange preflight returned ${response.status}`,
          transportFailure: true,
        }
      }
      if (response.status !== 403) {
        return {
          passed: false,
          detail: `the exchange preflight answered ${response.status} instead of refusing the origin`,
        }
      }
      if (response.headers['access-control-allow-origin']) {
        return {
          passed: false,
          detail: 'the exchange preflight allowed an untrusted origin',
        }
      }
      return { passed: true, detail: 'the exchange preflight refused an untrusted origin' }
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
    const allowed = issuedIn.get(secret)
    return responses.some((response, index) => {
      if (index === allowed) return false
      if (response.body.includes(secret)) return true
      return Object.values(response.headers).some((value) => value.includes(secret))
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
    },
  ]

  const passed = assertions.filter((assertion) => assertion.passed).length
  const failed = assertions.length - passed
  const receipt: BuiltWorkerDesktopAuthReceipt = {
    status: 'passed',
    proofKind: BUILT_WORKER_DESKTOP_AUTH_PROOF_KIND,
    evidence: input.evidence,
    worker: {
      built: true,
      baseUrl: input.baseUrl,
      routes: [DESKTOP_AUTHORIZE_PATH, DESKTOP_EXCHANGE_PATH],
    },
    assertions,
    passed,
    failed,
    authLifecycle: input.authLifecycle,
    checkout: input.checkout,
    module: input.module,
  }
  if (failed > 0) {
    // The detail of an assertion is a fixed sentence, never a value the Worker
    // produced, so the failure says what it saw without carrying a credential.
    const failedDetails = assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => `${assertion.name}: ${assertion.detail}`)
      .join('; ')
    throw new Error(`the built-Worker desktop qualification failed: ${failedDetails}`)
  }
  if (passed === 0) {
    throw new Error('the built-Worker desktop qualification proved nothing')
  }
  return receipt
}
