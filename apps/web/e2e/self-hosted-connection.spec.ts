import { expect, test, type Page } from '@playwright/test'
import axe from 'axe-core'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import type { FakeFailure, FakeHost } from './helpers/self-hosted-connection-fixture'

// Synthetic only: the pairing "credential" is a fixed string that authorizes nothing, the hosts are
// in-page records, and no request leaves the page. Set SELF_HOSTED_SHOTS to a directory to also
// save the review screenshots there.
const SHOTS = process.env.SELF_HOSTED_SHOTS
const CREDENTIAL = 'adea_reg_SYNTHETIC-NOT-A-CREDENTIAL'

async function open(page: Page, flags: string[] = []) {
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.route('**/__self-hosted', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto('/__self-hosted')
  await page.locator('#harness-root').evaluate((root, names) => {
    for (const name of names) root.setAttribute(name.split('=')[0]!, name.split('=')[1] ?? '')
  }, flags)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/self-hosted-connection-harness-app.tsx')
  )
  await expect(page.getByRole('heading', { name: 'Self-hosted hosts', level: 2 })).toBeVisible()
  return errors
}

const row = (page: Page, text: RegExp | string) =>
  page.getByTestId('host-row').filter({ hasText: text })
const inspect = async (page: Page, ref: string) => {
  await row(page, ref)
    .getByRole('button', { name: /^Inspect/ })
    .click()
  await expect(page.getByTestId('host-detail-heading')).toBeVisible()
}
const run = (page: Page, source: string) =>
  page.evaluate(
    (code) => new Function('s', `return (${code})(s)`)(window.selfHostedHarness),
    source
  )
const text = (page: Page) => page.locator('body').innerText()

test('hosts stay distinct, and nothing is called healthy before it is checked', async ({
  page,
}) => {
  const errors = await open(page)
  // The laptop is a local device and never appears here. Two hosts share a name.
  await expect(page.getByTestId('host-row')).toHaveCount(4)
  await expect(row(page, '…AAAAAA')).toContainText('Home server')
  await expect(row(page, '…BBBBBB')).toContainText('Home server')
  await expect(row(page, 'Laptop')).toHaveCount(0)
  // Registered and recently proven, but never checked: unknown, not "ready".
  await expect(row(page, '…AAAAAA')).toContainText('Not checked')
  await expect(row(page, '…BBBBBB')).toContainText('Stale proof')
  await expect(row(page, 'Retired VPS')).toContainText('Revoked')
  expect(await text(page)).not.toMatch(/\b(online|offline|ready|healthy|connected)\b/iu)
  expect(errors).toEqual([])
})

test('inspecting a host separates execution from synchronized history and reports, not clears', async ({
  page,
}) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  await expect(row(page, '…AAAAAA')).toContainText('Reported eligible')
  const execution = page.getByTestId('authority-execution')
  const history = page.getByTestId('authority-history')
  await expect(execution).toContainText('Registered')
  await expect(execution).toContainText('Does not decide who can read synchronized history')
  await expect(history).toContainText('Not reported for this host')
  await expect(history).toContainText('Registering this host does not grant history decryption')
  await expect(history).toHaveAttribute('data-tone', 'unknown')
  await expect(page.getByTestId('diagnostics')).toContainText('does not authorize work')
})

test('online is not compatible or allowed: an incompatible host with a recent proof is blocked', async ({
  page,
}) => {
  await open(page)
  await inspect(page, 'Office box')
  await expect(row(page, 'Office box')).toContainText('Incompatible')
  const diagnostics = page.getByTestId('diagnostics')
  await expect(diagnostics).toContainText('Recent proof')
  await expect(diagnostics).toContainText('Update the host’s Control Plane')
  await expect(diagnostics).toContainText('protocol 2 is not supported')
  await expect(diagnostics).toContainText('registered software 1.40.0')
  await expect(page.getByRole('button', { name: 'Use this host' })).toBeDisabled()
  await expect(page.getByTestId('choose-reason')).toContainText('Not selectable yet')
  await expect(page.getByTestId('next-steps')).toContainText('compatible release')
})

