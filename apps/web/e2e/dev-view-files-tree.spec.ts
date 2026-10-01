import { expect, test } from '@playwright/test'
import axe from 'axe-core'
import { resolve } from 'node:path'

// Component-scoped acceptance for the production FilesPane with a fixture
// DevRuntimeService. The mounted application-route journey remains separate.
test.use({ headless: true })

const FILES_TREE_HARNESS_PATH = '/__dev-files-window'

function harnessHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Files tree harness</title>',
    '<style>html, body, #harness-root { margin: 0; width: 100%; height: 100%; }</style>',
    '</head><body><div id="harness-root"></div></body></html>',
  ].join('')
}

function harnessModuleSource(): string {
  const harnessPath = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/dev-files-window-harness-app.tsx'
  )
  if (!harnessPath.startsWith(process.cwd())) {
    throw new Error('Files tree harness path escaped the repository root')
  }
  return `import '${'/@fs' + harnessPath}'`
}

async function mountFilesTree(
  page: import('@playwright/test').Page,
  options: Readonly<{ width?: number; height?: number; rows?: number }> = {}
) {
  await page.setViewportSize({ width: options.width ?? 1280, height: options.height ?? 720 })
  await page.route('**' + FILES_TREE_HARNESS_PATH + '**', (route) =>
    route.fulfill({ contentType: 'text/html', body: harnessHtml() })
  )
  await page.goto(`${FILES_TREE_HARNESS_PATH}?shape=tree&rows=${options.rows ?? 160}`)
  await page.addScriptTag({ type: 'module', content: harnessModuleSource() })
  const pane = page.getByRole('region', { name: 'Files' })
  const tree = pane.getByRole('tree', { name: 'Worktree files' })
  await expect(tree.locator('[role="treeitem"]').first()).toBeVisible()
  await expect.poll(() => tree.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1)
  await expect
    .poll(() =>
      tree
        .locator('[data-slot="virtual-window-space"]')
        .evaluate((space) => space.getBoundingClientRect().height)
    )
    .toBeGreaterThan(0)
  return { pane, tree }
}

type FilesWindowHarness = Window & {
  devFilesWindowHarness: {
    report(): Readonly<{
      openedFile?: Readonly<{ relativePath: string }>
    }>
  }
}

test('Files tree enters by Tab, supports tree navigation, and opens through its host callback', async ({
  page,
}) => {
  const { pane, tree } = await mountFilesTree(page)
  const root = tree.locator('[data-tree-id="src"]')
  const file = tree.locator('[data-tree-id="src/entry.ts"]')

  await pane.getByRole('button', { name: 'New file' }).focus()
  await page.keyboard.press('Tab')
  await expect(root).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(root).toHaveAttribute('aria-expanded', 'true')
  await expect(file).toBeVisible()

  await page.keyboard.press('ArrowDown')
  await expect(file).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(root).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(file).toBeFocused()
  await page.keyboard.press('Enter')

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as FilesWindowHarness).devFilesWindowHarness.report().openedFile?.relativePath
      )
    )
    .toBe('src/entry.ts')
  await page.keyboard.press('ArrowLeft')
  await expect(root).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(root).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => tree.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1)

  await page.addScriptTag({ content: axe.source })
  const accessibility = await page.evaluate(async () => {
    const audit = window as unknown as {
      axe: {
        run: (
          context: Document,
          options: object
        ) => Promise<{
          violations: { id: string; impact: string; nodes: { target: string[] }[] }[]
        }>
      }
    }
    return audit.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
      },
    })
  })
  expect(
    accessibility.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map(({ target }) => target),
    }))
  ).toEqual([])
})

test('Files tree reveals offscreen focus with measured rows at narrow width and 200% root text size', async ({
  page,
}) => {
  const { tree } = await mountFilesTree(page, { width: 320, height: 560, rows: 160 })
  const virtualSpace = tree.locator('[data-slot="virtual-window-space"]')
  const initialSpaceHeight = await virtualSpace.evaluate(
    (space) => space.getBoundingClientRect().height
  )

  // This is a root-font stress case at a 320 CSS-pixel viewport. It does not
  // emulate browser zoom or native text scaling.
  await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'))
  await expect
    .poll(() => virtualSpace.evaluate((space) => space.getBoundingClientRect().height))
    .toBeGreaterThan(initialSpaceHeight * 1.5)
  const first = tree.locator('[role="treeitem"]').first()
  await expect
    .poll(() => first.evaluate((row) => row.getBoundingClientRect().height))
    .toBeGreaterThan(28)

  await first.focus()
  await page.keyboard.press('End')

  const last = tree.locator('[data-tree-id="file-0159.txt"]')
  await expect(last).toBeFocused()
  const metrics = await page.evaluate(() => {
    const treeElement = document.querySelector<HTMLElement>(
      '[role="tree"][aria-label="Worktree files"]'
    )
    const row = document.querySelector<HTMLElement>('[data-tree-id="file-0159.txt"]')
    const window = treeElement?.querySelector<HTMLElement>('[data-slot="virtual-window-space"]')
    if (!treeElement || !row || !window) throw new Error('Files tree measurement nodes are missing')
    const treeBox = treeElement.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    return {
      clientWidth: treeElement.clientWidth,
      mountedRows: treeElement.querySelectorAll('[role="treeitem"]').length,
      rowBottom: rowBox.bottom,
      rowTop: rowBox.top,
      scrollTop: treeElement.scrollTop,
      scrollWidth: treeElement.scrollWidth,
      totalSize: window.getBoundingClientRect().height,
      treeBottom: treeBox.bottom,
      treeTop: treeBox.top,
      viewportWidth: document.documentElement.clientWidth,
      rowRects: [...treeElement.querySelectorAll<HTMLElement>('[role="treeitem"]')].map(
        (mountedRow) => {
          const rect = mountedRow.getBoundingClientRect()
          return { bottom: rect.bottom, top: rect.top }
        }
      ),
    }
  })

  expect(metrics.viewportWidth).toBe(320)
  expect(metrics.clientWidth).toBeLessThanOrEqual(320)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  expect(metrics.scrollTop).toBeGreaterThan(0)
  expect(metrics.totalSize).toBeGreaterThan(metrics.treeBottom - metrics.treeTop)
  expect(metrics.mountedRows).toBeLessThan(100)
  for (let index = 1; index < metrics.rowRects.length; index += 1) {
    expect(metrics.rowRects[index]?.top).toBeGreaterThanOrEqual(
      (metrics.rowRects[index - 1]?.bottom ?? 0) - 0.5
    )
  }
  expect(metrics.rowTop).toBeGreaterThanOrEqual(metrics.treeTop)
  expect(metrics.rowBottom).toBeLessThanOrEqual(metrics.treeBottom)
  await expect.poll(() => tree.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1)
})
