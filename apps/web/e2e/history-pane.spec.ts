// History pane: prompts with a reply summary, search over the same window, and
// accessible names that tell result buttons apart. Every result belongs to one
// session, so the session title alone would name each jump button identically;
// the matched event kind and preview have to reach the accessible name.
import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const HARNESS_PATH = '/__history-pane'

test.use({ headless: true })

async function mount(page: Page, query = '') {
  await page.route(`**${HARNESS_PATH}*`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(`${HARNESS_PATH}${query}`)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/history-pane-harness-app.tsx')
  )
  await expect(page.getByRole('group', { name: 'History view' })).toBeVisible()
}

test('lists prompts newest first with a reply summary', async ({ page }) => {
  await mount(page)
  const list = page.getByRole('list', { name: 'Prompts and replies, newest first' })
  const rows = list.getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('write the release notes')
  await expect(rows.first()).toContainText('No reply recorded')
  await expect(rows.last()).toContainText('deploy the staging build')
  await expect(rows.last()).toContainText('Staging is live; production awaits your approval.')
  await expect(rows.last()).toContainText('1 tool call')
  await expect(rows.last()).toContainText('Done')
})

test('a row expands to the full prompt and reply and reports its state', async ({ page }) => {
  await mount(page)
  const toggle = page.getByRole('button', { name: 'Show full prompt and reply' }).last()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const less = page.getByRole('button', { name: 'Show less of this prompt' })
  await expect(less).toHaveAttribute('aria-expanded', 'true')
  await less.click()
  await expect(page.getByRole('button', { name: 'Show less of this prompt' })).toHaveCount(0)
})

test('result buttons for one session carry distinct accessible names', async ({ page }) => {
  await mount(page)
  await page.getByRole('textbox', { name: 'Search this conversation' }).fill('deploy')
  await expect(page.getByRole('status').filter({ hasText: 'result' })).toContainText('for “deploy”')

  const jumps = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button', { name: /^Jump to Deploy planning,/ })
  const count = await jumps.count()
  expect(count).toBeGreaterThanOrEqual(2)
  const names = await jumps.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label'))
  )
  expect(new Set(names).size).toBe(count)
  expect(names).toContain('Jump to Deploy planning, prompt: deploy the staging build')
  expect(names).toContain('Jump to Deploy planning, approval: Deploy to production')

  await page
    .getByRole('button', { name: 'Jump to Deploy planning, approval: Deploy to production' })
    .click()
  await expect(page.getByTestId('jumps')).toHaveText('event-3')
})

test('clearing the search returns to the turns list', async ({ page }) => {
  await mount(page)
  const search = page.getByRole('textbox', { name: 'Search this conversation' })
  await search.fill('nothing matches this')
  await expect(page.getByText('No matching history')).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(search).toHaveValue('')
  await expect(page.getByRole('list', { name: 'Prompts and replies, newest first' })).toBeVisible()
})

test('pages through a full 1,000-event window without dropping rows', async ({ page }) => {
  await mount(page, '?turns=995&bounded=1')
  await expect(page.getByText('Showing the latest events only.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search this conversation' }).fill('filler prompt')
  const results = page.getByRole('list', { name: 'Search results' }).getByRole('listitem')
  await expect(results).toHaveCount(100)
  const more = page.getByRole('button', { name: 'Load more' })
  for (let loaded = 100; loaded < 995; loaded += 100) {
    await more.click()
    await expect(results).toHaveCount(Math.min(loaded + 100, 995))
  }
  await expect(more).toHaveCount(0)
})

test('shows a loading status while the feed opens', async ({ page }) => {
  await mount(page, '?status=loading')
  await expect(page.getByRole('status', { name: 'Loading history' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Search this conversation' })).toBeDisabled()
})

test('a stale feed says so, hides the partial list and offers a reload', async ({ page }) => {
  await mount(page, '?status=stale')
  await expect(page.getByRole('status').filter({ hasText: 'History is out of date' })).toBeVisible()
  await expect(page.getByText('deploy the staging build')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Search this conversation' })).toBeDisabled()
  await page.getByRole('button', { name: 'Reload' }).click()
  await expect(page.getByTestId('jumps')).toHaveText('retry')
})
