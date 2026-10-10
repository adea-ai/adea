// Direct-session handoff mounted interactions (#1177).
//
// Mounted Playwright proof for the paths unit tests cannot reach: the
// production resolver composes canonical roster, channel, and turn reads
// into the handoff supply; lead-turn facts drive the coordinating modes
// (nothing is invented from the bound run); stopping the LEAD goes
// through the canonical lead-turn cancel handler while stopping the
// SESSION run goes through the bound harness cancel; busy/single-flight/
// error behavior is reactive in the live surface; late completions cannot
// leak across sessions; replacement runs never inherit stale candidates;
// unlinked sessions ignore workspace turns; ambiguous links fail closed;
// and the controls meet keyboard/focus/zoom/reduced-motion acceptance in
// a real browser. The harness serves the production ChatView against the
// REAL resolver fed by a scripted port backend; no backend, database, or
// shared service is touched. The vite server binds an ephemeral loopback
// port and closes after the file.
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

test('turn initiation explains requesting and its limit', async ({ page }) => {
  const errors = await openHarness(page)
  // Fresh channel-linked session with no turn: the initiation guidance
  // names what requesting does and keeps the unverified-claim limit
  // explicit, beside the enabled request control.
  await expect(section(page).getByText(/Hand off to request lead coordination/)).toBeVisible()
  await expect(section(page).getByText(/retained request alone never coordinates/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeEnabled()
  expectNoErrors(errors)
})

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
    'No lead turn is claimed'
  )
  await expect(page.getByRole('button', { name: 'Stop session run', exact: true })).toBeEnabled()
  expectNoErrors(errors)
})

test('an effect-shaped live turn stays unavailable; stops stay distinct', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  // Requested reference only: no explicit target-bound observation exists,
  // so nothing coordinates — but the lead and session stops stay distinct.
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()
  await expect(page.getByLabel('Lead turn state')).toHaveText('running')

  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeEnabled()
  const sessionStop = page.getByRole('button', { name: 'Stop session run', exact: true })
  await expect(sessionStop).toBeEnabled()
  await sessionStop.click()
  await page.getByRole('button', { name: 'Resolve session cancel' }).click()

  // The session run cancelled with draft and generation intact, and the
  // lead turn was never touched: distinct authorities, one surface.
  await expect(page.getByLabel('Cancelled run ids')).toHaveText('run-1')
  await expect(page.getByLabel('Lead cancel calls')).toHaveText('0')
  await expect(page.getByLabel('Session cancel calls')).toHaveText('1')
  await expect(page.getByLabel('Active draft')).toHaveText('unsent coordination note')
  expectNoErrors(errors)
})

test('an unlinked session ignores the workspace turn', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()

  // Session 2 carries no task: the same workspace turn must not appear as
  // its coordination.
  await page.getByRole('button', { name: 'Show session 2' }).click()
  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeDisabled()

  await page.getByRole('button', { name: 'Show session 1' }).click()
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()
  expectNoErrors(errors)
})

test('an ambiguous task link fails closed instead of picking a channel', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()

  await page.getByRole('button', { name: 'Add ambiguous channel' }).click()
  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeDisabled()
  expectNoErrors(errors)
})

test('an unrelated channel never disables the linked handoff', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await page.getByRole('button', { name: 'Observe unrelated channel' }).click()
  // Other lead conversations are irrelevant: the tracked request stays put
  // and neither stop changes meaning. The session run stop is unaffected.
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Stop session run', exact: true })).toBeEnabled()
  expectNoErrors(errors)
})