test('explicit selection never falls back to another host', async ({ page }) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  await page.getByRole('button', { name: 'Use this host' }).click()
  await expect(page.getByText('Chosen for new work')).toHaveCount(1)
  await expect(row(page, '…AAAAAA')).toContainText('Chosen for new work')
  // A stale host cannot be chosen, and choosing it does not move the existing choice.
  await inspect(page, '…BBBBBB')
  await expect(page.getByRole('button', { name: 'Use this host' })).toBeDisabled()
  await expect(row(page, '…AAAAAA')).toContainText('Chosen for new work')
  // The chosen host stops passing: it stays chosen and is flagged, and nothing else is chosen.
  await run(
    page,
    `(s) => { const h = s.state.hosts['user-a:ws-1'].find((x) => x.id === 'host-aaaaaa'); h.compat = 'incompatible' }`
  )
  await inspect(page, '…AAAAAA')
  await page.getByRole('button', { name: /Check again|Reconnect check/ }).click()
  await expect(row(page, '…AAAAAA')).toContainText('Incompatible')
  await expect(page.getByText('Chosen for new work')).toHaveCount(1)
  await expect(page.getByTestId('choose-reason')).toContainText('still chosen')
  await expect(page.getByTestId('choose-reason')).toContainText('rather than move to another host')
  // Stopping is explicit, and leaves no host chosen.
  await page.getByRole('button', { name: 'Stop using this host' }).click()
  await expect(page.getByText('Chosen for new work')).toHaveCount(0)
})

test('choosing a host is unavailable, with its reason, when it is not connected', async ({
  page,
}) => {
  await open(page, ['data-no-choose'])
  await inspect(page, '…AAAAAA')
  await expect(page.getByRole('button', { name: 'Use this host' })).toBeDisabled()
  await expect(page.getByTestId('choose-reason')).toContainText('Not available yet')
})

test('an unreachable Control Plane stays unknown, then recovers on the same host', async ({
  page,
}) => {
  await open(page)
  await run(page, `(s) => { s.state.discoveryFailures['host-aaaaaa'] = { status: 503 } }`)
  await inspect(page, '…AAAAAA')
  await expect(row(page, '…AAAAAA')).toContainText('Could not check')
  await expect(page.getByTestId('diagnostics')).toContainText(
    'says nothing about whether the host is running'
  )
  expect(await text(page)).not.toContain('sensitive-error-canary')
  expect(await text(page)).not.toMatch(/\boffline\b/iu)
  await run(page, `(s) => { delete s.state.discoveryFailures['host-aaaaaa'] }`)
  const check = page.getByRole('button', { name: /Check again|Reconnect check/ })
  await check.focus()
  await page.keyboard.press('Enter')
  await expect(row(page, '…AAAAAA')).toContainText('Reported eligible')
  // The keyboard position survives the check.
  await expect(check).toBeFocused()
})

test('a Control Plane that answers with no report is distinct from an empty inventory', async ({
  page,
}) => {
  await open(page)
  await run(page, `(s) => { s.state.discoveryUnavailable.push('host-aaaaaa') }`)
  await inspect(page, '…AAAAAA')
  await expect(page.getByTestId('diagnostics')).toContainText('No report received')
  await expect(page.getByTestId('diagnostics')).not.toContainText('No runtimes reported')
})

