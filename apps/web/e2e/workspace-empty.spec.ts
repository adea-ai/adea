import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function openFixture(page: Page, attribute: string) {
  const path = '/__workspace-empty'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="harness-root" ${attribute}></div></body></html>`,
    })
  )
  await page.goto(path)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-empty-harness-app.tsx')
  )
  return page.getByRole('region', { name: 'No workspaces', exact: true })
}

test('the shared web/desktop empty screen validates names, supports keyboard creation and blocks duplicates', async ({
  page,
}) => {
  const empty = await openFixture(page, 'data-create-delayed')
  const create = empty.getByRole('button', { name: 'Create workspace', exact: true })
  const name = empty.getByRole('textbox', { name: 'New workspace name', exact: true })
  await expect(create).toBeDisabled()
  await name.fill('   ')
  await expect(create).toBeDisabled()
  await name.fill('Fresh start')
  await name.press('Enter')
  await expect(empty.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled()
  await expect(name).toBeDisabled()
  await expect(page.locator('#harness-root')).toHaveAttribute('data-create-calls', '1')
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:create-complete')))
  await expect(page.locator('#harness-root')).toHaveAttribute('data-created-name', 'Fresh start')
})

test('empty screen creation failure preserves the name and allows retry', async ({ page }) => {
  const empty = await openFixture(page, 'data-create-failure')
  await empty
    .getByRole('textbox', { name: 'New workspace name', exact: true })
    .fill('Retry workspace')
  await empty.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(empty.getByRole('alert')).toHaveText('Workspace could not be created. Try again.')
  await empty.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page.locator('#harness-root')).toHaveAttribute(
    'data-created-name',
    'Retry workspace'
  )
  await expect(page.locator('#harness-root')).toHaveAttribute('data-create-calls', '2')
})