test('explicit handoff admits through the canonical path with server-side recovery', async ({
  page,
}) => {
  const errors = await openHarness(page)
  // No turn observed yet: the handoff button offers an explicit request.
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Handing off…', exact: true })).toBeVisible()
  await expect(page.getByLabel('Admission posts')).toHaveText('1')

  // A transport failure loses nothing: every attempt mints a fresh key
  // and the server recovers the retained intent instead of duplicating.
  await page.getByRole('button', { name: 'Reject admission' }).click()
  await expect(page.getByRole('alert').getByText(/transport lost/)).toBeVisible()
  const keyBefore = await page.getByLabel('Admission keys').textContent()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByLabel('Admission posts')).toHaveText('2')
  const keysAfter = await page.getByLabel('Admission keys').textContent()
  expect(keysAfter?.split(',')).toHaveLength(2)
  expect(keysAfter?.split(',')[0]).not.toBe(keysAfter?.split(',')[1])
  expect(keyBefore?.split(',')).toHaveLength(1)

  // The admission commits a blocked turn: requested state with a status
  // check, then dispatch, then coordination.
  await page.getByRole('button', { name: 'Resolve admission' }).click()
  await expect(section(page).getByText(/requested for this session/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check lead status', exact: true })).toBeEnabled()
  // The turn dispatches without pushing: the view stays requested until
  // an explicit check re-reads it.
  await page.getByRole('button', { name: 'Advance turn silently' }).click()
  await expect(section(page).getByText(/requested for this session/)).toBeVisible()
  await page.getByRole('button', { name: 'Check lead status', exact: true }).click()
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  // Live and effect-shaped, yet still no coordination: no explicit
  // target-bound observation exists. The session's own live claim may
  // still be stopped — intent-scoped, actor-gated, claiming nothing.
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()
  await page.getByRole('button', { name: 'Stop lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stopping lead…', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resolve lead cancel' }).click()
  // The turn ended terminally with no coordination ever claimed; the
  // session run, draft, and descendants are untouched, and re-engaging
  // is offered.
  await expect(page.getByLabel('Lead cancel calls')).toHaveText('1')
  await expect(page.getByLabel('Session cancel calls')).toHaveText('0')
  await expect(page.getByLabel('Cancelled run ids')).toHaveText('')
  await expect(page.getByLabel('Active draft')).toHaveText('unsent coordination note')
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeEnabled()
  expectNoErrors(errors)
})

test('a stale request names both generations and re-requests cleanly', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve admission' }).click()
  await expect(section(page).getByText(/requested for this session/)).toBeVisible()
  // The session advances behind the request: the old context goes stale
  // by name, and a fresh request binds current generation.
  await page.getByRole('button', { name: 'Advance session generation' }).click()
  await expect(section(page).getByText(/generation 3.*generation 5/)).toBeVisible()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByLabel('Admission posts')).toHaveText('2')
  await page.getByRole('button', { name: 'Resolve admission' }).click()
  await expect(section(page).getByText(/requested for this session/)).toBeVisible()
  expectNoErrors(errors)
})

test('a foreign turn grants nothing and keeps handoff available', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe foreign lead turn' }).click()
  // The foreign turn never leaks: attached, handoff still offered. (The
  // named mismatch notice is unit-proven for unfiltered arrivals.)
  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve admission' }).click()
  await expect(section(page).getByText(/requested for this session/)).toBeVisible()
  expectNoErrors(errors)
})

test('ACTUAL stale session generation refuses before any post', async ({ page }) => {
  const errors = await openHarness(page)
  // The authority record advances behind the view: the view still shows
  // generation 3, but the host is at 5. No admission may be built.
  await page.getByRole('button', { name: 'Advance authority generation' }).click()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('alert').getByText(/advanced to generation 5/)).toBeVisible()
  await expect(page.getByLabel('Admission posts')).toHaveText('0')
  expectNoErrors(errors)
})

test('a wrong task binding refuses before any post', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Retarget authority task' }).click()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('alert').getByText(/bound to another task/)).toBeVisible()
  await expect(page.getByLabel('Admission posts')).toHaveText('0')
  expectNoErrors(errors)
})

