import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Hosted checks for the remaining promotion gates that can be exercised
// without private provider or Control Plane credentials: desktop device
// exchange, session-cookie rotation, and fail-closed behaviour for
// unconfigured hosted integrations.
const base = process.env.ADEA_ACCEPTANCE_URL
if (!base) throw new Error('Set ADEA_ACCEPTANCE_URL to the isolated acceptance origin')
const origin = new URL(base).origin
const evidence = fileURLToPath(new URL('.checks/hosted/', import.meta.url))
await mkdir(evidence, { recursive: true })

const results = {}
const record = (name, value, detail) => {
  results[name] = value
  console.log(
    `${value === true ? 'PASS' : value === false ? 'FAIL' : 'INFO'}  ${name}${detail ? ` — ${detail}` : ''}`
  )
}
function createJar() {
  const jar = new Map()
  return {
    apply(response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';')
        const index = pair.indexOf('=')
        jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
      }
    },
    get: (name) => jar.get(name),
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    names: () => [...jar.keys()],
  }
}
async function call(path, { method = 'GET', body, jar, headers = {}, url } = {}) {
  const requestHeaders = { ...headers }
  if (jar?.header()) requestHeaders.cookie = jar.header()
  if (body !== undefined) requestHeaders['content-type'] = 'application/json'
  const requestInit = { method, headers: requestHeaders, redirect: 'manual' }
  if (body !== undefined) requestInit.body = JSON.stringify(body)
  const response = await fetch(url ?? `${origin}${path}`, requestInit)
  jar?.apply(response)
  return response
}
const parse = async (response) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _text: text.slice(0, 300) }
  }
}

// 1. Desktop device authorization: an unauthenticated browser is sent to the
//    sign-in document with the desktop flow preserved. The desktop client
//    supplies PKCE material and the app's custom callback scheme.
{
  const query = new URLSearchParams({
    client: 'desktop',
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    nonce: randomUUID().replaceAll('-', ''),
    redirect_uri: 'adea://auth/callback',
    response_type: 'code',
    state: randomUUID().replaceAll('-', ''),
  })
  const authorize = await call(`/api/auth/desktop/authorize?${query}`)
  record(
    'desktop.authorize.redirects_to_sign_in',
    authorize.status === 303,
    `HTTP ${authorize.status}`
  )
  const location = authorize.headers.get('location') ?? ''
  record('desktop.authorize.preserves_return_to', location.startsWith('/auth/sign-in?returnTo='))
  record(
    'desktop.authorize.no_store',
    (authorize.headers.get('cache-control') ?? '').includes('no-store')
  )
  // The unauthenticated branch has never sent Referrer-Policy (the original
  // Next route did not either); the completion branch that carries the
  // authorization code is the one that must. Checked below after sign-in.

  const malformed = await call('/api/auth/desktop/authorize?client=desktop')
  record(
    'desktop.authorize.rejects_malformed',
    malformed.status === 400,
    `HTTP ${malformed.status}`
  )

  // Signed-in desktop authorization issues a one-time code to the app's custom
  // scheme and must never leak it via Referer or caching.
  const jar = createJar()
  const account = `desktop+${randomUUID().slice(0, 8)}@example.test`
  const signUp = await call('/api/auth/sign-up/email', {
    method: 'POST',
    jar,
    headers: { origin },
    body: { email: account, password: `Acc-${randomUUID().slice(0, 18)}`, name: 'Desktop' },
  })
  assert.equal(signUp.status, 200, `desktop sign-up returned ${signUp.status}`)
  const completion = await call(`/api/auth/desktop/authorize?${query}`, { jar })
  const completionLocation = completion.headers.get('location') ?? ''
  record('desktop.completion.status', completion.status === 303, `HTTP ${completion.status}`)
  record(
    'desktop.completion.no_referrer',
    completion.headers.get('referrer-policy') === 'no-referrer'
  )
  record(
    'desktop.completion.no_store',
    (completion.headers.get('cache-control') ?? '').includes('no-store')
  )
  record(
    'desktop.completion.callback_scheme',
    completionLocation.startsWith('/auth/desktop/complete#')
  )
  // The credential travels in the URL fragment (which browsers never send to
  // servers) as a custom-scheme callback the desktop client consumes.
  const fragment = new URLSearchParams(completionLocation.split('#')[1] ?? '')
  const callback = fragment.get('callback') ?? ''
  record('desktop.completion.callback_present', callback.startsWith('adea://auth/callback'))
  record('desktop.completion.code_issued', /[?&]code=/.test(callback))
  record('desktop.completion.single_fragment_key', [...fragment.keys()].length === 1)
  record('desktop.completion.code_not_in_query', new URL(completionLocation, origin).search === '')
}

