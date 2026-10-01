import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

test.use({ headless: true })

const harnessPath = '/__dev-files-window'
const totalFiles = 1_200
const rowHeight = 28

async function mountFilesPane(page: Page) {
  await page.setViewportSize({ width: 960, height: 720 })
  await page.route(`**${harnessPath}`, (route) =>
    route.fulfill({ contentType: 'text/html', body: harnessHtml() })
  )
  await page.goto(harnessPath)
  await page.evaluate(
    async (url) => import(url),
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/dev-files-window-harness-app.tsx')
  )

  const tree = page.getByRole('tree', { name: 'Worktree files' })
  await expect(tree).toBeVisible()
  await expect
    .poll(async () => {
      const report = await page.evaluate(() => window.devFilesWindowHarness.report())
      return report.listPageCalls.length
    })
    .toBe(3)
  const virtualSpace = tree.locator('[data-slot="virtual-window-space"]')
  await expect(virtualSpace).toHaveCSS('height', `${totalFiles * rowHeight}px`)
  return {
    tree,
    virtualSpace,
    virtualContent: virtualSpace.locator('[data-slot="virtual-window-content"]'),
  }
}

function harnessHtml(): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Files window harness</title>',
    '<style>html, body { margin: 0; width: 100%; height: 100%; }',
    '#harness-root { height: 520px; width: 620px; }</style>',
    '</head><body><div id="harness-root"></div></body></html>',
  ].join('')
}

async function mountedRows(tree: ReturnType<Page['getByRole']>): Promise<number> {
  return tree.getByRole('treeitem').count()
}

async function scrollTree(tree: ReturnType<Page['getByRole']>, top: number): Promise<void> {
  await tree.evaluate((element, value) => {
    element.scrollTop = value
  }, top)
  await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBe(top)
}

async function readReport(page: Page) {
  return page.evaluate(() => window.devFilesWindowHarness.report())
}

test('Files tree mounts a bounded row window with aligned top, middle and end geometry', async ({
  page,
}) => {
  const { tree, virtualSpace, virtualContent } = await mountFilesPane(page)
  const fullWindowHeight = totalFiles * rowHeight
  const initialMountedRows = await mountedRows(tree)
  expect(initialMountedRows).toBeGreaterThan(0)
  expect(initialMountedRows).toBeLessThan(64)
  expect(await tree.evaluate((element) => element.scrollHeight)).toBeGreaterThanOrEqual(
    fullWindowHeight
  )
  expect(await tree.evaluate((element) => element.scrollHeight)).toBeLessThanOrEqual(
    fullWindowHeight + 16
  )
  await expect(virtualContent).toHaveAttribute('style', /translateY\(0px\)/)

  const middleTop = Math.floor(totalFiles / 2) * rowHeight
  await scrollTree(tree, middleTop)
  const middleOffset = (Math.floor(middleTop / rowHeight) - 8) * rowHeight
  await expect(virtualContent).toHaveAttribute('style', `transform: translateY(${middleOffset}px);`)
  expect(await mountedRows(tree)).toBeLessThan(64)
  // The shared TreeRow renders the file name as the row's accessible name
  // (with the row actions appended), not as a lone button.
  await expect(tree.getByRole('treeitem').first()).toHaveAccessibleName(/file-0592\.txt/)

  const fullScrollHeight = await tree.evaluate((element) => element.scrollHeight)
  await tree.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(middleTop)
  const endTop = await tree.evaluate((element) => element.scrollTop)
  const endStart = Math.floor(endTop / rowHeight) - 8
  const endOffset = endStart * rowHeight
  await expect(virtualContent).toHaveAttribute('style', `transform: translateY(${endOffset}px);`)
  const endMountedRows = await mountedRows(tree)
  expect(endMountedRows).toBeLessThan(64)
  expect(endOffset + endMountedRows * rowHeight).toBe(fullWindowHeight)
  // The measured extent may refine by a pixel or two while the tail window's
  // rows report their border boxes; the window bounds above pin the geometry.
  expect(
    Math.abs((await tree.evaluate((element) => element.scrollHeight)) - fullScrollHeight)
  ).toBeLessThanOrEqual(4)
  await expect(virtualSpace).toHaveCSS('height', `${fullWindowHeight}px`)

  const snapshot = await readReport(page)
  expect(snapshot.entryCount).toBe(totalFiles)
  expect(snapshot.listPageCalls.map((call) => call.cursor ?? null)).toEqual([null, '500', '1000'])
  expect(snapshot.listPageCalls.every((call) => call.limit <= 500)).toBe(true)
  expect(
    snapshot.listPageCalls.every(
      (call) =>
        call.resource?.kind === 'workspace_root' &&
        call.resource.id === '00000000-0000-4000-8000-000000000004' &&
        call.resource.generation === 7
    )
  ).toBe(true)
})

