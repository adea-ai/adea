// Real-backend regression for `?workspace=<owned id>` deep links (Home receipt 1725).
// No request is mocked. Before the one-switch guard, a link re-ran its switch after every
// settle: the page kept writing the same URL, starved its own network responses, and never
// reached the shell. The selected workspace is asserted through the shell's document title,
// which the shell derives from the active workspace (`<name> | Adea`).
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

test('a ?workspace= link selects the target, and a later revisit by ID selects it again', async ({
  page,
}) => {
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
  const targetTitle = 'Deep link target | Adea'

  // First visit: the link selects the target and is consumed.
  await page.goto(`/?workspace=${encodeURIComponent(targetId!)}`, { timeout: 120_000 })
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible({
    timeout: 120_000,
  })
  await expect(page).toHaveTitle(targetTitle, { timeout: 60_000 })
  await expect
    .poll(() => new URL(page.url()).searchParams.has('workspace'), { timeout: 30_000 })
    .toBe(false)
  await page.waitForTimeout(1_000)
  const firstWrites = await page.evaluate(
    () => (window as unknown as { historyWriteCount?: number }).historyWriteCount ?? 0
  )
  expect(firstWrites, 'history writes after the first link').toBeLessThanOrEqual(10)

  // Navigate away to the default entry, then come back with the same workspace ID.
  await page.goto('/', { timeout: 120_000 })
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible({
    timeout: 120_000,
  })
  await page.goto(`/?workspace=${encodeURIComponent(targetId!)}`, { timeout: 120_000 })
  await expect(page).toHaveTitle(targetTitle, { timeout: 60_000 })
  await expect
    .poll(() => new URL(page.url()).searchParams.has('workspace'), { timeout: 30_000 })
    .toBe(false)
})