test('a failed host list keeps the last one on screen, ages it, and recovers on retry', async ({
  page,
}) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  await run(page, `(s) => s.queueListFailure({ status: 500 })`)
  await page.getByRole('button', { name: 'Refresh hosts', exact: true }).click()
  const failed = page.getByTestId('refresh-failed')
  await expect(failed).toContainText('Hosts could not be refreshed')
  await expect(failed).toContainText('Showing the last list that was read')
  expect(await text(page)).not.toContain('sensitive-error-canary')
  // The open host and the rest of the list are still there.
  await expect(page.getByTestId('host-detail-heading')).toBeVisible()
  await expect(page.getByTestId('host-row')).toHaveCount(4)
  await failed.getByRole('button', { name: 'Try again' }).click()
  await expect(failed).toHaveCount(0)
})

test('reconnect: a stale host says what to do, and recovers once it proves liveness again', async ({
  page,
}) => {
  await open(page)
  await inspect(page, '…BBBBBB')
  await expect(page.getByTestId('diagnostics')).toContainText('Stale proof')
  await expect(page.getByTestId('next-steps')).toContainText('registration agent')
  const reconnect = page.getByRole('button', { name: 'Reconnect check' })
  await expect(reconnect).toBeVisible()
  // Still stale until the host actually proves itself: the check cannot make it live.
  await reconnect.click()
  await expect(row(page, '…BBBBBB')).toContainText('Stale proof')
  await run(page, `(s) => s.heartbeat('host-bbbbbb')`)
  await page.getByRole('button', { name: 'Reconnect check' }).click()
  await expect(row(page, '…BBBBBB')).toContainText('Reported eligible')
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible()
})

test('setup: guidance is honest about what is not available yet', async ({ page }) => {
  await open(page, ['data-empty'])
  await expect(page.getByText('No self-hosted host is registered in this workspace.')).toBeVisible()
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  const steps = page.getByTestId('setup-steps')
  await expect(steps).toContainText('Keep its API on the server’s loopback address')
  await expect(steps).toContainText('Adea never asks for them')
  await expect(page.getByTestId('host-step-unavailable')).toContainText(
    'does not include a registration command'
  )
  await expect(page.getByTestId('refusal-reference')).toBeAttached()
})

test('setup: a pairing is shown once, masked, and cleared when it is cleared', async ({ page }) => {
  await open(page, ['data-empty'])
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  await page.getByRole('button', { name: 'Create pairing' }).click()
  const values = page.getByTestId('pairing-values')
  await expect(values).toHaveAttribute('data-pairing-state', 'active')
  // Focus moves to the new values so a screen reader arrives on them.
  await expect(page.getByRole('heading', { name: 'Pairing values' })).toBeFocused()
  const credential = page.getByLabel('Registration credential', { exact: true })
  await expect(credential).toHaveAttribute('type', 'password')
  expect(await text(page)).not.toContain(CREDENTIAL)
  const reveal = page.getByRole('button', { name: /^(Show|Hide) registration credential$/ })
  await reveal.click()
  await expect(reveal).toHaveAttribute('aria-pressed', 'true')
  await expect(credential).toHaveAttribute('type', 'text')
  await expect(credential).toHaveValue(CREDENTIAL)
  await page.getByRole('button', { name: 'Copy Workspace ID' }).click()
  await expect(page.getByTestId('copy-status')).not.toBeEmpty()
  // Nothing is written to storage.
  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
  )
  expect(stored).not.toContain(CREDENTIAL)
  await page.getByRole('button', { name: 'Clear these values' }).click()
  await expect(page.getByTestId('pairing-values')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create pairing' })).toBeFocused()
})

test('setup: an expired pairing clears its values and asks for a new one', async ({ page }) => {
  await open(page, ['data-empty'])
  await run(page, `(s) => { s.state.pairingLifetimeMs = 5000 }`)
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  await page.getByRole('button', { name: 'Create pairing' }).click()
  await page.getByRole('button', { name: 'Show registration credential' }).click()
  await expect(page.getByLabel('Registration credential', { exact: true })).toHaveValue(CREDENTIAL)
  await expect(page.getByTestId('pairing-values')).toHaveAttribute(
    'data-pairing-state',
    'expired',
    {
      timeout: 15_000,
    }
  )
  await expect(page.getByTestId('pairing-values')).toContainText('The values were cleared')
  expect(await text(page)).not.toContain(CREDENTIAL)
  await expect(page.getByLabel('Registration credential', { exact: true })).toHaveCount(0)
  await run(page, `(s) => { s.state.pairingLifetimeMs = 600000 }`)
  await page.getByRole('button', { name: 'Create a new pairing' }).click()
  await expect(page.getByTestId('pairing-values')).toHaveAttribute('data-pairing-state', 'active')
})

