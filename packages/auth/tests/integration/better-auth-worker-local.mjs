import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { getMigrations } from 'better-auth/db/migration'

import { handleBetterAuthRequest } from '../../src/better-auth-server.ts'
import { createBetterAuthService } from '../../src/server.ts'
import { createRecordingAuthDelivery } from '../../src/delivery.ts'
import { describeResponse } from './response-evidence.mjs'

const mode = process.argv.at(-1)
assert.ok(
  ['--prepare', '--exercise', '--fixture-exercise'].includes(mode),
  'choose --prepare, --exercise or --fixture-exercise'
)

const baseUrl = process.env.AUTH_BASE_URL
const databaseUrl = process.env.AUTH_POSTGRES_TEST_URL
const workerDatabaseUrl = process.env.AUTH_DATABASE_URL
const schema = process.env.AUTH_TEST_SCHEMA
const workerApplicationName = process.env.AUTH_WORKER_APPLICATION_NAME
const workerUrl = process.env.ADEA_AUTH_WORKER_URL
const caPath = process.env.ADEA_AUTH_WORKER_CA
const secret = process.env.AUTH_SECRET
const trustedOrigins = process.env.AUTH_TRUSTED_ORIGINS

for (const [label, value] of Object.entries({
  AUTH_BASE_URL: baseUrl,
  AUTH_POSTGRES_TEST_URL: databaseUrl,
  AUTH_DATABASE_URL: workerDatabaseUrl,
  AUTH_TEST_SCHEMA: schema,
  AUTH_WORKER_APPLICATION_NAME: workerApplicationName,
  AUTH_SECRET: secret,
  AUTH_TRUSTED_ORIGINS: trustedOrigins,
})) {
  assert.ok(value, `${label} is required`)
}

function assertLoopbackUrl(raw, label) {
  const url = new URL(raw)
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), `${label} must be loopback`)
  return url
}

const localDatabaseUrl = assertLoopbackUrl(databaseUrl, 'AUTH_POSTGRES_TEST_URL')
assert.equal(localDatabaseUrl.protocol, 'postgresql:')
const workerDatabase = assertLoopbackUrl(workerDatabaseUrl, 'AUTH_DATABASE_URL')
assert.equal(workerDatabase.username, 'agent_hq_local_app')
assert.match(schema, /^auth_worker_[a-f0-9]{32}$/)
assert.match(workerApplicationName, /^adea_auth_worker_[a-f0-9]{12}$/)
assert.equal(trustedOrigins, baseUrl)
assert.equal(new URL(baseUrl).protocol, 'https:')

function databaseUrlWithApplicationName(applicationName) {
  const url = new URL(workerDatabaseUrl)
  assert.equal(url.hostname, localDatabaseUrl.hostname)
  assert.equal(url.port, localDatabaseUrl.port)
  assert.equal(url.pathname, localDatabaseUrl.pathname)
  assert.equal(url.searchParams.get('options'), `-c search_path=${schema}`)
  url.searchParams.set('application_name', applicationName)
  return url.toString()
}

const controlPool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: `${workerApplicationName}_control`,
})

async function assertNoWorkerBackends() {
  const result = await controlPool.query(
    `SELECT pid, usename, application_name, state, backend_type
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND usename = $1
       AND pid <> pg_backend_pid()
       AND application_name IS DISTINCT FROM $2
     ORDER BY pid`,
    [workerDatabase.username, `${workerApplicationName}_control`]
  )
  assert.deepEqual(
    result.rows,
    [],
    `each auth request must close its owned PostgreSQL backend; remaining backends: ${JSON.stringify(result.rows)}`
  )
  return true
}

async function sessionCount() {
  const result = await controlPool.query(
    `SELECT sessions::text AS sessions
     FROM pg_stat_database
     WHERE datname = current_database()`
  )
  assert.ok(result.rows[0]?.sessions, 'PostgreSQL session statistics must be available')
  return BigInt(result.rows[0].sessions)
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await delay(40)
  }
  if (lastError) throw new Error(`${description}: ${lastError.message}`, { cause: lastError })
  throw new Error(`${description} did not complete within ${timeoutMs} ms`)
}

