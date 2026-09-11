import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Hosted allowlist acceptance. The caller toggles ADEA_ALLOWED_EMAILS on the
// isolated Worker between phases; this script creates the accounts, records
// their credentials, and asserts the entry/principal decisions.
const evidence = fileURLToPath(new URL('.checks/hosted/', import.meta.url))
const credentials = resolve(evidence, 'allowlist-accounts.json')
await mkdir(evidence, { recursive: true })

const base = process.env.ADEA_ACCEPTANCE_URL
if (!base) throw new Error('Set ADEA_ACCEPTANCE_URL to the isolated acceptance origin')
const origin = new URL(base).origin
const phase = process.argv[2]
if (!['create', 'verify'].includes(phase))
  throw new Error('Usage: acceptance-allowlist.mjs <create|verify>')

const password = `Acc-${randomUUID().slice(0, 18)}`

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
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  }
}
async function call(path, { method = 'GET', body, jar, origin: requestOrigin = origin } = {}) {
  const headers = {}
  if (jar?.header()) headers.cookie = jar.header()
  if (requestOrigin) headers.origin = requestOrigin
  if (body !== undefined) headers['content-type'] = 'application/json'
  const init = { method, headers, redirect: 'manual' }
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`${origin}${path}`, init)
  jar?.apply(response)
  return response
}

if (phase === 'create') {
  // Create both accounts while the allowlist is still unset.
  const listed = `allowlisted+${randomUUID().slice(0, 8)}@example.test`
  const unlisted = `outsider+${randomUUID().slice(0, 8)}@example.test`
  for (const email of [listed, unlisted]) {
    const response = await call('/api/auth/sign-up/email', {
      method: 'POST',
      body: { email, password, name: 'Allowlist Acceptance' },
    })
    assert.equal(response.status, 200, `sign-up for ${email} returned ${response.status}`)
  }
  await writeFile(credentials, JSON.stringify({ listed, unlisted, password }, null, 2) + '\n', {
    mode: 0o600,
  })
  // Only the allowlisted address is printed, so the caller can apply it.
  console.log(listed)
  process.exit(0)
}

const accounts = JSON.parse(await readFile(credentials, 'utf8'))
const results = {}
const record = (name, value, detail) => {
  results[name] = value
  console.log(
    `${value === true ? 'PASS' : value === false ? 'FAIL' : 'INFO'}  ${name}${detail ? ` — ${detail}` : ''}`
  )
}

async function signedInJar(email) {
  const jar = createJar()
  const response = await call('/api/auth/sign-in/email', {
    method: 'POST',
    jar,
    body: { email, password: accounts.password },
  })
  assert.equal(response.status, 200, `sign-in for ${email} returned ${response.status}`)
  return jar
}

// Anonymous entry is redirected to sign-in while the allowlist is active.
{
  const root = await call('/', { origin: null })
  record('allowlist.anonymous_root.redirect', root.status === 307, `HTTP ${root.status}`)
  record('allowlist.anonymous_root.location', root.headers.get('location') === '/auth/sign-in')
  const gate = await call('/api/web-entry', { origin: null })
  record('allowlist.anonymous_gate.status', gate.status === 401, `HTTP ${gate.status}`)
  const bootstrap = await call('/api/workspaces/bootstrap', {
    method: 'POST',
    body: {},
    origin: null,
  })
  record(
    'allowlist.anonymous_bootstrap.status',
    bootstrap.status === 401,
    `HTTP ${bootstrap.status}`
  )
  const signIn = await call('/auth/sign-in', { origin: null })
  record('allowlist.sign_in_document.available', signIn.status === 200, `HTTP ${signIn.status}`)
}

// The allowlisted account is admitted and receives a durable principal.
{
  const jar = await signedInJar(accounts.listed)
  const bootstrap = await call('/api/workspaces/bootstrap', { method: 'POST', jar, body: {} })
  const payload = await bootstrap.json()
  record('allowlist.listed.bootstrap', bootstrap.status === 200, `HTTP ${bootstrap.status}`)
  record('allowlist.listed.durable_principal', payload?.principal?.temporary === false)
  const root = await call('/', { jar })
  const html = await root.text()
  record(
    'allowlist.listed.root_renders_workspace',
    root.status === 200 && !html.includes('early access')
  )
  record(
    'allowlist.listed.no_guest_cookie',
    !root.headers.getSetCookie().some((v) => v.startsWith('agent_hq_temporary_session='))
  )
}

// A signed-in but unlisted account is denied the workspace.
{
  const jar = await signedInJar(accounts.unlisted)
  const bootstrap = await call('/api/workspaces/bootstrap', { method: 'POST', jar, body: {} })
  record(
    'allowlist.unlisted.bootstrap_denied',
    bootstrap.status === 401,
    `HTTP ${bootstrap.status}`
  )
  const root = await call('/', { jar })
  const html = await root.text()
  record('allowlist.unlisted.root_status', root.status === 200, `HTTP ${root.status}`)
  record('allowlist.unlisted.early_access_notice', html.includes('Adea is in early access'))
  record('allowlist.unlisted.no_workspace_shell', !html.includes('conventional-workspace--loading'))
}

await writeFile(
  resolve(evidence, 'allowlist.json'),
  JSON.stringify({ origin, results }, null, 2) + '\n'
)
const failures = Object.entries(results).filter(([, value]) => value === false)
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.map(([key]) => key).join(', ')}`)
  process.exit(1)
}
console.log('\nAll allowlist checks passed.')