test('focused tree rows stay mounted through keyboard open, and filter can clear', async ({
  page,
}) => {
  const { tree } = await mountFilesPane(page)
  // The shared Tree owns roving focus: enter on the first row, then walk the
  // keyboard to file-0015 instead of focusing a name button.
  await tree.getByRole('treeitem').first().focus()
  for (let step = 0; step < 15; step += 1) await page.keyboard.press('ArrowDown')
  const focusedFile = tree.locator('[role="treeitem"][data-tree-id="file-0015.txt"]')
  await expect(focusedFile).toBeFocused()

  await scrollTree(tree, 50 * rowHeight)
  await expect(focusedFile).toBeAttached()
  await expect(focusedFile).toBeFocused()
  expect(await mountedRows(tree)).toBeLessThan(80)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () => (await readReport(page)).openedFile?.relativePath)
    .toBe('file-0015.txt')
  const snapshot = await readReport(page)
  expect(snapshot.openedFile).toEqual({
    worktreeId: '00000000-0000-4000-8000-000000000004',
    generation: 7,
    relativePath: 'file-0015.txt',
    identity: {
      device: 'fixture-device',
      inode: '16',
      mtimeNs: '1700000000000015',
      size: '115',
      contentSha256: '000000000000000000000000000000000000000000000000000000000000000f',
    },
    rootIdentity: {
      device: 'fixture-device',
      inode: 'fixture-root-inode',
      mtimeNs: '1700000000000000000',
      size: '4096',
    },
  })

  const filter = page.getByRole('searchbox', { name: 'Filter files' })
  await filter.fill('file-1199')
  await expect(tree.getByRole('treeitem')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'file-1199.txt', exact: true })).toBeVisible()
  await filter.fill('')
  await expect(tree.getByRole('treeitem').first()).toBeVisible()
  expect((await readReport(page)).listPageCalls).toHaveLength(3)
})

test('Quick Open keeps fuzzy ordering, Command keyboard selection, file identity, and focus return', async ({
  page,
}) => {
  await mountFilesPane(page)
  const opener = page.getByRole('button', { name: 'Quick open files' })

  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Quick open' })
  const input = dialog.getByRole('combobox', { name: 'Quick open' })
  const list = dialog.getByRole('listbox', { name: 'Matching files' })
  await expect(dialog).toBeVisible()
  await expect(input).toBeFocused()

  await input.fill('file')
  const options = list.getByRole('option')
  await expect(options).toHaveCount(20)
  const listId = await list.getAttribute('id')
  const firstOptionId = await options.nth(0).getAttribute('id')
  expect(listId).toBeTruthy()
  expect(await input.getAttribute('aria-controls')).toBe(listId)
  expect(await input.getAttribute('aria-activedescendant')).toBe(firstOptionId)
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')

  await input.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
  await input.press('ArrowUp')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await input.press('ArrowUp')
  await expect(options.nth(19)).toHaveAttribute('aria-selected', 'true')

  await input.fill('file-1199.txt')
  const target = list.getByRole('option', { name: 'file-1199.txt' })
  await expect(target).toHaveAttribute('aria-selected', 'true')
  await input.press('Enter')
  await expect(dialog).toBeHidden()
  await expect
    .poll(async () => (await readReport(page)).openedFile?.relativePath)
    .toBe('file-1199.txt')
  const openedFile = (await readReport(page)).openedFile
  expect(openedFile).toMatchObject({
    worktreeId: '00000000-0000-4000-8000-000000000004',
    generation: 7,
    relativePath: 'file-1199.txt',
    identity: { inode: '1200', size: '1299' },
    rootIdentity: {
      device: 'fixture-device',
      inode: 'fixture-root-inode',
      mtimeNs: '1700000000000000000',
      size: '4096',
    },
  })
  await expect(opener).toBeFocused()

  await opener.click()
  const reopened = page.getByRole('dialog', { name: 'Quick open' })
  const reopenedInput = reopened.getByRole('combobox', { name: 'Quick open' })
  await reopenedInput.fill('no-loaded-file-matches')
  await expect(reopened.getByRole('status')).toHaveText(
    'No loaded file matches. Expand more of the tree, then search again.'
  )
  await reopenedInput.press('Escape')
  await expect(reopened).toBeHidden()
  await expect(opener).toBeFocused()
})
