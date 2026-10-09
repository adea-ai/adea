// Direct-session handoff mounted interactions (#1177).
//
// Mounted Playwright proof for the joined journey the unit tests cannot
// reach: a direct-user session attaches read-only, an explicit handoff
// transfer establishes coordination, a return transfer completes it, and
// late or superseded completions can never overwrite canonical ownership.
// Busy/single-flight/error behavior is reactive in the live surface, and the
// controls meet keyboard/focus/zoom/reduced-motion acceptance in a real
// browser. The harness serves a scripted ChatView (pending transfer/cancel
// intents resolve from fixture buttons, with exact directions recorded); no
// backend, database, or shared service is touched. The vite server binds an
// ephemeral loopback port and closes after the file.
import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import solid from 'vite-plugin-solid'

let server: ViteDevServer | undefined
let url = ''
test.beforeAll(async () => {
  const root = resolve(process.cwd(), 'apps/web')
  const harness = '/@fs' + resolve(root, 'e2e/helpers/direct-session-handoff-harness-app.tsx')
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [
      solid(),
      {
        name: 'direct-handoff-mounted-fixture',
        configureServer(fixture) {
          fixture.middlewares.use('/__direct-handoff', (_request, response) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(
              `<html><body><div id="harness-root"></div><script type="module" src="${harness}"></script></body></html>`
            )
          })
        },
      },
    ],
    resolve: { dedupe: ['solid-js'], conditions: ['solid', 'browser', 'development'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Handoff fixture did not bind')
  url = `http://127.0.0.1:${address.port}/__direct-handoff`
})
test.afterAll(async () => {
  await server?.close()
})

function trackPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

async function openHarness(page: Page): Promise<string[]> {
  const errors = trackPageErrors(page)
  await page.goto(url)
  await expect(page.getByRole('region', { name: 'Direct session handoff' })).toBeVisible()
  return errors
}

function expectNoErrors(errors: readonly string[]): void {
  expect(errors).toEqual([])
}

function section(page: Page) {
  return page.getByRole('region', { name: 'Direct session handoff' })
}

test('a direct session attaches read-only: nothing is invented from the bound run', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()
  // The bound run proves execution, not a handoff: coordination controls
  // stay blocked while the explicit handoff is offered.
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Return to user', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeDisabled()
  expectNoErrors(errors)
})

