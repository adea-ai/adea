import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'

// Browser-level sign-in acceptance: drives the real form so the error mapping
// and the returnTo round trip are verified as a person experiences them.
const base = process.env.ADEA_ACCEPTANCE_URL
if (!base) throw new Error('Set ADEA_ACCEPTANCE_URL to the isolated acceptance origin')
const origin = new URL(base).origin
const evidence = new URL('.checks/hosted/', import.meta.url)
await mkdir(evidence, { recursive: true })

const results = {}
const record = (name, value, detail) => {
  results[name] = value
  console.log(
    `${value === true ? 'PASS' : value === false ? 'FAIL' : 'INFO'}  ${name}${detail ? ` — ${detail}` : ''}`
  )
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))

const phase = process.argv[2] ?? 'open'
if (!['open', 'allowlisted'].includes(phase))
  throw new Error('Usage: acceptance-sign-in.mjs <open|allowlisted>')

try {
  // 1. With the account allowlist active, a deep link keeps its destination
  //    through the sign-in redirect. An open deployment renders the workspace
  //    instead, so this only applies to the allowlisted phase.
  if (phase === 'allowlisted') {
    const response = await page.goto(`${origin}/?view=chat&scene=home`)
    record('deeplink.root_status', response?.status() === 200, `HTTP ${response?.status()}`)
    await page.waitForLoadState('domcontentloaded')
    const url = new URL(page.url())
    const heading = await page
      .locator('h1.auth-title')
      .first()
      .textContent()
      .catch(() => null)
    record('deeplink.redirected_to_sign_in', url.pathname === '/auth/sign-in', url.pathname)
    record('deeplink.sign_in_page', Boolean(heading), heading ?? 'no auth panel')
    record(
      'deeplink.return_to_preserved',
      url.searchParams.get('returnTo') === '/?view=chat&scene=home',
      url.searchParams.get('returnTo') ?? 'none'
    )
  }

  // 2. The form validates input client-side before contacting the provider.
  if (phase === 'open') {
    await page.goto(`${origin}/auth/sign-in`)
    await page.fill('#email', 'not-an-email')
    await page.fill('#password', 'short')
    await page.click('button[type="submit"]')
    const validity = await page.evaluate(() => {
      const email = document.querySelector('#email')
      const password = document.querySelector('#password')
      return { emailValid: email?.checkValidity(), passwordValid: password?.checkValidity() }
    })
    record('form.rejects_invalid_email', validity.emailValid === false)
    record('form.rejects_short_password', validity.passwordValid === false)
  }

  // 3. A wrong password shows actionable copy, not a generic server error.
  if (phase === 'open') {
    await page.goto(`${origin}/auth/sign-in`)
    await page.fill('#email', 'nonexistent-verification@example.test')
    await page.fill('#password', 'wrong-password-1234')
    await page.click('button[type="submit"]')
    const alert = page.locator('.browser-auth-error')
    await alert.waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForFunction(
      () => (document.querySelector('.browser-auth-error')?.textContent ?? '').trim().length > 0,
      { timeout: 20_000 }
    )
    const message = (await alert.textContent())?.trim() ?? ''
    record('form.wrong_password_message_shown', message.length > 0, message)
    record(
      'form.wrong_password_is_specific',
      message.includes('did not match'),
      message.slice(0, 90)
    )
    record(
      'form.no_generic_failure_copy',
      !message.includes('could not sign you in'),
      message.slice(0, 90)
    )
    record('form.provider_detail_not_leaked', !/INVALID_|code/i.test(message))
    record('form.still_pending_released', await page.locator('button[type="submit"]').isEnabled())
  }

  // 4. Sign up, then sign in with the same credentials, then reach the
  //    destination captured at the start of the flow.
  if (phase === 'open') {
    const email = `signin+${randomUUID().slice(0, 8)}@example.test`
    const password = `Acc-${randomUUID().slice(0, 18)}`

    await page.goto(
      `${origin}/auth/sign-in?returnTo=${encodeURIComponent('/?view=chat&scene=home')}`
    )
    await page.click('button:has-text("Create account")')
    await page.fill('#name', 'Sign-In Acceptance')
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('button[type="submit"]')
    await page.waitForURL((url) => new URL(url).pathname === '/', { timeout: 30_000 })
    const landed = new URL(page.url())
    record('signup.lands_on_return_to_path', landed.pathname === '/', landed.pathname)
    record('signup.keeps_search', landed.searchParams.get('view') === 'chat', landed.search)

    // A registered address on the sign-up form is reported as such.
    await page.goto(`${origin}/auth/sign-in`)
    await page.click('button:has-text("Create account")')
    await page.fill('#name', 'Sign-In Acceptance')
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('button[type="submit"]')
    const duplicate = page.locator('.browser-auth-error')
    await page.waitForFunction(
      () => (document.querySelector('.browser-auth-error')?.textContent ?? '').trim().length > 0,
      { timeout: 20_000 }
    )
    const duplicateMessage = (await duplicate.textContent())?.trim() ?? ''
    record(
      'signup.duplicate_account_message',
      duplicateMessage.length > 0,
      duplicateMessage.slice(0, 90)
    )

    // Signing in works and returns to the requested destination.
    await page.goto(
      `${origin}/auth/sign-in?returnTo=${encodeURIComponent('/?view=virtual&scene=work')}`
    )
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('button[type="submit"]')
    await page.waitForURL((url) => new URL(url).pathname === '/', { timeout: 30_000 })
    const signedIn = new URL(page.url())
    record('signin.succeeds', signedIn.pathname === '/', signedIn.pathname)
    record('signin.keeps_search', signedIn.searchParams.get('view') === 'virtual', signedIn.search)
    const session = await context.request.get(`${origin}/api/auth/get-session`)
    const payload = await session.json().catch(() => null)
    record(
      'signin.session_established',
      payload?.user?.email === email,
      payload?.user?.email ?? 'none'
    )
  }

  record('browser.no_page_errors', errors.length === 0, errors.join('; ').slice(0, 200))
} finally {
  await browser.close()
}

await writeFile(
  new URL(`sign-in-flows-${phase}.json`, evidence),
  JSON.stringify({ origin, results }, null, 2) + '\n'
)
const failures = Object.entries(results).filter(([, value]) => value === false)
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.map(([key]) => key).join(', ')}`)
  process.exit(1)
}
console.log('\nAll browser sign-in checks passed.')
assert.ok(true)