test('setup: a pairing a host has used is spent, and replaying it is not possible from here', async ({
  page,
}) => {
  await open(page, ['data-empty'])
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  await page.getByRole('button', { name: 'Create pairing' }).click()
  await expect(page.getByTestId('pairing-values')).toHaveAttribute('data-pairing-state', 'active')
  await run(page, `(s) => s.register({ id: 'host-ffffff', displayName: 'Rack 2' })`)
  await page.getByRole('button', { name: 'Refresh hosts', exact: true }).first().click()
  await expect(page.getByTestId('pairing-values')).toHaveAttribute('data-pairing-state', 'consumed')
  await expect(page.getByTestId('pairing-values')).toContainText(
    'If that was not your host, revoke it'
  )
  expect(await text(page)).not.toContain(CREDENTIAL)
  await expect(row(page, 'Rack 2')).toBeVisible()
})

test('setup: pairing refusals give distinct recovery, keep focus, and never echo server text', async ({
  page,
}) => {
  await open(page, ['data-empty'])
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  const cases: [FakeFailure, string][] = [
    [{ status: 403, code: 'unauthorized' }, 'This account cannot do that here'],
    [{ status: 401 }, 'You are signed out'],
    [{ status: 409, code: 'challenge_expired' }, 'The pairing expired'],
    [{ status: 409, code: 'challenge_used' }, 'The pairing was already used'],
    [
      { status: 409, code: 'exchange_credential_invalid' },
      'The registration credential was not accepted',
    ],
    [{ status: 503 }, 'Adea had a problem'],
  ]
  for (const [failure, title] of cases) {
    await run(page, `(s) => { s.state.pairingFailure = ${JSON.stringify(failure)} }`)
    const create = page.getByRole('button', { name: 'Create pairing' })
    await create.click()
    await expect(page.getByTestId('pairing-failure')).toContainText(title)
    await expect(create).toBeFocused()
    await expect(page.getByTestId('pairing-values')).toHaveCount(0)
  }
  expect(await text(page)).not.toContain('sensitive-error-canary')
  await run(page, `(s) => { s.state.pairingFailure = undefined }`)
  await page.getByRole('button', { name: 'Create pairing' }).click()
  await expect(page.getByTestId('pairing-failure')).toHaveCount(0)
  await expect(page.getByTestId('pairing-values')).toBeVisible()
})

test('setup: the operation is unavailable, with its reason, when not connected', async ({
  page,
}) => {
  await open(page, ['data-empty', 'data-no-operations'])
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  await expect(page.getByRole('button', { name: 'Create pairing' })).toBeDisabled()
  await expect(
    page.getByText('Not available yet: creating a pairing is not connected')
  ).toBeVisible()
})

test('account and workspace switches discard pairing values and never show another scope’s hosts', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  await page.getByRole('button', { name: 'Create pairing' }).click()
  await expect(page.getByTestId('pairing-values')).toBeVisible()
  await inspect(page, '…AAAAAA')
  await run(page, `(s) => s.setAccount('user-b')`)
  // A different account: the pairing, the open host and the previous account's hosts are gone.
  await expect(page.getByText('No self-hosted host is registered in this workspace.')).toBeVisible()
  await expect(page.getByTestId('pairing-values')).toHaveCount(0)
  await expect(page.getByTestId('host-detail-heading')).toHaveCount(0)
  await expect(page.getByTestId('host-row')).toHaveCount(0)
  expect(await text(page)).not.toContain(CREDENTIAL)
  await run(page, `(s) => s.setAccount('user-a')`)
  await expect(page.getByTestId('host-row')).toHaveCount(4)
  await run(page, `(s) => s.setWorkspace('ws-2')`)
  await expect(page.getByTestId('host-row')).toHaveCount(0)
  await expect(page.getByTestId('pairing-values')).toHaveCount(0)
})