test('explicit handoff then return complete the joined journey with one receipt each', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()

  await expect(page.getByRole('button', { name: 'Handing off…', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()

  await expect(section(page).getByText('Coordination handoff', { exact: true })).toBeVisible()
  await expect(section(page).getByText('gen 4', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Transfer calls')).toHaveText('1')
  await expect(page.getByLabel('Last transfer direction')).toHaveText('chat→dev')
  await expect(page.getByRole('button', { name: 'Return to user', exact: true })).toBeEnabled()

  await page.getByRole('button', { name: 'Return to user', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Returning…', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()

  await expect(section(page).getByText('Returned to user', { exact: true })).toBeVisible()
  await expect(section(page).getByText('gen 5', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Transfer calls')).toHaveText('2')
  await expect(page.getByLabel('Last transfer direction')).toHaveText('dev→chat')
  // The confirmed receipts preserve the unsent draft through the live surface.
  await expect(page.getByLabel('Active draft')).toHaveText('unsent coordination note')
  expectNoErrors(errors)
})

test('concurrent starts admit once: double activation never duplicates the transfer', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Handing off…', exact: true })).toBeVisible()

  // Disabled rows swallow activation: force-clicking the busy row and the
  // paused sibling dispatches nothing.
  await page.getByRole('button', { name: 'Handing off…', exact: true }).click({ force: true })
  await page.getByRole('button', { name: 'Return to user', exact: true }).click({ force: true })
  await expect(page.getByLabel('Transfer calls')).toHaveText('1')
  await expect(page.getByLabel('Cancel calls')).toHaveText('0')

  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()
  await expect(section(page).getByText('Coordination handoff', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Transfer calls')).toHaveText('1')
  expectNoErrors(errors)
})

test('a stale rejection surfaces conflict truthfully and resolve-then-retry succeeds', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()
  await page.getByRole('button', { name: 'Return to user', exact: true }).click()
  await page.getByRole('button', { name: 'Reject pending transfer stale' }).click()

  await expect(page.getByRole('alert').getByText(/input owner version conflict/)).toBeVisible()
  await expect(page.getByRole('alert').getByText(/Another coordinator holds control/)).toBeVisible()
  // The conflict parks at this generation: retry stays blocked until the
  // concurrent commit is observed.
  await expect(page.getByLabel('Transfer calls')).toHaveText('2')
  await expect(page.getByRole('button', { name: 'Return to user', exact: true })).toBeDisabled()

  await page.getByRole('button', { name: 'Observe concurrent generation' }).click()
  // The concurrent commit superseded our handoff receipt too: coordination
  // restarts from an explicit handoff, never from a stale assumption.
  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()
  await expect(section(page).getByText('Coordination handoff', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Return to user', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()
  await expect(section(page).getByText('Returned to user', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Transfer calls')).toHaveText('4')
  expectNoErrors(errors)
})

test('newer canonical ownership is never overwritten by a stale local receipt', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()
  await page.getByRole('button', { name: 'Return to user', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()
  await expect(section(page).getByText('Returned to user', { exact: true })).toBeVisible()

  // Ownership moves on underneath the receipt: the surface falls back to
  // attachment with the newer-ownership notice instead of clinging to it.
  await page.getByRole('button', { name: 'Observe concurrent generation' }).click()
  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()
  await expect(
    section(page).getByText(/Coordination changed since the confirmed transfer/)
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Return to user', exact: true })).toBeDisabled()
  expectNoErrors(errors)
})

test('a late completion cannot mark the newly selected session coordinated', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await page.getByRole('button', { name: 'Show session 2' }).click()

  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()

  // The superseded receipt commits nothing: no coordinating label, no alert.
  await expect(section(page).getByText('Coordination handoff', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('Transfer calls')).toHaveText('1')

  // The first session is untouched too: its late completion was dropped.
  await page.getByRole('button', { name: 'Show session 1' }).click()
  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()
  expectNoErrors(errors)
})

test('keyboard reachability, visible focus, and keyboard activation', async ({ page }) => {
  const errors = await openHarness(page)
  let focusedName: string | undefined
  for (let tab = 0; tab < 40; tab += 1) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const active = document.activeElement
      if (!active) return null
      const name =
        active.getAttribute('aria-label') ?? (active.textContent ?? '').trim().slice(0, 80)
      return {
        name,
        focusVisible: active instanceof HTMLElement && active.matches(':focus-visible'),
      }
    })
    if (stop?.name === 'Hand off to lead') {
      focusedName = stop.name
      expect(stop.focusVisible).toBe(true)
      break
    }
  }
  expect(focusedName).toBe('Hand off to lead')

  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Handing off…', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resolve pending transfer' }).click()
  await expect(section(page).getByText('Coordination handoff', { exact: true })).toBeVisible()
  expectNoErrors(errors)
})

test('assistive-technology tree: names, disabled states, and reason linkage', async ({ page }) => {
  const errors = await openHarness(page)
  const job = page.getByRole('button', { name: 'Cancel job', exact: true })
  const descendants = page.getByRole('button', { name: 'Cancel descendants', exact: true })
  await expect(job).toBeDisabled()
  await expect(descendants).toBeDisabled()
  for (const button of [job, descendants]) {
    const describedby = await button.getAttribute('aria-describedby')
    expect(describedby).not.toBeNull()
    await expect(page.locator(`#${describedby}`)).toContainText('control-plane#935')
  }

  await page.getByRole('button', { name: 'Go offline' }).click()
  await expect(
    section(page)
      .getByRole('alert')
      .getByText(/Runtime offline/)
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Go online' }).click()
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeEnabled()
  expectNoErrors(errors)
})

test('narrow viewport and 200% text keep every control reachable', async ({ page }) => {
  const errors = await openHarness(page)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px'
  })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(1)
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeVisible()
  expectNoErrors(errors)
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('no motion animation and full operability', async ({ page }) => {
    const errors = await openHarness(page)
    const handoff = section(page)
    const motion = await handoff.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        transitionDuration: computed.transitionDuration,
        animationName: computed.animationName,
      }
    })
    expect(motion).toEqual({ transitionDuration: '0s', animationName: 'none' })
    await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
    await page.getByRole('button', { name: 'Resolve pending transfer' }).click()
    await expect(handoff.getByText('Coordination handoff', { exact: true })).toBeVisible()
    expectNoErrors(errors)
  })
})
