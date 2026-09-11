import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Hosted acceptance for the account/session flows the migration gates on.
// Runs against an isolated Worker + Neon branch; never production.
const base = process.env.ADEA_ACCEPTANCE_URL
if (!base) throw new Error('Set ADEA_ACCEPTANCE_URL to the isolated acceptance origin')
const origin = new URL(base).origin
const evidence = fileURLToPath(new URL('.checks/hosted/', import.meta.url))
await mkdir(evidence, { recursive: true })

const results = {}
function record(name, value, detail) {
  results[name] = value
  console.log(
    `${value === true ? 'PASS' : value === false ? 'FAIL' : 'INFO'}  ${name}${detail ? ` — ${detail}` : ''}`
  )
}

/** Minimal cookie jar so we exercise the real Set-Cookie contract. */
function createJar() {
  const jar = new Map()
  return {
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    apply(response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';')
        const index = pair.indexOf('=')
        jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
      }
    },
    clear: () => jar.clear(),
    names: () => [...jar.keys()],
  }
}

async function call(path, { method = 'GET', body, jar, headers = {}, redirect = 'manual' } = {}) {
  const requestHeaders = { ...headers }
  if (jar?.header()) requestHeaders.cookie = jar.header()
  if (body !== undefined && !requestHeaders['content-type'])
    requestHeaders['content-type'] = 'application/json'
  else if (body !== undefined) requestHeaders['content-type'] ??= 'application/json'
  const init = { method, headers: requestHeaders, redirect }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const response = await fetch(`${origin}${path}`, init)
  jar?.apply(response)
  return response
}

const json = async (response) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _text: text.slice(0, 400) }
  }
}

// 1. Session cookies carry production-grade attributes.
{
  const jar = createJar()
  const response = await call('/api/workspaces/bootstrap', { method: 'POST', jar, body: {} })
  const setCookies = response.headers.getSetCookie()
  const temporary = setCookies.find((value) => value.startsWith('agent_hq_temporary_session='))
  record('guest.bootstrap.status', response.status === 200, `HTTP ${response.status}`)
  record('guest.temporary_cookie.httpOnly', Boolean(temporary?.includes('HttpOnly')))
  record('guest.temporary_cookie.sameSite', /SameSite=Lax/i.test(temporary ?? ''))
  record('guest.temporary_cookie.secure', /;\s*Secure/i.test(temporary ?? ''))
  record('guest.temporary_cookie.path', /Path=\//i.test(temporary ?? ''))
  const payload = await json(response)
  record('guest.bootstrap.payload', typeof payload.activeWorkspace?.id === 'string')
}

// 2. Session rotation: an unknown credential mints a new guest session.
{
  const jar = createJar()
  const response = await call('/api/workspaces/bootstrap', {
    method: 'POST',
    jar,
    body: {},
    headers: { cookie: 'agent_hq_temporary_session=adea_tmp_' + 'z'.repeat(43) },
  })
  const payload = await json(response)
  record(
    'guest.rotation.flag',
    payload.sessionRotated === true,
    `sessionRotated=${payload.sessionRotated}`
  )
  record('guest.rotation.temporary', payload.principal?.temporary === true)
}

// 3. Account sign-up through the real Neon Auth proxy, then session lookup.
const email = `acceptance+${randomUUID().slice(0, 8)}@example.test`
const password = `Acc-${randomUUID().slice(0, 18)}`
const accountJar = createJar()
{
  const signUp = await call('/api/auth/sign-up/email', {
    method: 'POST',
    jar: accountJar,
    headers: { origin },
    body: { email, password, name: 'Acceptance Account' },
  })
  const payload = await json(signUp)
  record('account.sign_up.status', signUp.status === 200, `HTTP ${signUp.status}`)
  record('account.sign_up.user', payload?.user?.email === email)
  record('account.session_cookie.set', accountJar.names().length > 0, accountJar.names().join(','))
}

{
  const session = await call('/api/auth/get-session', { jar: accountJar })
  const payload = await json(session)
  record('account.get_session.status', session.status === 200, `HTTP ${session.status}`)
  record('account.get_session.user', payload?.user?.email === email)
  record('account.get_session.expiresAt', Boolean(payload?.session?.expiresAt))
}

// 4. Authenticated workspace bootstrap yields a durable (non-temporary) principal.
{
  const response = await call('/api/workspaces/bootstrap', {
    method: 'POST',
    jar: accountJar,
    body: {},
  })
  const payload = await json(response)
  record('account.bootstrap.status', response.status === 200, `HTTP ${response.status}`)
  record(
    'account.bootstrap.temporary',
    payload?.principal?.temporary === false,
    `temporary=${payload?.principal?.temporary}`
  )
  record('account.bootstrap.displayName', Boolean(payload?.principal?.displayName))
}

// 4b. Guest-workspace claiming: a guest session that later signs in keeps its
//     workspace and has the temporary credential cleared.
{
  const jar = createJar()
  const guest = await json(
    await call('/api/workspaces/bootstrap', { method: 'POST', jar, body: {} })
  )
  record('claim.guest_credential_issued', jar.names().includes('agent_hq_temporary_session'))

  const claimEmail = `claim+${randomUUID().slice(0, 8)}@example.test`
  const signUp = await call('/api/auth/sign-up/email', {
    method: 'POST',
    jar,
    headers: { origin },
    body: { email: claimEmail, password, name: 'Claiming Guest' },
  })
  record('claim.sign_up.status', signUp.status === 200, `HTTP ${signUp.status}`)

  const claimed = await call('/api/workspaces/bootstrap', { method: 'POST', jar, body: {} })
  const claimedPayload = await json(claimed)
  const cleared = claimed.headers
    .getSetCookie()
    .some((value) => value.startsWith('agent_hq_temporary_session=;'))
  record('claim.status', claimed.status === 200, `HTTP ${claimed.status}`)
  record('claim.principal_not_temporary', claimedPayload?.principal?.temporary === false)
  record('claim.same_workspace', claimedPayload?.activeWorkspace?.id === guest?.activeWorkspace?.id)
  record('claim.temporary_cookie_cleared', cleared)
}

// 5. Origin enforcement: a hostile Origin cannot perform a state change.
{
  const response = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { origin: 'https://attacker.example' },
    body: { email, password },
  })
  record('security.hostile_origin.rejected', response.status === 403, `HTTP ${response.status}`)
}