async function assertDatabaseSessionsStarted(before, expectedMinimum, label, observed = []) {
  try {
    await waitFor(async () => (await sessionCount()) >= before + BigInt(expectedMinimum), label)
  } catch (error) {
    // Diagnostic only: the same assertion fails; the counter values make the timeout readable.
    const after = await sessionCount().catch(() => 'unreadable')
    const activity = await controlPool
      .query(
        `SELECT usename, application_name, state, backend_type, backend_start::text AS started
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
         ORDER BY backend_start`
      )
      .then((result) => JSON.stringify(result.rows))
      .catch(() => 'unreadable')
    throw new Error(
      `${error.message}; pg_stat_database sessions before ${before}, after ${after}, expected +${expectedMinimum}; activity ${activity}; responses ${JSON.stringify(observed)}`,
      { cause: error }
    )
  }
}

async function migrateAuthSchema() {
  const service = createBetterAuthService(
    {
      ...process.env,
      AUTH_DATABASE_URL: databaseUrlWithApplicationName(`${workerApplicationName}_setup`),
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'false',
      AUTH_SECURE_COOKIES: 'true',
    },
    createRecordingAuthDelivery().delivery
  )
  try {
    const options = service.auth.options
    const migrations = await getMigrations(options)
    assert.ok(
      migrations.toBeCreated.some(({ table }) => table === 'session'),
      'Better Auth session table migration should be pending in the isolated schema'
    )
    await migrations.runMigrations()
  } finally {
    await service.close()
  }
}