test('revoked session control and phantom sessions refuse before any post', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Toggle session control' }).click()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('alert').getByText(/control permission/)).toBeVisible()
  await expect(page.getByLabel('Admission posts')).toHaveText('0')
  await page.getByRole('button', { name: 'Toggle session control' }).click()
  await page.getByRole('button', { name: 'Remove authority session' }).click()
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('alert').getByText(/not_found/)).toBeVisible()
  await expect(page.getByLabel('Admission posts')).toHaveText('0')
  expectNoErrors(errors)
})

test('a runtime binding to another session never coordinates', async ({ page }) => {
  const errors = await openHarness(page)
  // First a clean own-session claim tracks as requested...
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve admission' }).click()
  await expect(section(page).getByText(/requested for this session/)).toBeVisible()
  // ...then the runtime reports the execution elsewhere: the binding
  // mismatch is named instead, and nothing coordinates.
  await page.getByRole('button', { name: 'Observe mismatched binding' }).click()
  // Claimed for this session but observed elsewhere: the binding
  // mismatch is named, nothing coordinates. The live claim still holds
  // the request slot (a same-triple re-request would dedupe to it), so
  // hand-off stays disabled with the outstanding reason.
  await expect(section(page).getByText(/another session/)).toBeVisible()
  const handoff = page.getByRole('button', { name: 'Hand off to lead', exact: true })
  await expect(handoff).toBeDisabled()
  await expect(page.locator(`#${await handoff.getAttribute('aria-describedby')}`)).toContainText(
    'already outstanding'
  )
  expectNoErrors(errors)
})

test('a control-plane-reported observation displays without coordinating', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await page.getByRole('button', { name: 'Resolve admission' }).click()
  await expect(section(page).getByText(/requested for this session/)).toBeVisible()
  // The control plane reports execution elsewhere: the reported line
  // appears beside the request, coordination stays unavailable, and the
  // request path stays open for re-checks.
  await page.getByRole('button', { name: 'Observe CP-reported target' }).click()
  await expect(
    section(page).getByText(/Control plane reports execution in session ses_/)
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check lead status', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Check lead status', exact: true }).click()
  await expect(
    section(page).getByText(/Control plane reports execution in session ses_/)
  ).toBeVisible()
  expectNoErrors(errors)
})

test('a live observed turn blocks a second admission', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()
  const handoff = page.getByRole('button', { name: 'Hand off to lead', exact: true })
  await expect(handoff).toBeDisabled()
  await expect(page.locator(`#${await handoff.getAttribute('aria-describedby')}`)).toContainText(
    'already outstanding'
  )
  await expect(page.getByLabel('Admission posts')).toHaveText('0')
  expectNoErrors(errors)
})

test('concurrent starts admit once: double activation never duplicates the cancel', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Handing off…', exact: true })).toBeVisible()

  // Disabled rows swallow activation: force-clicking the busy row and the
  // paused sibling dispatches nothing.
  await page.getByRole('button', { name: 'Handing off…', exact: true }).click({ force: true })
  await page.getByRole('button', { name: 'Stop session run', exact: true }).click({ force: true })
  await expect(page.getByLabel('Admission posts')).toHaveText('1')
  await expect(page.getByLabel('Session cancel calls')).toHaveText('0')

  await page.getByRole('button', { name: 'Reject admission' }).click()
  await expect(page.getByRole('alert').getByText(/transport lost/)).toBeVisible()
  expectNoErrors(errors)
})

test('a replaced register run retargets session-stop instead of applying stale facts', async ({
  page,
}) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  // The register now binds run-2 with no run objects supplied: the stop
  // resolves by the current binding and names the new run explicitly.
  await page.getByRole('button', { name: 'Replace bound run' }).click()
  const sessionStop = page.getByRole('button', { name: 'Stop session run', exact: true })
  await expect(sessionStop).toBeEnabled()
  await sessionStop.click()
  await page.getByRole('button', { name: 'Resolve session cancel' }).click()
  await expect(page.getByLabel('Cancelled run ids')).toHaveText('run-2')
  // The claimed live turn stays stoppable throughout: stopping the
  // session run never implies lead control, and vice versa.
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeEnabled()

  // Supplying the fresh run object validates the binding the same way.
  await page.getByRole('button', { name: 'Supply replacement run facts' }).click()
  await expect(sessionStop).toBeEnabled()
  expectNoErrors(errors)
})