test('rename is unavailable, with its reason, when the server has no rename operation', async ({
  page,
}) => {
  await open(page, ['data-no-operations'])
  await inspect(page, '…AAAAAA')
  await expect(page.getByRole('button', { name: 'Rename…' })).toBeDisabled()
  await expect(page.getByText('the server has no rename operation')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Revoke execution…' })).toBeDisabled()
  await expect(page.getByText('Not available yet: revoking is not connected')).toBeVisible()
})

test('rename keeps the draft and focus through validation and failure, then succeeds', async ({
  page,
}) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  const trigger = page.getByRole('button', { name: 'Rename…' })
  await trigger.click()
  const input = page.getByRole('textbox', { name: 'Host name' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Home server')
  // Hosts must stay distinct.
  await input.fill('office BOX')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Another host already uses that name' })
  ).toBeVisible()
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(input).toBeFocused()
  // A failed save keeps exactly what was typed and returns to the field.
  await input.fill('Rack 1')
  await run(page, `(s) => { s.state.renameFailure = { status: 503 } }`)
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByTestId('panel-notice')).toContainText('Adea had a problem')
  await expect(input).toHaveValue('Rack 1')
  await expect(input).toBeFocused()
  await run(page, `(s) => { s.state.renameFailure = undefined }`)
  await page.getByTestId('panel-notice').getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('panel-notice')).toContainText('Host renamed')
  await expect(row(page, '…AAAAAA')).toContainText('Rack 1')
  await expect(trigger).toBeFocused()
})

test('rename: Escape cancels and restores focus without saving', async ({ page }) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  await page.getByRole('button', { name: 'Rename…' }).click()
  await page.getByRole('textbox', { name: 'Host name' }).fill('Unsaved')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Rename…' })).toBeFocused()
  await expect(row(page, '…AAAAAA')).toContainText('Home server')
})

