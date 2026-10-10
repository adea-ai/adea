import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { runtimeFixtureNodeIds } from './helpers/runtime-inventory-fixture'
import axe from 'axe-core'

async function openInventory(page: Page, mode = 'inventory', section = 'connections') {
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.route('**/__runtime-inventory', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(`/__runtime-inventory#workspace-settings/${section}`)
  await page.locator('#harness-root').evaluate((root, value) => {
    root.setAttribute('data-control-plane', 'scoped')
    root.setAttribute('data-runtime-inventory', value)
    root.setAttribute('data-theme-provider', '')
  }, mode)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-settings-harness-app.tsx')
  )
  return errors
}

type RecordedRequest = { method: string; path: string }

/** Every request the harness recorded, by method and path (bodies are not compared here). */
async function recordedRequests(page: Page): Promise<RecordedRequest[]> {
  const raw = await page.locator('#harness-root').getAttribute('data-requests')
  return raw === null
    ? []
    : (JSON.parse(raw) as RecordedRequest[]).map(({ method, path }) => ({ method, path }))
}

/**
 * General reads the owner's archived workspaces (#1175) and nothing else. Asserted exactly, so any
 * other request from General fails the test rather than being filtered out.
 */
const GENERAL_REQUESTS: RecordedRequest[] = [{ method: 'GET', path: '/api/workspaces/archived' }]
/**
 * Per-host reads (runtime inventory, health and grants) live under one host's `runtime-nodes/:id`
 * route. The bare `runtime-nodes` path is the host list the Connections tab renders before any host
 * opens, so it is not a per-host read.
 */
const perHostRequests = (requests: RecordedRequest[]) =>
  requests.filter(({ path }) => /\/runtime-nodes\/[^/]+/u.test(path))

