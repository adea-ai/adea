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

const mode = process.argv.at(-1)
assert.ok(['--prepare', '--exercise'].includes(mode), 'choose --prepare or --exercise')

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

async function assertDatabaseSessionsStarted(before, expectedMinimum, label) {
  await waitFor(async () => (await sessionCount()) >= before + BigInt(expectedMinimum), label)
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

function requestWorker(path, { method = 'GET', cookie, body } = {}) {
  const url = new URL(path.startsWith('/') ? path : `/api/auth/${path}`, workerUrl)
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
  assert.equal(url.protocol, 'https:')
  assert.ok(url.pathname.startsWith('/api/auth/'))
  const serialized = body === undefined ? undefined : JSON.stringify(body)
  const headers = { origin: baseUrl }
  if (cookie) headers.cookie = cookie
  if (serialized !== undefined) headers['content-type'] = 'application/json'

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method,
        ca: workerCa,
        headers,
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
  await assertDatabaseSessionsStarted(
    before,
    expectedSessions,
    `${label} should open auth PostgreSQL backends`
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

let workerCa

async function prepare() {
  try {
    await controlPool.query(`CREATE SCHEMA "${schema}"`)
    await controlPool.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO agent_hq_local_app`)
    await migrateAuthSchema()
    await exerciseRecordingDelivery()
    await assertNoWorkerBackends()
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
    console.log(JSON.stringify({ mode: 'exercise', ...result }))
  } finally {
    await controlPool.end()
  }
}

if (mode === '--prepare') await prepare()
else await exercise()