async function exerciseRecordingDelivery() {
  const recorder = createRecordingAuthDelivery()
  const service = createBetterAuthService(
    {
      ...process.env,
      AUTH_DATABASE_URL: databaseUrlWithApplicationName(`${workerApplicationName}_delivery`),
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'true',
      AUTH_SECURE_COOKIES: 'true',
    },
    recorder.delivery
  )
  const email = `worker-delivery-${randomUUID()}@example.test`
  try {
    const response = await handleBetterAuthRequest(
      service.auth,
      'POST',
      new Request(`${baseUrl}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: baseUrl },
        body: JSON.stringify({
          email,
          name: 'Local Delivery Fixture',
          password: 'Local-only-password-123!',
        }),
      }),
      service.config
    )
    const payload = await response.json().catch(() => null)
    assert.equal(
      response.status,
      200,
      `synthetic delivery signup failed: ${JSON.stringify(payload)}`
    )
    assert.equal(recorder.sent.length, 1)
    assert.equal(recorder.sent[0]?.kind, 'verification')
    assert.equal(recorder.sent[0]?.email, email)
    assert.equal(new URL(recorder.sent[0].url).origin, baseUrl)
  } finally {
    await service.close()
  }
}

// Every request opens its own connection. Reusing a keep-alive socket through the local dev proxy
// failed intermittently with "Network connection lost" on the next POST (6 of 12 reused runs,
// 0 of 6 fresh runs), so the transport is kept out of the auth assertions.
function requestWorker(path, { method = 'GET', cookie, body, origin = baseUrl } = {}) {
  const url = new URL(path.startsWith('/') ? path : `/api/auth/${path}`, workerUrl)
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
  assert.equal(url.protocol, 'https:')
  assert.ok(url.pathname.startsWith('/api/auth/'))
  const serialized = body === undefined ? undefined : JSON.stringify(body)
  const headers = { origin }
  if (cookie) headers.cookie = cookie
  if (serialized !== undefined) headers['content-type'] = 'application/json'

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method,
        ca: workerCa,
        headers,
        agent: false,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = text ? JSON.parse(text) : undefined
          } catch {
            json = undefined
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            json,
            text,
          })
        })
      }
    )
    request.setTimeout(15_000, () =>
      request.destroy(new Error(`Timed out: ${method} ${url.pathname}`))
    )
    request.once('error', reject)
    if (serialized !== undefined) request.write(serialized)
    request.end()
  })
}

function responseCookies(response) {
  const raw = response.headers['set-cookie']
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  return values
    .map((cookie) => cookie.split(';', 1)[0])
    .filter(Boolean)
    .join('; ')
}

async function trackedWorkerRequest(label, requests, expectedSessions = requests.length) {
  const before = await sessionCount()
  const results = await Promise.all(requests.map((request) => requestWorker(...request)))
  // Captured before the database wait, so a proxy-level failure is distinguishable from database inactivity.
  const observed = results.map(describeResponse)
  await assertDatabaseSessionsStarted(
    before,
    expectedSessions,
    `${label} should open auth PostgreSQL backends`,
    observed
  )
  await waitFor(assertNoWorkerBackends, `${label} should close every auth PostgreSQL backend`)
  return results
}

async function assertSession(email, cookie, label) {
  const [response] = await trackedWorkerRequest(label, [
    ['get-session?disableCookieCache=true', { cookie }],
  ])
  assert.equal(response.status, 200, `${label}: ${response.text}`)
  assert.equal(response.json?.user?.email, email, `${label} must resolve only its cookie's user`)
  assert.ok(response.json?.session?.id, `${label} must return a persisted session`)
  return response.json.session.id
}

async function assertNoSession(cookie, label) {
  const [response] = await trackedWorkerRequest(label, [
    ['get-session?disableCookieCache=true', { cookie }],
  ])
  assert.equal(response.status, 200, `${label}: ${response.text}`)
  assert.equal(response.json, null, `${label} should observe the revocation from PostgreSQL`)
}

async function exerciseWorker() {
  assert.ok(workerUrl, 'ADEA_AUTH_WORKER_URL is required for --exercise')
  assert.ok(caPath, 'ADEA_AUTH_WORKER_CA is required for --exercise')
  // Trust only this run's minted loopback certificate for its local Worker.
  workerCa = await readFile(caPath)
  const testUrl = assertLoopbackUrl(workerUrl, 'ADEA_AUTH_WORKER_URL')
  assert.equal(testUrl.protocol, 'https:')
  assert.equal(testUrl.hostname, '127.0.0.1')
  const control = await controlPool.connect()
  control.release()
  const auditPool = new Pool({
    connectionString: databaseUrlWithApplicationName(`${workerApplicationName}_control`),
    max: 1,
  })
  let auditPoolEnded = false

  try {
    const passwordA = `Local-A-${randomUUID()}!`
    const passwordB = `Local-B-${randomUUID()}!`
    const emailA = `worker-a-${randomUUID()}@example.test`
    const emailB = `worker-b-${randomUUID()}@example.test`
    const [signupA, signupB] = await trackedWorkerRequest('parallel signups', [
      [
        'sign-up/email',
        { method: 'POST', body: { name: 'Worker User A', email: emailA, password: passwordA } },
      ],
      [
        'sign-up/email',
        { method: 'POST', body: { name: 'Worker User B', email: emailB, password: passwordB } },
      ],
    ])
    assert.equal(signupA.status, 200, `signup A: ${signupA.text}`)
    assert.equal(signupB.status, 200, `signup B: ${signupB.text}`)
    const cookieA = responseCookies(signupA)
    const cookieB = responseCookies(signupB)
    assert.ok(cookieA, 'signup A should issue its own cookie set')
    assert.ok(cookieB, 'signup B should issue its own cookie set')
    assert.notEqual(cookieA, cookieB, 'independent signups must not share cookies')
    assert.match(signupA.headers['set-cookie']?.join(';') ?? '', /HttpOnly/i)
    assert.match(signupA.headers['set-cookie']?.join(';') ?? '', /Secure/i)

    const [sessionAResponse, sessionBResponse] = await trackedWorkerRequest(
      'parallel session reads',
      [
        ['get-session?disableCookieCache=true', { cookie: cookieA }],
        ['get-session?disableCookieCache=true', { cookie: cookieB }],
      ]
    )
    assert.equal(sessionAResponse.status, 200, sessionAResponse.text)
    assert.equal(sessionBResponse.status, 200, sessionBResponse.text)
    assert.equal(sessionAResponse.json?.user?.email, emailA)
    assert.equal(sessionBResponse.json?.user?.email, emailB)
    assert.notEqual(sessionAResponse.json?.session?.id, sessionBResponse.json?.session?.id)
    const sessionA = sessionAResponse.json.session.id
    const sessionB = sessionBResponse.json.session.id

    const [signinA] = await trackedWorkerRequest('second account A sign-in', [
      ['sign-in/email', { method: 'POST', body: { email: emailA, password: passwordA } }],
    ])
    assert.equal(signinA.status, 200, `second sign-in: ${signinA.text}`)
    const cookieA2 = responseCookies(signinA)
    assert.ok(cookieA2)
    assert.notEqual(cookieA2, cookieA)
    const sessionA2 = await assertSession(emailA, cookieA2, 'second account A session')
    assert.notEqual(sessionA2, sessionA)

    const [revoke] = await trackedWorkerRequest('revoke account A sessions', [
      ['revoke-sessions', { method: 'POST', cookie: cookieA2, body: {} }],
    ])
    assert.equal(revoke.status, 200, `revoke account A sessions: ${revoke.text}`)
    assert.equal(revoke.json?.status, true)
    await assertNoSession(cookieA, 'account A first session after revoke')
    await assertNoSession(cookieA2, 'account A second session after revoke')
    assert.equal(
      await assertSession(emailB, cookieB, 'account B isolation after account A revoke'),
      sessionB
    )

    const [logout] = await trackedWorkerRequest('logout account B', [
      ['sign-out', { method: 'POST', cookie: cookieB, body: {} }],
    ])
    assert.equal(logout.status, 200, `logout account B: ${logout.text}`)
    assert.equal(logout.json?.success, true)
    await assertNoSession(cookieB, 'account B session after logout')

    const persisted = await auditPool.query(
      `SELECT id FROM "${schema}"."session" WHERE id = ANY($1::text[])`,
      [[sessionA, sessionA2, sessionB]]
    )
    assert.equal(
      persisted.rowCount,
      0,
      'revoked and logged-out sessions must be absent from PostgreSQL'
    )
    await auditPool.end()
    auditPoolEnded = true
    await assertNoWorkerBackends()

    return {
      concurrentSignups: 2,
      isolatedAuthenticatedSessions: 2,
      revokedAccountASessions: 2,
      loggedOutAccountBSessions: 1,
      workerBackendsLeftOpen: 0,
    }
  } finally {
    if (!auditPoolEnded) await auditPool.end()
  }
}

// Production bundle, fail-closed only. The built Worker has no verification or reset
// transport, so a reset request must be answered generically, issue no session, and
// deliver nothing. Completing a reset from a token read out of PostgreSQL is not
// delivery, so it is not asserted here; the fixture acceptance covers reset through
// a recorded message instead.
async function exerciseFailClosedReset() {
  const email = `worker-reset-${randomUUID()}@example.test`
  const password = `Local-C-${randomUUID()}!`
  const [signup] = await trackedWorkerRequest('reset fixture signup', [
    ['sign-up/email', { method: 'POST', body: { name: 'Worker Reset', email, password } }],
  ])
  assert.equal(signup.status, 200, `reset fixture signup: ${signup.text}`)

  const [requested] = await trackedWorkerRequest('password reset request', [
    ['request-password-reset', { method: 'POST', body: { email, redirectTo: `${baseUrl}/reset` } }],
  ])
  assert.equal(requested.status, 200, `reset request: ${requested.text}`)
  assert.match(requested.headers['cache-control'] ?? '', /no-store/)
  assert.equal(responseCookies(requested), '', 'a reset request must not issue a session')

  // Refused before the handler runs, so no database backend is expected to open.
  const hostile = await requestWorker('request-password-reset', {
    method: 'POST',
    body: { email, redirectTo: `${baseUrl}/reset` },
    origin: 'https://evil.example.test',
  })
  assert.equal(hostile.status, 403, `hostile origin: ${hostile.text}`)
  assert.match(hostile.headers['cache-control'] ?? '', /no-store/)

  return {
    passwordResetFailClosed: 'passed',
    hostileOriginRefused: true,
  }
}

let workerCa

async function prepare() {
  try {
    await controlPool.query(`CREATE SCHEMA "${schema}"`)
    await controlPool.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO agent_hq_local_app`)
    await migrateAuthSchema()
    await exerciseRecordingDelivery()
    // The in-process delivery pool's backend can still be listed for a moment after its close() resolves.
    // The same assertion runs inside the existing bounded wait, so a backend that never closes still fails.
    await waitFor(assertNoWorkerBackends, 'the in-process delivery backend should close')
    console.log(
      JSON.stringify({
        mode: 'prepare',
        schema,
        migrations: 'passed',
        syntheticDelivery: 'recorded locally',
      })
    )
  } finally {
    await controlPool.end()
  }
}

async function exercise() {
  try {
    const result = await exerciseWorker()
    const reset = await exerciseFailClosedReset()
    console.log(JSON.stringify({ mode: 'exercise', ...result, ...reset }))
  } finally {
    await controlPool.end()
  }
}

// Fixture composition only. The Worker was built with the loopback recording
// transport (vite.auth-fixture.config.ts) and the harness owns the outbox. Messages
// are read from that outbox, and the delivered links are followed through the
// Worker. Nothing here touches production configuration.
const outboxUrl = process.env.ADEA_AUTH_FIXTURE_OUTBOX_URL

async function outboxMessages(email, kind) {
  assert.ok(outboxUrl, 'ADEA_AUTH_FIXTURE_OUTBOX_URL is required for --fixture-exercise')
  const response = await fetch(new URL('/messages', outboxUrl))
  assert.equal(response.status, 200)
  const all = await response.json()
  return all.filter((entry) => entry.email === email && (kind === undefined || entry.kind === kind))
}

async function waitForOutbox(email, kind, count) {
  await waitFor(
    async () => (await outboxMessages(email, kind)).length >= count,
    `${kind} message for ${email} should be delivered`
  )
  return await outboxMessages(email, kind)
}

async function exerciseRequiredEmailFixture() {
  const tokenPool = new Pool({
    connectionString: databaseUrlWithApplicationName(`${workerApplicationName}_control`),
    max: 1,
  })
  try {
    return await runRequiredEmailFixture(tokenPool)
  } finally {
    await tokenPool.end()
  }
}

async function runRequiredEmailFixture(tokenPool) {
  const email = `fixture-${randomUUID()}@example.test`
  const password = `Fixture-A-${randomUUID()}!`
  const nextPassword = `Fixture-B-${randomUUID()}!`
  const failing = `fail+${randomUUID()}@example.test`

  // 1. Required-email signup emits exactly one verification message and no session.
  const [signup] = await trackedWorkerRequest('required-email signup', [
    ['sign-up/email', { method: 'POST', body: { name: 'Fixture User', email, password } }],
  ])
  assert.equal(signup.status, 200, `required-email signup: ${signup.text}`)
  assert.equal(
    responseCookies(signup),
    '',
    'a verification-required signup must not issue a session'
  )
  const [verification] = await waitForOutbox(email, 'verification', 1)
  await delay(300)
  assert.equal((await outboxMessages(email)).length, 1, 'signup must emit exactly one message')
  assert.equal(verification.kind, 'verification')
  assert.ok(verification.token, 'the delivered message must carry its token')
  assert.equal(new URL(verification.url).origin, baseUrl)

  // 2. Unverified sign-in is refused and issues no session.
  const [blocked] = await trackedWorkerRequest('unverified sign-in', [
    ['sign-in/email', { method: 'POST', body: { email, password } }],
  ])
  assert.notEqual(blocked.status, 200, 'an unverified account must not sign in')
  assert.equal(responseCookies(blocked), '')

  // 3. Following the delivered link verifies the account and issues a session.
  const link = new URL(verification.url)
  const [verified] = await trackedWorkerRequest('follow the delivered verification link', [
    [`${link.pathname}${link.search}`, { method: 'GET' }],
  ])
  assert.ok([200, 302].includes(verified.status), `verification link: ${verified.status}`)
  const verifiedCookie = responseCookies(verified)
  assert.ok(verifiedCookie, 'the delivered link must issue a session')
  await assertSession(email, verifiedCookie, 'session from the delivered link')
  assert.equal((await outboxMessages(email)).length, 1, 'verifying must not emit another message')

  // 5. Reset uses a recorded message, and a hostile origin delivers nothing.
  const [requested] = await trackedWorkerRequest('password reset request', [
    ['request-password-reset', { method: 'POST', body: { email, redirectTo: `${baseUrl}/reset` } }],
  ])
  assert.equal(requested.status, 200, `reset request: ${requested.text}`)
  assert.match(requested.headers['cache-control'] ?? '', /no-store/)
  assert.equal(responseCookies(requested), '', 'a reset request must not issue a session')
  const [reset] = await waitForOutbox(email, 'password-reset', 1)
  const hostile = await requestWorker('request-password-reset', {
    method: 'POST',
    body: { email, redirectTo: `${baseUrl}/reset` },
    origin: 'https://evil.example.test',
  })
  assert.equal(hostile.status, 403)
  await delay(300)
  assert.equal(
    (await outboxMessages(email, 'password-reset')).length,
    1,
    'a hostile origin delivers nothing'
  )

  // 6. The recorded reset token completes once, revokes the verified session, and is single-use.
  const [applied] = await trackedWorkerRequest('reset with the recorded token', [
    ['reset-password', { method: 'POST', body: { newPassword: nextPassword, token: reset.token } }],
  ])
  assert.equal(applied.status, 200, `reset: ${applied.text}`)
  await assertNoSession(verifiedCookie, 'verified session after the password reset')
  const [replay] = await trackedWorkerRequest('reset token replay', [
    [
      'reset-password',
      { method: 'POST', body: { newPassword: `Fixture-C-${randomUUID()}!`, token: reset.token } },
    ],
  ])
  assert.notEqual(replay.status, 200, 'a reset token must be single-use')
  const [stale] = await trackedWorkerRequest('old password after reset', [
    ['sign-in/email', { method: 'POST', body: { email, password } }],
  ])
  assert.notEqual(stale.status, 200, 'the old password must stop working')
  const [current] = await trackedWorkerRequest('new password after reset', [
    ['sign-in/email', { method: 'POST', body: { email, password: nextPassword } }],
  ])
  assert.equal(current.status, 200, `new password sign-in: ${current.text}`)
  assert.ok(responseCookies(current), 'the new password must issue a session')

  // 7. Expiry: a second recorded token, expired in the isolated schema, is refused and changes nothing.
  const [second] = await trackedWorkerRequest('second password reset request', [
    ['request-password-reset', { method: 'POST', body: { email, redirectTo: `${baseUrl}/reset` } }],
  ])
  assert.equal(second.status, 200)
  const resets = await waitForOutbox(email, 'password-reset', 2)
  const expiring = resets.at(-1)
  await tokenPool.query(
    `UPDATE "${schema}"."verification" SET "expiresAt" = now() - interval '1 minute' WHERE identifier = $1`,
    [`reset-password:${expiring.token}`]
  )
  const [expired] = await trackedWorkerRequest('expired reset token', [
    [
      'reset-password',
      {
        method: 'POST',
        body: { newPassword: `Fixture-D-${randomUUID()}!`, token: expiring.token },
      },
    ],
  ])
  assert.notEqual(expired.status, 200, 'an expired reset token must be refused')
  const [unchanged] = await trackedWorkerRequest('password after expired token', [
    ['sign-in/email', { method: 'POST', body: { email, password: nextPassword } }],
  ])
  assert.equal(unchanged.status, 200, 'an expired token must leave the password unchanged')

  // 8. Delivery failure, run last: the transport refuses, so nothing is recorded and no session issues.
  const [refused] = await trackedWorkerRequest('refused delivery signup', [
    ['sign-up/email', { method: 'POST', body: { name: 'Refused User', email: failing, password } }],
  ])
  assert.equal(refused.status, 200, `refused delivery signup: ${refused.text}`)
  assert.equal(responseCookies(refused), '', 'a refused delivery must not issue a session')
  await delay(500)
  assert.equal((await outboxMessages(failing)).length, 0, 'a refused delivery records nothing')

  // Each check above throws on failure, so reaching this return means they all passed.
  // The counts are read back from the outbox at the end.
  return {
    verificationMessagesForAccount: (await outboxMessages(email, 'verification')).length,
    resetMessagesForAccount: (await outboxMessages(email, 'password-reset')).length,
    refusedDeliveryMessages: (await outboxMessages(failing)).length,
  }
}

async function fixtureExercise() {
  assert.ok(caPath, 'ADEA_AUTH_WORKER_CA is required for --fixture-exercise')
  // Trust only this run's minted loopback certificate for its local fixture Worker.
  workerCa = await readFile(caPath)
  try {
    const result = await exerciseRequiredEmailFixture()
    console.log(JSON.stringify({ mode: 'fixture-exercise', ...result }))
  } finally {
    await controlPool.end()
  }
}

if (mode === '--prepare') await prepare()
else if (mode === '--fixture-exercise') await fixtureExercise()
else await exercise()
