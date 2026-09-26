import { expect, test } from '@playwright/test'

async function openFixtureTerminal(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  const terminal = page.getByRole('region', { name: 'terminal pane' }).first()
  await expect(terminal.getByRole('region', { name: /Integrated terminal/ })).toBeVisible({
    timeout: 60_000,
  })
  return terminal.getByRole('region', { name: /Integrated terminal/ })
}

test('terminal attach renders authenticated shell state and remains keyboard accessible', async ({
  page,
}) => {
  const terminal = await openFixtureTerminal(page)
  const pane = terminal.locator('..')

  await expect(terminal.locator('.dev-terminal-pane-status')).toHaveAttribute('data-state', 'open')
  await expect(terminal.locator('.dev-terminal-pane-integration')).toHaveAttribute(
    'data-status',
    'active'
  )
  await expect(terminal.locator('.dev-terminal-pane-cwd')).toHaveAttribute(
    'data-cwd-source',
    'authenticated'
  )
  await expect(terminal.getByRole('listitem', { name: /printf fixture, exit 0/ })).toBeVisible()
  await expect(terminal.locator('.dev-terminal-surface')).toBeVisible()
  await expect(terminal).toHaveAttribute('data-attach-from', '0')
  await expect(terminal).toHaveAttribute('data-renderer', /^(webgl|dom)$/)

  await terminal.click()
  await page.keyboard.press('ControlOrMeta+f')
  const search = terminal.getByRole('search', { name: 'Search terminal' })
  await expect(search).toBeVisible()
  await search.getByRole('searchbox', { name: 'Search terminal' }).fill('fixture')
  await expect(search.locator('.dev-terminal-search-count')).toContainText(/match/)
  await search.getByRole('button', { name: 'Close search' }).click()
  await expect(search).toBeHidden()

  await expect(pane).toHaveAttribute('data-pane-id', 'dev-terminal')
  await expect(terminal.getByRole('textbox', { name: 'Compose terminal input' })).toBeVisible()
})

test('terminal reconnects after a bounded transport flap and survives a split', async ({
  page,
}) => {
  const terminal = await openFixtureTerminal(page)

  // The fixture closes its first socket once; observing the replayed sequence
  // proves the client transport reattached instead of fabricating continuity.
  await expect(terminal.locator('.dev-terminal-pane-status')).toHaveAttribute('data-state', 'open')
  await expect(terminal).toContainText('reconnected', { timeout: 10_000 })

  await page.getByRole('button', { name: 'Split pane' }).click()
  const terminals = page.getByRole('region', { name: /Integrated terminal/ })
  await expect(terminals).toHaveCount(2)
  await expect(terminals.nth(1).locator('.dev-terminal-pane-status')).toHaveAttribute(
    'data-state',
    'open'
  )
  await expect(terminals.nth(1).locator('.dev-terminal-surface')).toBeVisible()
  // `open` is set as soon as the socket exists. The initial fixture bytes prove
  // this pane accepted its own sequence-0 stream instead of dropping output
  // after another pane consumed the shared fixture counter.
  await expect(terminals.nth(1).getByLabel('Terminal output')).toContainText(
    'fixture terminal connected'
  )

  const snapshot = await page
    .getByRole('region', { name: 'Developer workspace panes' })
    .ariaSnapshot()
  expect(snapshot).toContain('terminal pane')
  expect(snapshot).toContain('Compose terminal input')
})
