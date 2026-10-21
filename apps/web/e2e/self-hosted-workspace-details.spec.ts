import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

// Synthetic only: the hosts are in-page records and no request leaves the page. This mounts the
// self-hosted pane the way the product does, inside the real Workspace Details dialog (#188). The
// pane's own behavior is pinned in self-hosted-connection.spec.ts.
async function open(page: Page, flags: string[] = []) {
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.route('**/__self-hosted-details', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto('/__self-hosted-details#settings/workspace-connections')
  await page.locator('#harness-root').evaluate((root, names) => {
    for (const name of names) root.setAttribute(name, '')
  }, flags)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' +
      resolve(process.cwd(), 'apps/web/e2e/helpers/self-hosted-workspace-details-harness-app.tsx')
  )
  await expect(page.getByRole('dialog')).toBeVisible()
  return errors
}

const run = (page: Page, source: string, arg?: unknown) =>
  page.evaluate(
    ([code, value]) =>
      new Function('s', 'a', `return (${code as string})(s, a)`)(
        window.selfHostedDetailsHarness,
        value
      ),
    [source, arg] as const
  )
const hosts = (page: Page) => page.getByTestId('host-row')
const text = (page: Page) => page.getByRole('dialog').innerText()

test('Connections lists the account’s self-hosted hosts, none called healthy before a check', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(page.getByRole('heading', { name: 'Self-hosted hosts', level: 2 })).toBeVisible()
  await expect(hosts(page)).toHaveCount(4)
  await expect(hosts(page).filter({ hasText: '…AAAAAA' })).toContainText('Not checked')
  await expect(hosts(page).filter({ hasText: '…BBBBBB' })).toContainText('Stale proof')
  await expect(hosts(page).filter({ hasText: 'Retired VPS' })).toContainText('Revoked')
  // The local device is not a self-hosted host.
  await expect(hosts(page).filter({ hasText: 'Laptop' })).toHaveCount(0)
  const requests = (await run(page, '(s) => s.state.requests')) as {
    method: string
    path: string
  }[]
  // The account is the host's session principal: the section makes no bootstrap read of its own.
  expect(requests.filter(({ path }) => path.endsWith('/workspaces/bootstrap'))).toEqual([])
  expect(requests).toContainEqual({ method: 'GET', path: '/api/v1/workspaces/ws-1/runtime-nodes' })
  expect(errors).toEqual([])
})

test('actions the client cannot perform are shown unavailable, never as controls', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(hosts(page)).toHaveCount(4)
  await page.getByRole('button', { name: 'Connect a host…' }).click()
  await expect(page.getByRole('button', { name: 'Create pairing' })).toBeDisabled()
  await expect(
    page.getByText('Not available yet: creating a pairing is not connected in this build')
  ).toBeVisible()
  await hosts(page)
    .filter({ hasText: '…AAAAAA' })
    .getByRole('button', { name: /^Inspect/ })
    .click()
  await expect(page.getByRole('button', { name: 'Rename…' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Revoke execution…' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Use this host' })).toBeDisabled()
  // Nothing was sent to change a host: the section makes reads only.
  const writes = (
    (await run(page, '(s) => s.state.requests')) as { method: string; path: string }[]
  ).filter(
    ({ method, path }) => method !== 'GET' && /runtime-nodes|pairing|rename|revoke/u.test(path)
  )
  expect(writes).toEqual([])
  expect(errors).toEqual([])
})

test('another account never sees the previous account’s hosts, and the first returns to its own', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(hosts(page)).toHaveCount(4)
  await run(page, `(s) => s.setAccount('user-b')`)
  await expect(page.getByText('No self-hosted host is registered in this workspace.')).toBeVisible()
  await expect(hosts(page)).toHaveCount(0)
  expect(await text(page)).not.toContain('Home server')
  await run(page, `(s) => s.setAccount('user-a')`)
  await expect(hosts(page)).toHaveCount(4)
  expect(errors).toEqual([])
})

test('another workspace shows only its own hosts', async ({ page }) => {
  const errors = await open(page)
  await expect(hosts(page)).toHaveCount(4)
  await run(page, `(s) => s.setWorkspace('ws-2')`)
  await expect(hosts(page)).toHaveCount(0)
  await expect(page.getByText('No self-hosted host is registered in this workspace.')).toBeVisible()
  expect(await text(page)).not.toContain('Home server')
  await run(page, `(s) => s.setWorkspace('ws-1')`)
  await expect(hosts(page)).toHaveCount(4)
  expect(errors).toEqual([])
})