test('a late completion cannot mark the newly selected session coordinated', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Handing off…', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show session 2' }).click()
  await page.getByRole('button', { name: 'Resolve admission' }).click()

  // The superseded admission commits nothing on the new session: no error,
  // and session 2 (unlinked) stays attached.
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('Admission posts')).toHaveText('1')
  await expect(section(page).getByText('Attached · read-only reference')).toBeVisible()

  await page.getByRole('button', { name: 'Show session 1' }).click()
  await expect(section(page).getByText(/requested for this session/)).toBeVisible()
  expectNoErrors(errors)
})

test('ABA: an old completion cannot clear a new action’s busy state', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Hand off to lead', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Handing off…', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show session 2' }).click()
  await page.getByRole('button', { name: 'Show session 1' }).click()
  await page.getByRole('button', { name: 'Stop session run', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Stopping session run…', exact: true })
  ).toBeVisible()

  // The oldest intent (from before navigation) resolves first: the epoch
  // fence drops it, and the new action stays busy with no error parked.
  await page.getByRole('button', { name: 'Resolve admission' }).click()
  await expect(
    page.getByRole('button', { name: 'Stopping session run…', exact: true })
  ).toBeVisible()
  // The dropped admission parks no error: the only alert is the expected
  // requested-tracking notice for the newly observed turn.
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText(/requested for this session/)
  await expect(page.getByLabel('Admission posts')).toHaveText('1')
  await expect(page.getByLabel('Session cancel calls')).toHaveText('1')

  await page.getByRole('button', { name: 'Resolve session cancel' }).click()
  await expect(page.getByLabel('Cancelled run ids')).toHaveText('run-1')
  expectNoErrors(errors)
})

test('out-of-order resolutions apply newest-first: stale reads never win', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()

  await page.getByRole('button', { name: 'Defer reads' }).click()
  await page.getByRole('button', { name: 'Refresh lead resolution' }).click()
  // A newer observation commits while the older read is still queued.
  await page.getByRole('button', { name: 'Observe lead turn completed' }).click()
  // LIFO release completes the newer resolution first; the older one is
  // dropped by the epoch even though it resolves last. The completed
  // claim tracks as a re-engageable request, never a return.
  await page.getByRole('button', { name: 'Release reads LIFO' }).click()
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Hand off to lead', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Stop lead', exact: true })).toBeDisabled()
  expectNoErrors(errors)
})

test('browser reload retains the re-read lead-turn facts', async ({ page }) => {
  const errors = await openHarness(page)
  await page.getByRole('button', { name: 'Observe live lead turn' }).click()
  await expect(section(page).getByText(/no explicit target-bound/)).toBeVisible()

  // A fresh mount holds no UI state: the tracked request must come from
  // the re-read facts alone, with run, draft, and generation intact —
  // and still coordinate nothing without an explicit observation.
  await page.reload()
  await expect(
    page
      .getByRole('region', { name: 'Direct session handoff' })
      .getByText(/no explicit target-bound/)
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
    if (stop?.name === 'Stop session run') {
      focusedName = stop.name
      expect(stop.focusVisible).toBe(true)
      break
    }
  }
  expect(focusedName).toBe('Stop session run')

  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('button', { name: 'Stopping session run…', exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Resolve session cancel' }).click()
  await expect(page.getByLabel('Cancelled run ids')).toHaveText('run-1')
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
    await expect(handoff.getByText(/no explicit target-bound/, { exact: true })).toBeVisible()
    expectNoErrors(errors)
  })
})