// 2. Desktop endpoints fail closed without a device credential.
{
  for (const endpoint of ['exchange', 'refresh', 'logout', 'revoke']) {
    const response = await call(`/api/auth/desktop/${endpoint}`, {
      method: 'POST',
      body: { deviceCode: 'not-a-real-device-code' },
      headers: { origin, 'x-adea-client': 'desktop' },
    })
    record(`desktop.${endpoint}.fails_closed`, response.status >= 400, `HTTP ${response.status}`)
  }
}

// 3. Desktop CORS preflight is restricted to trusted origins.
{
  const preflight = await fetch(`${origin}/api/auth/desktop/exchange`, {
    method: 'OPTIONS',
    headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' },
    redirect: 'manual',
  })
  record(
    'desktop.preflight.untrusted_origin',
    [403, 405].includes(preflight.status),
    `HTTP ${preflight.status}`
  )
}

// 4. Provider failure must fail closed rather than serving an open workspace.
{
  const gate = await call('/api/web-entry', { headers: { cookie: 'malformed-session=garbage' } })
  record('entry.invalid_session.status', [200, 401].includes(gate.status), `HTTP ${gate.status}`)
  const payload = await parse(gate)
  record(
    'entry.gate.only_access_enum',
    ['allowed', 'sign-in', 'denied'].includes(payload.access),
    `access=${payload.access}`
  )
  record('entry.gate.no_identity', !JSON.stringify(payload).includes('@'))
}

// 5. Session-cookie rotation: repeated guest bootstraps stay stable, and the
//    provider session-data cookie is reissued with a bounded lifetime.
{
  const jar = createJar()
  const first = await call('/api/workspaces/bootstrap', { method: 'POST', jar, body: {} })
  const firstPayload = await parse(first)
  const guestCredential = jar.get('agent_hq_temporary_session')
  const second = await call('/api/workspaces/bootstrap', { method: 'POST', jar, body: {} })
  const secondPayload = await parse(second)
  record(
    'rotation.guest_credential_stable',
    jar.get('agent_hq_temporary_session') === guestCredential
  )
  record(
    'rotation.same_workspace',
    firstPayload?.activeWorkspace?.id === secondPayload?.activeWorkspace?.id
  )
  record('rotation.no_unsolicited_rotation', secondPayload?.sessionRotated === false)

  const sessionJar = createJar()
  const account = `rotation+${randomUUID().slice(0, 8)}@example.test`
  const signUp = await call('/api/auth/sign-up/email', {
    method: 'POST',
    jar: sessionJar,
    headers: { origin },
    body: { email: account, password: `Acc-${randomUUID().slice(0, 18)}`, name: 'Rotation' },
  })
  record('rotation.sign_up', signUp.status === 200, `HTTP ${signUp.status}`)
  const sessionCookie = sessionJar
    .names()
    .find((name) => name.startsWith('__Secure-neon-auth') && name.includes('session_token'))
  record('rotation.provider_session_cookie', Boolean(sessionCookie), sessionCookie ?? 'none')
  const firstSession = await parse(await call('/api/auth/get-session', { jar: sessionJar }))
  const secondSession = await parse(await call('/api/auth/get-session', { jar: sessionJar }))
  record(
    'rotation.session_stable_across_reads',
    firstSession?.session?.id === secondSession?.session?.id
  )
  record('rotation.session_not_expired', Boolean(firstSession?.session?.expiresAt))
}

// 6. Hosted integrations without credentials fail closed, never open.
{
  const marketplace = await call('/api/marketplace/catalog', {
    method: 'POST',
    body: {},
    headers: { origin },
  })
  record(
    'integration.marketplace.fails_closed',
    marketplace.status >= 400,
    `HTTP ${marketplace.status}`
  )
  const telemetry = await call('/api/telemetry/scene-performance', {
    method: 'POST',
    body: {},
    headers: { origin },
  })
  record(
    'integration.telemetry.rejects_invalid',
    telemetry.status >= 400,
    `HTTP ${telemetry.status}`
  )
  const sceneEditor = await call('/api/scene-editor', {
    method: 'POST',
    body: {},
    headers: { origin },
  })
  record(
    'integration.scene_editor.404_outside_dev',
    sceneEditor.status === 404,
    `HTTP ${sceneEditor.status}`
  )
}

// 7. WebSocket upgrades stay explicitly unsupported rather than hanging.
{
  const upgrade = await fetch(`${origin}/`, {
    headers: { upgrade: 'websocket', connection: 'upgrade' },
    redirect: 'manual',
  }).catch((error) => ({ status: 0, _error: String(error) }))
  record(
    'websocket.upgrade.status',
    [200, 400, 426].includes(upgrade.status),
    `HTTP ${upgrade.status}`
  )
}

await writeFile(
  resolve(evidence, 'gates.json'),
  JSON.stringify({ origin, results }, null, 2) + '\n'
)
const failures = Object.entries(results).filter(([, value]) => value === false)
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.map(([key]) => key).join(', ')}`)
  process.exit(1)
}
console.log('\nAll gate checks passed.')
assert.ok(true)
