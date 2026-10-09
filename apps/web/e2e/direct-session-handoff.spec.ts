// Direct-session handoff mounted interactions (#1177).
//
// Mounted Playwright proof for the paths unit tests cannot reach: lead-turn
// facts drive the coordinating modes (nothing is invented from the bound
// run), stopping the LEAD goes through the canonical lead-turn cancel
// handler while stopping the SESSION run goes through the bound harness
// cancel, busy/single-flight/error behavior is reactive in the live
// surface, late completions cannot leak across sessions, replacement runs
// never inherit stale candidates, and the controls meet keyboard/focus/
// zoom/reduced-motion acceptance in a real browser. The harness serves a
// scripted ChatView with lead-turn facts plus deferred lead/session
// cancels; no backend, database, or shared service is touched. The vite
// server binds an ephemeral loopback port and closes after the file.
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
  // The bound run proves execution, not a chief-of-staff handoff: the lead
  // row fails closed naming the missing turn, while the session run it does
  // own stays stoppable and the unowned rows name their gaps.
  const leadStop = page.getByRole('button', { name: 'Stop lead', exact: true })
  await expect(leadStop).toBeDisabled()
  await expect(page.locator(`#${await leadStop.getAttribute('aria-describedby')}`)).toContainText(
    'No lead turn is bound'
  )
  await expect(page.getByRole('button', { name: 'Stop session run', exact: true })).toBeEnabled()
  expectNoErrors(errors)
})

test('an observed live turn coordinates with distinct lead and session stops', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await expect(section(page).getByText('Coordination handoff', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Lead turn state')).toHaveText('running')

  await page.getByRole('button', { name: 'Stop lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stopping lead…', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop session run', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Resolve lead cancel' }).click()

  // The canonical cancel completed the turn: the session returned with its
  // run, draft, and generation intact, and the session run was never touched.
  await expect(section(page).getByText('Returned to user', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Lead cancel calls')).toHaveText('1')
  await expect(page.getByLabel('Session cancel calls')).toHaveText('0')
  await expect(page.getByLabel('Active draft')).toHaveText('unsent coordination note')
  expectNoErrors(errors)
})

test('concurrent starts admit once: double activation never duplicates the cancel', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await page.getByRole('button', { name: 'Stop lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stopping lead…', exact: true })).toBeVisible()

  // Disabled rows swallow activation: force-clicking the busy row and the
  // paused sibling dispatches nothing.
  await page.getByRole('button', { name: 'Stopping lead…', exact: true }).click({ force: true })
  await page.getByRole('button', { name: 'Stop session run', exact: true }).click({ force: true })
  await expect(page.getByLabel('Lead cancel calls')).toHaveText('1')
  await expect(page.getByLabel('Session cancel calls')).toHaveText('0')

  await page.getByRole('button', { name: 'Resolve lead cancel' }).click()
  await expect(section(page).getByText('Returned to user', { exact: true })).toBeVisible()
  expectNoErrors(errors)
})

test('a replaced register run retargets session-stop instead of applying stale facts', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  // The register now binds run-2 while supplied facts still name run-1: the
  // supplier resolves by the current binding, so the stale object can never
  // be applied — and the stop names the new run explicitly.
  await page.getByRole('button', { name: 'Replace bound run' }).click()
  const sessionStop = page.getByRole('button', { name: 'Stop session run', exact: true })
  await expect(sessionStop).toBeEnabled()
  await sessionStop.click()
  await page.getByRole('button', { name: 'Resolve session cancel' }).click()
  await expect(page.getByLabel('Cancelled run ids')).toHaveText('run-2')
  // Lead coordination (bound to the turn, not the run) is unaffected.
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeEnabled()

  // Supplying the fresh run object validates the binding the same way.
  await page.getByRole('button', { name: 'Supply replacement run facts' }).click()
  await expect(sessionStop).toBeEnabled()
  expectNoErrors(errors)
})

test('a late completion cannot mark the newly selected session coordinated', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await page.getByRole('button', { name: 'Stop lead', exact: true }).click()
  await page.getByRole('button', { name: 'Show session 2' }).click()
  await page.getByRole('button', { name: 'Resolve lead cancel' }).click()

  // The superseded completion commits nothing on the new session: no error,
  // no mode change attributable to it.
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('Lead cancel calls')).toHaveText('1')

  await page.getByRole('button', { name: 'Show session 1' }).click()
  // The dropped completion contributed nothing: session 1 shows the
  // terminal turn from re-read facts (returned), not from the superseded
  // receipt — the mode comes from stored facts, never stale local state.
  await expect(section(page).getByText('Returned to user', { exact: true })).toBeVisible()
  expectNoErrors(errors)
})

test('ABA: an old completion cannot clear a new action’s busy state', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await page.getByRole('button', { name: 'Stop lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stopping lead…', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show session 2' }).click()
  await page.getByRole('button', { name: 'Show session 1' }).click()
  await page.getByRole('button', { name: 'Stop session run', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Stopping session run…', exact: true })
  ).toBeVisible()

  // The oldest intent (from before navigation) resolves first: the epoch
  // fence drops it, and the new action stays busy with no error parked.
  await page.getByRole('button', { name: 'Resolve lead cancel' }).click()
  await expect(
    page.getByRole('button', { name: 'Stopping session run…', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('Lead cancel calls')).toHaveText('1')
  await expect(page.getByLabel('Session cancel calls')).toHaveText('1')

  await page.getByRole('button', { name: 'Resolve session cancel' }).click()
  await expect(page.getByLabel('Cancelled run ids')).toHaveText('run-1')
  expectNoErrors(errors)
})

test('browser reload retains the re-read lead-turn facts', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await expect(section(page).getByText('Coordination handoff', { exact: true })).toBeVisible()

  // A fresh mount holds no UI state: coordination must come from the
  // re-read facts alone, with run, draft, and generation intact.
  await page.reload()
  await expect(
    page.getByRole('region', { name: 'Direct session handoff' }).getByText('Coordination handoff', {
      exact: true,
    })
  ).toBeVisible()
  await expect(section(page).getByText('gen 3', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Active draft')).toHaveText('unsent coordination note')
  await expect(page.getByLabel('Lead turn state')).toHaveText('running')
  expectNoErrors(errors)
})

test('keyboard reachability, visible focus, and keyboard activation', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
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
    if (stop?.name === 'Stop lead') {
      focusedName = stop.name
      expect(stop.focusVisible).toBe(true)
      break
    }
  }
  expect(focusedName).toBe('Stop lead')

  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Stopping lead…', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resolve lead cancel' }).click()
  await expect(section(page).getByText('Returned to user', { exact: true })).toBeVisible()
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
  await expect(page.getByRole('button', { name: 'Stop session run', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Go online' }).click()
  await expect(page.getByRole('button', { name: 'Stop session run', exact: true })).toBeEnabled()
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
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop session run', exact: true })).toBeVisible()
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
    await page.getByRole('button', { name: 'Observe live lead turn' }).click()
    await expect(handoff.getByText('Coordination handoff', { exact: true })).toBeVisible()
    expectNoErrors(errors)
  })
})
