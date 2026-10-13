// Conversation history search: every result belongs to the same session, so the
// session title alone names each jump button identically. The matched event kind
// and preview have to reach the accessible name, or a screen reader's button list
// reads as the same link repeated.
import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

const HARNESS_PATH = '/__chat-history-search'

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
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/chat-history-search-harness-app.tsx')
  )
  await expect(page.getByRole('region', { name: 'Conversation history search' })).toBeVisible()
})

test('result buttons for one session carry distinct accessible names', async ({ page }) => {
  await page
    .getByRole('textbox', { name: 'Search conversations and runtime events' })
    .fill('deploy')
  await expect(page.getByRole('status')).toHaveText('3 results')

  const jumps = page
    .getByRole('list', { name: 'Conversation history results' })
    .getByRole('button', { name: /^Deploy planning,/ })
  await expect(jumps).toHaveCount(3)
  const names = await jumps.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label'))
  )
  expect(new Set(names).size).toBe(3)
  expect(names).toEqual([
    'Deploy planning, prompt: deploy the staging build',
    'Deploy planning, approval: Deploy to production',
    'Deploy planning, run: Harness completed',
  ])

  // Addressable by name, and each button jumps to its own event.
  await page
    .getByRole('button', { name: 'Deploy planning, approval: Deploy to production' })
    .click()
  await expect(page.getByTestId('jumps')).toHaveText('approval-1')
})

test('resume buttons name the session they resume', async ({ page }) => {
  await expect(
    page.getByRole('button', { name: 'Resume generation 2 of Deploy planning' })
  ).toBeVisible()
})