// 6. Same-origin sign-in on a fresh session, exercising credential verification.
{
  const jar = createJar()
  const signIn = await call('/api/auth/sign-in/email', {
    method: 'POST',
    jar,
    headers: { origin },
    body: { email, password },
  })
  record('account.sign_in.status', signIn.status === 200, `HTTP ${signIn.status}`)
  const wrong = await call('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { origin },
    body: { email, password: `${password}-wrong` },
  })
  record('account.sign_in.wrong_password_rejected', wrong.status >= 400, `HTTP ${wrong.status}`)
}

// 7. Sign-out clears the provider session.
{
  const before = await call('/api/auth/get-session', { jar: accountJar })
  const beforePayload = await json(before)
  const signOut = await call('/api/auth/sign-out', {
    method: 'POST',
    jar: accountJar,
    headers: { origin },
    body: {},
  })
  const after = await call('/api/auth/get-session', { jar: accountJar })
  const afterPayload = await json(after)
  record('account.sign_out.status', signOut.status === 200, `HTTP ${signOut.status}`)
  record('account.sign_out.session_before', Boolean(beforePayload?.user))
  record(
    'account.sign_out.session_cleared',
    !afterPayload?.user,
    `after=${afterPayload?.user?.email ?? 'none'}`
  )
}

// 8. Root document and API authorization stay private and fail closed.
{
  const jar = createJar()
  const root = await call('/', { jar })
  record('entry.root.status', root.status === 200, `HTTP ${root.status}`)
  record('entry.root.private', root.headers.get('cache-control') === 'private, no-store')
  record('entry.root.noindex', /noindex/.test(root.headers.get('x-robots-tag') ?? ''))
  const unauthorized = await call(
    '/api/v1/workspaces/00000000-0000-4000-8000-000000000000/channels'
  )
  record(
    'authorization.anonymous_rejected',
    [401, 404].includes(unauthorized.status),
    `HTTP ${unauthorized.status}`
  )
}

await writeFile(
  resolve(evidence, 'account-flows.json'),
  JSON.stringify({ origin, results }, null, 2) + '\n'
)
const failures = Object.entries(results).filter(
  ([key, value]) => value === false && !key.startsWith('_')
)
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.map(([key]) => key).join(', ')}`)
  process.exit(1)
}
console.log(`\nAll account/session checks passed. Evidence: ${evidence}`)