test('revoke: the consequences are stated, drafts survive failure, and history is untouched', async ({
  page,
}) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  const before = await page.getByTestId('authority-history').innerText()
  const trigger = page.getByRole('button', { name: 'Revoke execution…' })
  await trigger.click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByLabel('Reason')).toBeFocused()
  const effects = page.getByTestId('revoke-effects')
  await expect(effects).toContainText('It does not delete anything on the host or its data')
  await expect(effects).toContainText('It does not change who can read synchronized history')
  await expect(effects).toContainText('It does not cancel work the host has already accepted')
  // A reason is required, and the field takes focus back.
  await dialog.getByRole('button', { name: 'Revoke execution' }).click()
  await expect(dialog.getByRole('alert').filter({ hasText: 'Enter a reason' })).toBeVisible()
  await expect(page.getByLabel('Reason')).toBeFocused()
  // A failed revoke keeps the dialog, the draft and focus on the action.
  await page.getByLabel('Reason').fill('Decommissioned')
  await run(page, `(s) => { s.state.revokeFailure = { status: 503 } }`)
  await dialog.getByRole('button', { name: 'Revoke execution' }).click()
  await expect(page.getByTestId('revoke-failure')).toContainText('Adea had a problem')
  await expect(page.getByLabel('Reason')).toHaveValue('Decommissioned')
  await expect(dialog.getByRole('button', { name: 'Revoke execution' })).toBeFocused()
  // Focus stays inside the dialog.
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press('Tab')
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('[role="alertdialog"]'))
    ).toBe(true)
  }
  await run(page, `(s) => { s.state.revokeFailure = undefined }`)
  await dialog.getByRole('button', { name: 'Revoke execution' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(page, '…AAAAAA')).toContainText('Revoked')
  await expect(page.getByTestId('host-detail-heading')).toBeFocused()
  await expect(page.getByTestId('panel-notice')).toContainText(
    'synchronized history access is unchanged'
  )
  // The history authority did not move because the execution one did.
  expect(await page.getByTestId('authority-history').innerText()).toBe(before)
  await expect(page.getByTestId('authority-execution')).toContainText('Revoked')
  await expect(page.getByRole('button', { name: 'Register again…' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use this host' })).toBeDisabled()
})

test('revoke: Cancel returns focus to the trigger and changes nothing', async ({ page }) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  await page.getByRole('button', { name: 'Revoke execution…' }).click()
  await page.getByRole('button', { name: 'Keep host' }).click()
  await expect(page.getByRole('button', { name: 'Revoke execution…' })).toBeFocused()
  expect(
    await run(page, `(s) => s.state.requests.filter((r) => r.path.startsWith('/revoke')).length`)
  ).toBe(0)
})

test('stale revocation: a host revoked elsewhere is reconciled, not blamed', async ({ page }) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  // Someone else revokes it; this view still shows it registered.
  await run(page, `(s) => s.revokeExternally('host-aaaaaa')`)
  await expect(row(page, '…AAAAAA')).not.toContainText('Revoked')
  await page.getByRole('button', { name: 'Revoke execution…' }).click()
  await page.getByLabel('Reason').fill('Decommissioned')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke execution' }).click()
  await expect(page.getByTestId('panel-notice')).toContainText('The host was already revoked')
  await expect(row(page, '…AAAAAA')).toContainText('Revoked')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})

test('stale revocation: an accepted revoke the next read does not show is not reported as done', async ({
  page,
}) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  await run(page, `(s) => { s.state.revokeIgnored = true }`)
  await page.getByRole('button', { name: 'Revoke execution…' }).click()
  await page.getByLabel('Reason').fill('Decommissioned')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke execution' }).click()
  await expect(page.getByTestId('panel-notice')).toContainText('Revocation not confirmed yet')
  await expect(page.getByTestId('unconfirmed-revocation')).toBeVisible()
  await expect(row(page, '…AAAAAA')).not.toContainText('Revoked')
  expect(await text(page)).not.toContain('Execution revoked for')
})

test('stale revocation: a discovery read that sees the revoke downgrades a list that does not', async ({
  page,
}) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  await run(page, `(s) => s.revokeExternally('host-aaaaaa')`)
  // Only the report is re-read; the list in view still says paired.
  await run(page, `(s) => s.queueListFailure({ status: 500 })`)
  await page.getByRole('button', { name: /Check again|Reconnect check/ }).click()
  await expect(page.getByTestId('authority-execution')).toContainText('Revoked')
})

test('a revoke started under one account never lands in the next', async ({ page }) => {
  await open(page)
  await inspect(page, '…AAAAAA')
  await run(page, `(s) => { s.state.holdRevoke = true }`)
  await page.getByRole('button', { name: 'Revoke execution…' }).click()
  await page.getByLabel('Reason').fill('Decommissioned')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke execution' }).click()
  await run(page, `(s) => s.setAccount('user-b')`)
  await expect(page.getByTestId('host-row')).toHaveCount(0)
  await run(page, `(s) => s.release()`)
  await expect(page.getByTestId('host-row')).toHaveCount(0)
  await expect(page.getByTestId('panel-notice')).toHaveCount(0)
  expect(await text(page)).not.toContain('Execution revoked for')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})