test('a refused read (role boundary) drops the list and a later read recovers it', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(hosts(page)).toHaveCount(4)
  await run(page, `(s) => s.queueListFailure({ status: 403 })`)
  await page.getByRole('button', { name: 'Refresh hosts', exact: true }).first().click()
  await expect(page.getByText('Hosts could not be loaded')).toBeVisible()
  await expect(hosts(page)).toHaveCount(0)
  expect(await text(page)).not.toContain('sensitive-error-canary')
  expect(await text(page)).not.toContain('Home server')
  await page.getByRole('button', { name: 'Try again' }).first().click()
  await expect(hosts(page)).toHaveCount(4)
  expect(errors).toEqual([])
})

test('a host revoked elsewhere is shown revoked after a refresh, and a new one appears', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(hosts(page).filter({ hasText: '…AAAAAA' })).toContainText('Not checked')
  await run(page, `(s) => s.revokeExternally('host-aaaaaa')`)
  await run(page, `(s) => s.register({ id: 'host-ffffff', displayName: 'Rack box' })`)
  await page.getByRole('button', { name: 'Refresh hosts', exact: true }).first().click()
  await expect(hosts(page).filter({ hasText: '…AAAAAA' })).toContainText('Revoked')
  await expect(hosts(page).filter({ hasText: 'Rack box' })).toHaveCount(1)
  await expect(hosts(page)).toHaveCount(5)
  expect(errors).toEqual([])
})

test('a guest has no account to attach hosts to, and signing in on the same cache shows them', async ({
  page,
}) => {
  const errors = await open(page, ['data-guest'])
  await expect(page.getByText('Self-hosted hosts need a signed-in account.')).toBeVisible()
  await expect(hosts(page)).toHaveCount(0)
  await run(page, `(s) => s.setAccount('user-a')`)
  await expect(hosts(page)).toHaveCount(4)
  await expect(page.getByText('Self-hosted hosts need a signed-in account.')).toHaveCount(0)
  // Signing out leaves nothing of the account on screen.
  await run(page, `(s) => s.setAccount(null)`)
  await expect(page.getByText('Self-hosted hosts need a signed-in account.')).toBeVisible()
  await expect(hosts(page)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a stale bootstrap answer for the previous account cannot change the section’s account', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(hosts(page)).toHaveCount(4)
  // The shell's shared bootstrap read for user-a is still in flight when the account changes.
  await run(page, `(s) => { s.state.holdBootstrap = true; s.startBootstrap() }`)
  await run(page, `(s) => s.setAccount('user-b')`)
  await expect(page.getByText('No self-hosted host is registered in this workspace.')).toBeVisible()
  await run(page, `(s) => s.releaseBootstrap()`)
  // The old answer lands in the shared cache, and the section does not follow it.
  await expect.poll(() => run(page, `(s) => s.cachedPrincipal()`)).toBe('user-a')
  await expect(hosts(page)).toHaveCount(0)
  expect(await text(page)).not.toContain('Home server')
  expect(errors).toEqual([])
})

// A host-list read for one account or workspace is still in flight when the dialog moves to
// another. The answer belongs to the scope that asked, so it must not appear in the new one.
async function holdRefresh(page: Page) {
  await run(page, `(s) => { s.state.holdList = true }`)
  await page.getByRole('button', { name: 'Refresh hosts' }).first().click()
  // The fake consumes the hold when the read reaches it, so the read is now in flight.
  await expect.poll(() => run(page, `(s) => s.state.holdList`)).toBe(false)
}
const settle = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(done, 400)))

test('a held host-list answer for the previous account cannot appear after an account switch', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(hosts(page)).toHaveCount(4)
  await holdRefresh(page)
  await run(page, `(s) => s.setAccount('user-b')`)
  await expect(page.getByText('No self-hosted host is registered in this workspace.')).toBeVisible()
  await run(page, `(s) => s.releaseList()`)
  await settle(page)
  await expect(hosts(page)).toHaveCount(0)
  expect(await text(page)).not.toContain('Home server')
  // Back on the first account its own list is read again.
  await run(page, `(s) => s.setAccount('user-a')`)
  await expect(hosts(page)).toHaveCount(4)
  expect(errors).toEqual([])
})

test('a held host-list answer for the previous workspace cannot appear after a workspace switch', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(hosts(page)).toHaveCount(4)
  await holdRefresh(page)
  await run(page, `(s) => s.setWorkspace('ws-2')`)
  await expect(page.getByText('No self-hosted host is registered in this workspace.')).toBeVisible()
  await run(page, `(s) => s.releaseList()`)
  await settle(page)
  await expect(hosts(page)).toHaveCount(0)
  expect(await text(page)).not.toContain('Home server')
  await run(page, `(s) => s.setWorkspace('ws-1')`)
  await expect(hosts(page)).toHaveCount(4)
  expect(errors).toEqual([])
})
