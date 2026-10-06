// Repositories panel e2e: the removal path for adopted repositories (owner
// request). The production RepoRegistryPanel runs over a deterministic
// registry — one adopted repository, one managed clone, one binding-only row
// — and applies remove/adopt mutations to its in-memory state, so the
// panel's reload observes the same moves the real register makes: removal
// drops only the record, the project binding survives as the honest
// binding-only row, and nothing re-adopts it in the background.
import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const HARNESS_PATH = '/__repo-registry-panel'
const ADOPTED = 'li[data-repo-id="44444444-4444-4444-8444-444444444444"]'
const MANAGED = 'li[data-repo-id="55555555-5555-4555-8555-555555555555"]'
const BINDING_ONLY = 'li[data-repo-id="66666666-6666-4666-8666-666666666666"]'

test.use({ headless: true })

test.beforeEach(async ({ page }) => {
  await page.route(`**${HARNESS_PATH}*`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(HARNESS_PATH)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/repo-registry-panel-harness-app.tsx')
  )
  await expect(page.getByTestId('ready')).toHaveText('ready')
  // The panel renders inside the sidebar's collapsible group; open it the
  // way the Dev view's tree does before asserting on rows.
  await page.locator('main > details > summary').click()
})

/** The four registry reads the panel performs on every (re)load. */
async function loadedCatalog(page: Page): Promise<string[]> {
  const operations: string[] = JSON.parse(await page.getByTestId('operations').innerText())
  return operations.slice(0, 4)
}

test('an adopted repository can be removed behind an explicit confirm gate', async ({ page }) => {
  const adopted = page.locator(ADOPTED)
  await expect(adopted).toContainText('ready')
  await expect(adopted.getByRole('button', { name: 'Remove…' })).toBeVisible()

  // The confirm gate says exactly what removal does and does not touch.
  await adopted.getByRole('button', { name: 'Remove…' }).click()
  const confirm = adopted.getByRole('alert', { name: /Confirm removing adea/ })
  await expect(confirm).toContainText('stays bound and returns to the unregistered state')
  await expect(confirm).toContainText('nothing on disk is deleted')

  // Keep keeps everything.
  await confirm.getByRole('button', { name: 'Keep' }).click()
  await expect(adopted).toContainText('ready')

  // Remove drops only the registry record: the row falls back to the honest
  // binding-only state and nothing re-adopts it in the background.
  await adopted.getByRole('button', { name: 'Remove…' }).click()
  await adopted
    .getByRole('alert', { name: /Confirm removing adea/ })
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect(page.locator(ADOPTED)).toContainText('not adopted')
  await expect(page.getByTestId('announcement')).toContainText(
    'Removed adea from the registry; its project stays bound.'
  )
  // No automatic re-adopt ran: removal is the only mutation so far.
  const operations: string[] = JSON.parse(await page.getByTestId('operations').innerText())
  expect(operations).toContain('dev.repo.remove')
  expect(operations).not.toContain('dev.repo.adopt')
})

test('managed and binding-only rows offer no remove; a removed row can be adopted again', async ({
  page,
}) => {
  const managed = page.locator(MANAGED)
  await expect(managed).toContainText('ready')
  await expect(managed.getByRole('button', { name: 'Remove…' })).toHaveCount(0)

  const bindingOnly = page.locator(BINDING_ONLY)
  await expect(bindingOnly).toContainText('not adopted')
  await expect(bindingOnly.getByRole('button', { name: 'Remove…' })).toHaveCount(0)

  // Removing, then adopting the same binding, is the owner's full undo/redo.
  const adopted = page.locator(ADOPTED)
  await adopted.getByRole('button', { name: 'Remove…' }).click()
  await adopted
    .getByRole('alert', { name: /Confirm removing adea/ })
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect(page.locator(ADOPTED)).toContainText('not adopted')
  await page.locator(ADOPTED).getByRole('button', { name: 'Adopt…' }).click()
  await page
    .locator(ADOPTED)
    .getByRole('group', { name: 'Adopt repository' })
    .getByRole('button', { name: 'Adopt', exact: true })
    .click()
  await expect(page.locator(ADOPTED)).toContainText('ready')
  // Every reload re-reads the whole catalog, and the two mutations are the
  // only writes: removal never re-adopts by itself.
  const operations: string[] = JSON.parse(await page.getByTestId('operations').innerText())
  expect(await loadedCatalog(page)).toEqual(
    expect.arrayContaining([
      'dev.project.list',
      'dev.repo.list',
      'dev.project.bookmarks',
      'dev.repo.credentialRefs',
    ])
  )
  expect(
    operations.filter(
      (operation) => operation === 'dev.repo.remove' || operation === 'dev.repo.adopt'
    )
  ).toEqual(['dev.repo.remove', 'dev.repo.adopt'])
})

test('a refused removal surfaces a typed notice and keeps the row', async ({ page }) => {
  // The harness refuses removals for this run (?refuse=remove): the panel
  // must surface the typed notice, reload the authoritative state, and keep
  // the adopted row exactly as it was.
  await page.goto(`${HARNESS_PATH}?refuse=remove`)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/repo-registry-panel-harness-app.tsx')
  )
  await expect(page.getByTestId('ready')).toHaveText('ready')
  await page.locator('main > details > summary').click()
  const adopted = page.locator(ADOPTED)
  await adopted.getByRole('button', { name: 'Remove…' }).click()
  await adopted
    .getByRole('alert', { name: /Confirm removing adea/ })
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect(adopted).toContainText('ready')
  await expect(page.locator('p[role="alert"]')).toContainText('Remove was refused')
  await expect(page.locator(ADOPTED)).toBeVisible()
})