test('synchronized history reads the same whatever the host’s execution state', async ({
  page,
}) => {
  await open(page)
  const cards: string[] = []
  for (const ref of ['…AAAAAA', '…BBBBBB', 'Retired VPS', 'Office box']) {
    await inspect(page, ref)
    await expect(page.getByTestId('authority-history')).toBeVisible()
    cards.push(await page.getByTestId('authority-history').innerText())
  }
  expect(new Set(cards).size).toBe(1)
  expect(cards[0]).toContain('Effect of host connection')
  expect(cards[0]).toContain('None. This view never hides history')
})

test('required capabilities that a host does not report are named from its own report', async ({
  page,
}) => {
  await open(page, ['data-required-capabilities=chat,browser'])
  await inspect(page, '…AAAAAA')
  await expect(page.getByTestId('diagnostics')).toContainText(
    'No reported runtime supports browser'
  )
  await expect(page.getByRole('button', { name: 'Use this host' })).toBeDisabled()
})

for (const theme of ['light', 'dark'] as const)
  for (const width of [320, 768, 1280]) {
    test(`layout and accessibility at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.addInitScript((mode) => localStorage.setItem('theme', mode), theme)
      const errors = await open(page)
      await inspect(page, '…AAAAAA')
      await page.getByRole('button', { name: 'Connect a host…' }).click()
      await page.getByRole('button', { name: 'Create pairing' }).click()
      await expect(page.getByTestId('pairing-values')).toBeVisible()
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
      ).toBe(true)
      await page.screenshot({
        path: testInfo.outputPath(`panel-${theme}-${width}.png`),
        fullPage: true,
      })
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({
          path: resolve(SHOTS, `panel-${theme}-${width}.png`),
          fullPage: true,
        })
      }
      const audit = async (selector: string) => {
        await page.addScriptTag({ content: axe.source })
        return page.evaluate(async (target) => {
          const runner = window as typeof window & {
            axe: {
              run: (
                context: Element,
                options: unknown
              ) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }>
            }
          }
          const result = await runner.axe.run(document.querySelector(target)!, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
          })
          return result.violations.map(
            (violation) => `${violation.id}: ${violation.nodes[0]?.html.slice(0, 120)}`
          )
        }, selector)
      }
      expect(await audit('#harness-root')).toEqual([])
      await page.getByRole('button', { name: 'Revoke execution…' }).click()
      await page.getByLabel('Reason').fill('Decommissioned')
      if (SHOTS) await page.screenshot({ path: resolve(SHOTS, `revoke-${theme}-${width}.png`) })
      expect(await audit('[role="alertdialog"]')).toEqual([])
      expect(errors).toEqual([])
    })
  }

test('review screenshots of the states people recover from', async ({ page }) => {
  test.skip(!SHOTS, 'Set SELF_HOSTED_SHOTS to save review screenshots')
  mkdirSync(SHOTS!, { recursive: true })
  await page.setViewportSize({ width: 1100, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.addInitScript(() => localStorage.setItem('theme', 'light'))
  await open(page)
  const shot = (name: string) =>
    page.screenshot({ path: resolve(SHOTS!, `${name}.png`), fullPage: true })
  await shot('01-list-unchecked')
  await inspect(page, '…AAAAAA')
  await shot('02-host-reported-eligible')
  await inspect(page, 'Office box')
  await shot('03-version-mismatch')
  await inspect(page, '…BBBBBB')
  await shot('04-stale-proof-reconnect')
  await run(page, `(s) => { s.state.discoveryFailures['host-aaaaaa'] = { status: 503 } }`)
  await inspect(page, '…AAAAAA')
  await shot('05-endpoint-failure-unknown')
  await inspect(page, 'Retired VPS')
  await shot('06-revoked-host')
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  await page.getByRole('button', { name: 'Create pairing' }).click()
  await shot('07-setup-pairing')
  await run(page, `(s) => { s.state.pairingFailure = { status: 403, code: 'unauthorized' } }`)
  await page.getByRole('button', { name: 'Create a new pairing' }).click()
  await shot('08-pairing-wrong-account')
})

export type { FakeHost }