test('inventory is lazy, separates health/grants and keeps pagination within the inspected host', async ({
  page,
}) => {
  const errors = await openInventory(page, 'inventory', 'general')
  await expect.poll(() => recordedRequests(page)).toEqual(GENERAL_REQUESTS)
  await page.getByRole('tab', { name: 'Connections', exact: true }).click()
  await expect(page.getByRole('button', { name: 'View runtimes on Laptop' })).toBeVisible()
  // Opening the tab reads the host list and no host's inventory, health or grants: those wait for a host to open.
  expect(perHostRequests(await recordedRequests(page))).toEqual([])
  await page.getByRole('button', { name: 'View runtimes on Laptop' }).focus()
  await expect(page.getByRole('button', { name: 'View runtimes on Laptop' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Reported eligible', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Not reported by discovery; the actual execution reports its transport.')
  ).toBeVisible()
  await page.getByRole('button', { name: 'Next runtimes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'External harness', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Managed Pi', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Previous runtimes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Managed Pi', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View runtimes on Home server' }).click()
  await expect(page.getByText('offline · health offline', { exact: true })).toBeVisible()
  await expect(
    page.getByText('disconnected · health unavailable · offline', { exact: true })
  ).toBeVisible()
  await expect(page.getByText('Grant required · missing', { exact: true })).toBeVisible()
  await expect(page.getByText('Reported ineligible', { exact: true })).toBeVisible()
  const requests = JSON.parse(
    (await page.locator('#harness-root').getAttribute('data-requests'))!
  ) as { path: string; method: string }[]
  expect(
    requests
      .filter((request) => request.path.includes('runtime-nodes'))
      .every((request) => request.method === 'GET')
  ).toBe(true)
  expect(requests.some((request) => request.path.includes(runtimeFixtureNodeIds[1]))).toBe(true)
  expect(errors).toEqual([])
})

for (const theme of ['light', 'dark'] as const)
  for (const width of [320, 768, 1024, 1440]) {
    test(`inventory layout and accessibility at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.addInitScript((mode) => localStorage.setItem('theme', mode), theme)
      const errors = await openInventory(page)
      await page.getByRole('button', { name: 'View runtimes on Home server' }).click()
      await expect(page.getByText('Reported ineligible', { exact: true })).toBeVisible()
      const dialog = page.getByRole('dialog')
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true)
      const panel = page.locator('#workspace-settings-panel-connections')
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true)
      expect(
        await page
          .locator('.workspace-runtime-inventory h2')
          .evaluateAll((headings) =>
            headings.every((heading) => heading.scrollWidth <= heading.clientWidth + 1)
          )
      ).toBe(true)
      await page.getByRole('button', { name: 'Refresh runtimes', exact: true }).focus()
      await expect(
        page.getByRole('button', { name: 'Refresh runtimes', exact: true })
      ).toBeFocused()
      await page.screenshot({ path: testInfo.outputPath(`inventory-${theme}-${width}.png`) })
      await page.addScriptTag({ content: axe.source })
      const violations = await page.evaluate(async () => {
        const audit = window as typeof window & {
          axe: {
            run: (context: Element, options: unknown) => Promise<{ violations: { id: string }[] }>
          }
        }
        return (
          await audit.axe.run(document.querySelector('[role="dialog"]')!, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
          })
        ).violations.map((violation) => violation.id)
      })
      expect(violations).toEqual([])
      expect(errors).toEqual([])
    })
  }

for (const [mode, text] of [
  ['empty', 'No execution hosts are registered in this workspace.'],
  ['forbidden', 'Only workspace owners and admins can inspect execution hosts.'],
  [
    'unavailable',
    'The Control Plane is unavailable for this host. Registration is retained; refresh to try again.',
  ],
  ['empty-runtime', 'No runtimes were reported for this host.'],
  ['identity-mismatch', 'The host identity changed. Refresh hosts before inspecting runtimes.'],
  ['revoked-on-read', 'Host revoked'],
] as const)
  test(`${mode} is an explicit state`, async ({ page }) => {
    const errors = await openInventory(page, mode)
    if (!['empty', 'forbidden'].includes(mode))
      await page.getByRole('button', { name: 'View runtimes on Laptop' }).click()
    await expect(page.getByText(text, { exact: true })).toBeVisible()
    expect(await page.content()).not.toContain('sensitive-error-canary')
    expect(errors).toEqual([])
  })

test('failed refresh hides prior inventory and does not leak server error text', async ({
  page,
}) => {
  const errors = await openInventory(page)
  await page.getByRole('button', { name: 'View runtimes on Laptop' }).click()
  await expect(page.getByText('Reported eligible', { exact: true })).toBeVisible()
  await page
    .locator('#harness-root')
    .evaluate((root) => root.setAttribute('data-runtime-inventory', 'failure'))
  await page.getByRole('button', { name: 'Refresh runtimes', exact: true }).click()
  await expect(
    page.getByText('Execution hosts could not be loaded. Refresh to try again.')
  ).toBeVisible()
  await expect(page.getByText('Reported eligible', { exact: true })).toHaveCount(0)
  expect(await page.content()).not.toContain('sensitive-error-canary')
  expect(errors).toEqual([])
})

test('closing cancels discovery and late results cannot populate a reopened inspector', async ({
  page,
}) => {
  const errors = await openInventory(page, 'delayed')
  await page.getByRole('button', { name: 'View runtimes on Laptop' }).click()
  await expect(page.getByText('Loading runtimes…', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#harness-root')).toHaveAttribute('data-runtime-aborted', 'true')
  await page.evaluate(() => window.dispatchEvent(new Event('runtime-fixture-release')))
  await page.getByRole('button', { name: 'Open settings fixture' }).click()
  await page.getByRole('tab', { name: 'Connections', exact: true }).click()
  await expect(page.getByRole('button', { name: 'View runtimes on Laptop' })).toBeVisible()
  await expect(page.getByText('Reported eligible', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('observations age on screen without background discovery calls', async ({ page }) => {
  await page.clock.install()
  const errors = await openInventory(page)
  await page.getByRole('button', { name: 'View runtimes on Laptop' }).click()
  await expect(page.getByText('Reported eligible', { exact: true })).toBeVisible()
  const requests = await page.locator('#harness-root').getAttribute('data-requests')
  await page.clock.fastForward(300_001)
  await expect(page.getByText('Refresh required', { exact: true })).toBeVisible()
  expect(await page.locator('#harness-root').getAttribute('data-requests')).toBe(requests)
  expect(errors).toEqual([])
})

for (const detail of [{ workspaceId: 'other-workspace' }, { replaceClient: true }])
  test(`scope replacement cancels old discovery ${JSON.stringify(detail)}`, async ({ page }) => {
    const errors = await openInventory(page, 'delayed')
    await page.getByRole('button', { name: 'View runtimes on Laptop' }).click()
    await expect(page.getByText('Loading runtimes…', { exact: true })).toBeVisible()
    await page
      .locator('#harness-root')
      .evaluate((root) => root.setAttribute('data-runtime-inventory', 'inventory'))
    await page.evaluate(
      (value) =>
        window.dispatchEvent(new CustomEvent('runtime-fixture-switch-scope', { detail: value })),
      detail
    )
    await expect(page.locator('#harness-root')).toHaveAttribute('data-runtime-aborted', 'true')
    await expect(page.getByRole('button', { name: 'View runtimes on Laptop' })).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('runtime-fixture-release')))
    await expect(
      page.getByRole('heading', { name: 'Runtimes on Laptop', exact: true })
    ).toHaveCount(0)
    expect(errors).toEqual([])
  })

test('reported capabilities remain visible when detailed support is unreported', async ({
  page,
}) => {
  const errors = await openInventory(page, 'capability-details-unreported')
  await page.getByRole('button', { name: 'View runtimes on Laptop' }).click()
  await expect(page.getByText('execute', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('a future host-list proof cannot be hidden by a recent discovery proof', async ({ page }) => {
  const errors = await openInventory(page, 'future-proof-list')
  await page.getByRole('button', { name: 'View runtimes on Laptop' }).click()
  await expect(page.getByText('Refresh required', { exact: true })).toBeVisible()
  await expect(page.getByText('Reported eligible', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})
