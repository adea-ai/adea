// Real-backend regression for a `?workspace=<owned id>` deep link (Home receipt 1725).
// No request is mocked. Before the one-switch guard in workspace-navigation.tsx, the
// link re-ran its switch after every settle: the page kept issuing same-URL history
// writes, starved its own network responses, and never reached the shell.
import { expect, test } from '@playwright/test'

/** Counts history writes from the first paint, so a re-switch loop is visible. */
const countHistoryWrites = () => {
  let writes = 0
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = History.prototype[method]
    History.prototype[method] = function (
      this: History,
      state: unknown,
      unused: string,
      url?: string | URL | null
    ) {
      writes += 1
      ;(window as unknown as { historyWriteCount: number }).historyWriteCount = writes
      return original.call(this, state, unused, url)
    }
  }
}

test('a ?workspace= link to an owned workspace settles into the shell', async ({ page }) => {
  await page.addInitScript(countHistoryWrites)
  // Mint the temporary session and create the target through the app's own routes.
  const context = page.context()
  const bootstrap = await context.request.post('/api/workspaces/bootstrap')
  expect(bootstrap.ok()).toBe(true)
  const created = await context.request.post('/api/workspaces', {
    data: { name: 'Deep link target', scene: 'work' },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  })
  expect(created.ok(), `create workspace: ${created.status()}`).toBe(true)
  const body = (await created.json()) as { workspace?: { id: string }; id?: string }
  const targetId = body.workspace?.id ?? body.id
  expect(targetId).toBeTruthy()

  await page.goto(`/?workspace=${encodeURIComponent(targetId!)}`, { timeout: 120_000 })
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible({
    timeout: 120_000,
  })
  // The link is consumed once the switch lands: the param is stripped from the URL.
  await expect
    .poll(() => new URL(page.url()).searchParams.has('workspace'), { timeout: 30_000 })
    .toBe(false)
  // A settled link writes the URL a handful of times, not once per settle.
  await page.waitForTimeout(1_000)
  const writes = await page.evaluate(
    () => (window as unknown as { historyWriteCount?: number }).historyWriteCount ?? 0
  )
  expect(writes, 'history writes after the deep link').toBeLessThanOrEqual(10)
})
