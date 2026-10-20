import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

// Mounted acceptance for the fresh-install race around the desktop folder picker. The shell's bridge is
// present, but its first picker call throws synchronously: the state a shell reaches before its command
// table is ready. Two checks pin it in Chromium:
// - the production Dev add surface keeps its typed path usable, answers on the next attempt, and raises no
//   page error (the add form already fails closed, so this guards the user-visible flow);
// - the real pickDesktopFolder resolves null on that first call instead of rejecting. This is the contract
//   the fix in apps/web/src/lib/desktop-bridge.ts establishes, and the check that fails if it regresses.

const path = '/__dev-add-project-bridge-fallback-harness'
const desktopBridgeModule = resolve(process.cwd(), 'apps/web/src/lib/desktop-bridge.ts')

async function installUnreadyBridge(page: Page) {
  await page.addInitScript(() => {
    const host = window as unknown as { adeaFolderPickCalls?: number }
    host.adeaFolderPickCalls = 0
    const bridge = {
      invoke(command: string): Promise<unknown> {
        if (command !== 'desktop_folder_pick') return Promise.resolve(null)
        host.adeaFolderPickCalls = (host.adeaFolderPickCalls ?? 0) + 1
        if (host.adeaFolderPickCalls === 1) throw new Error('shell command table is not ready')
        return Promise.resolve({ paths: ['/srv/checkout'] })
      },
      listen: async () => () => undefined,
    }
    // The workspace harness assigns window.__adeaDesktop when its module loads. This accessor keeps the
    // bridge above in place while letting that assignment succeed without replacing it.
    Object.defineProperty(window, '__adeaDesktop', {
      configurable: true,
      get: () => bridge,
      set: () => undefined,
    })
  })
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><head></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
}

async function mountWithUnreadyPicker(page: Page) {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  await installUnreadyBridge(page)
  await page.evaluate(() => {
    ;(window as unknown as { __harnessInitialEntry?: string }).__harnessInitialEntry = '/?view=dev'
  })
  const app = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/workspace-navigation-presentation-harness-app.tsx'
  )
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + app}'` })
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { workspaceNavigationPresentationHarness?: unknown })
        .workspaceNavigationPresentationHarness
    )
  )
  return pageErrors
}

const openNewProjectDialog = async (page: Page) => {
  await page.getByRole('button', { name: 'New project in Workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project in Workspace' })
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Cloud project')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  return dialog
}

test('a shell picker that throws on its first call leaves the typed path usable and raises no page error', async ({
  page,
}) => {
  const pageErrors = await mountWithUnreadyPicker(page)
  const dialog = await openNewProjectDialog(page)
  const pathInput = dialog.getByRole('textbox', { name: 'Folder path to authorize' })
  const choose = dialog.getByRole('button', { name: 'Choose folder…' })
  await expect(choose).toBeVisible()

  await pathInput.fill('/Users/fixture/typed-checkout')
  await choose.click()
  // Wait for the throwing call to happen, so the unchanged path below is checked after the pick settles.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { adeaFolderPickCalls?: number }).adeaFolderPickCalls ?? 0
      )
    )
    .toBe(1)
  await expect(pathInput).toHaveValue('/Users/fixture/typed-checkout')
  await expect(choose).toBeEnabled()

  await choose.click()
  await expect(pathInput).toHaveValue('/srv/checkout')
  expect(pageErrors).toEqual([])
})

test('pickDesktopFolder resolves null, not a rejection, while the shell bridge throws on its first call', async ({
  page,
}) => {
  await installUnreadyBridge(page)

  const outcome = await page.evaluate(async (url) => {
    const { pickDesktopFolder } = (await import(url)) as {
      pickDesktopFolder: () => Promise<string | null>
    }
    const settle = async () => {
      try {
        return { state: 'resolved', value: await pickDesktopFolder() }
      } catch (error) {
        return {
          state: 'rejected',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const first = await settle()
    const second = await settle()
    return { first, second }
  }, '/@fs' + desktopBridgeModule)

  expect(outcome.first).toEqual({ state: 'resolved', value: null })
  expect(outcome.second).toEqual({ state: 'resolved', value: '/srv/checkout' })
})
