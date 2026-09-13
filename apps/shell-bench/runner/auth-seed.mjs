// Seeds a fresh desktop session for one bench candidate: PKCE attempt ->
// programmatic sign-in -> authorize -> callback file. Disposable — deleted by
// #371. Requires ADEA_BENCH_EMAIL / ADEA_BENCH_PASSWORD in the environment
// (never committed).
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const candidate = process.argv[2]
if (!candidate) {
  console.error('usage: bun auth-seed.mjs <candidate>')
  process.exit(1)
}

const email = process.env.ADEA_BENCH_EMAIL
const password = process.env.ADEA_BENCH_PASSWORD
if (!email || !password) {
  console.error('ADEA_BENCH_EMAIL / ADEA_BENCH_PASSWORD not set')
  process.exit(1)
}

const REPO = join(import.meta.dirname, '..', '..', '..')
const { createDesktopAuthorizationAttempt, createDesktopAuthorizationUrl } = await import(
  `file://${join(REPO, 'packages/auth/src/desktop.ts')}`
)

const CLOUD = 'https://adea.dev'
const stateDir = join(
  process.env.HOME,
  'Library/Application Support',
  `shell-bench-${candidate}`,
  'bench-state'
)
mkdirSync(stateDir, { recursive: true })

// 1. PKCE attempt (persisted for the shell's shim to serve)
const attempt = await createDesktopAuthorizationAttempt()
writeFileSync(join(stateDir, 'auth-attempt.json'), JSON.stringify(attempt))

// 2. sign-in (Better Auth) -> cookie jar
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'
const jarResp = await fetch(`${CLOUD}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'user-agent': UA,
    origin: CLOUD,
    referer: `${CLOUD}/auth/sign-in`,
  },
  body: JSON.stringify({ email, password }),
})
if (!jarResp.ok) {
  console.error(`sign-in failed: ${jarResp.status}`)
  process.exit(1)
}
const setCookies = jarResp.headers.getSetCookie?.() ?? []
const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')

// 3. authorize -> capture adea:// callback from the redirect fragment
const authUrl = createDesktopAuthorizationUrl(CLOUD, attempt)
const redirect = await fetch(authUrl, {
  headers: { cookie },
  redirect: 'manual',
})
const location = redirect.headers.get('location') ?? ''
const frag = location.split('#')[1] ?? ''
const kv = {}
for (const pair of frag.split('&')) {
  const eq = pair.indexOf('=')
  if (eq > 0) kv[pair.slice(0, eq)] = pair.slice(eq + 1)
}
const rawCallback = decodeURIComponent(kv.callback ?? '')
if (!rawCallback) {
  console.error(`no callback in redirect: ${location.slice(0, 120)}`)
  process.exit(1)
}
writeFileSync(join(stateDir, 'callback.txt'), rawCallback)
console.log(`seeded ${candidate}`)
