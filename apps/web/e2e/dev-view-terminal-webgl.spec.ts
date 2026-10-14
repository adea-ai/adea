// Real WebGL qualification for the terminal pane (#1376). The sibling
// dev-view-terminal-pane.spec.ts disables WebGL so text stays assertable and
// only exercises the DOM fallback; this lane enables SwiftShader WebGL2 and
// drives the real WebglAddon: it activates after the DOM terminal is already
// live and paints streamed output, and the real context-loss ladder (two
// recoveries, then DOM for good) runs against a context the browser actually
// loses. Same scripted-socket harness as the pane spec.
import { expect, test, type Page } from '@playwright/test'

import {
  TERMINAL_PANE_HARNESS_PATH,
  terminalPaneHarnessHtml,
  terminalPaneHarnessModuleSource,
} from './helpers/dev-terminal-pane-harness'

test.use({
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-features=LocalNetworkAccessChecks',
    ],
  },
})

async function report(page: Page) {
  return page.evaluate(() => window.__adeaTerminalPaneHarness.report())
}

/** Loses the pane's live WebGL2 context, as a GPU reset or tab pressure would. */
async function loseContext(page: Page) {
  return page.evaluate(() => {
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
      '.dev-terminal-pane canvas'
    )) {
      const gl = canvas.getContext('webgl2')
      const lose = gl?.getExtension('WEBGL_lose_context')
      if (lose) {
        lose.loseContext()
        return true
      }
    }
    return false
  })
}

async function screenPixels(pane: ReturnType<Page['locator']>) {
  return (await pane.locator('.xterm-screen').screenshot()).toString('base64')
}

test.describe('terminal pane (real WebGL renderer)', () => {
  let consoleErrors: string[]
  let pageErrors: string[]

  test.beforeEach(() => {
    consoleErrors = []
    pageErrors = []
  })

  async function openHarness(page: Page) {
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      // The dev server's HMR websocket is environmental (see the pane spec).
      if (
        text.includes('failed to connect to websocket') ||
        text.includes('ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS')
      ) {
        return
      }
      consoleErrors.push(text)
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.route('**' + TERMINAL_PANE_HARNESS_PATH, (route) =>
      route.fulfill({ contentType: 'text/html', body: terminalPaneHarnessHtml() })
    )
    await page.goto(TERMINAL_PANE_HARNESS_PATH)
    await page.addScriptTag({ type: 'module', content: terminalPaneHarnessModuleSource() })
    const pane = page.locator('.dev-terminal-pane')
    await expect(pane).toBeVisible({ timeout: 30_000 })
    await expect(pane.locator('.xterm')).toBeVisible({ timeout: 30_000 })
    await expect(pane.locator('.dev-terminal-pane-status')).toHaveAttribute('data-state', 'open', {
      timeout: 15_000,
    })
    return pane
  }

  test('activates after the DOM terminal is live and paints streamed output', async ({ page }) => {
    const pane = await openHarness(page)
    // The terminal is usable (attached, output drawn by DOM) before WebGL lands.
    await expect(pane.locator('.xterm')).toBeVisible()
    await expect(pane).toHaveAttribute('data-renderer', 'webgl', { timeout: 15_000 })
    await expect(pane.locator('.xterm-screen canvas')).not.toHaveCount(0)
    const blank = await screenPixels(pane)
    await page.evaluate(() =>
      window.__adeaTerminalPaneHarness.write('\u001b[31mwebgl-painted-output\u001b[0m\r\n')
    )
    await expect.poll(() => screenPixels(pane), { timeout: 15_000 }).not.toBe(blank)
    // Input still reaches the wire through the WebGL-rendered surface.
    await pane.click()
    await page.keyboard.type('x')
    await expect
      .poll(async () => JSON.stringify((await report(page)).inputsByGeneration))
      .toContain('x')
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('context loss falls back to DOM, recovers twice, then stays on DOM', async ({ page }) => {
    const pane = await openHarness(page)
    await expect(pane).toHaveAttribute('data-renderer', 'webgl', { timeout: 15_000 })
    const version = async () => Number(await pane.getAttribute('data-policy-version'))

    for (const recovery of [1, 2]) {
      const before = await version()
      expect(await loseContext(page)).toBe(true)
      // Loss is reported, then a fresh addon takes the new context.
      await expect.poll(version, { timeout: 15_000 }).toBeGreaterThan(before)
      await expect(pane).toHaveAttribute('data-renderer', 'webgl', { timeout: 15_000 })
      await page.evaluate(
        (text) => window.__adeaTerminalPaneHarness.write(text),
        'after-loss-' + recovery + '\r\n'
      )
      expect(consoleErrors).toEqual([])
    }

    // The third loss exhausts the budget: DOM draws again, text is assertable.
    expect(await loseContext(page)).toBe(true)
    await expect(pane).toHaveAttribute('data-renderer', 'dom', { timeout: 15_000 })
    await page.evaluate(() => window.__adeaTerminalPaneHarness.write('final-dom-output\r\n'))
    await expect(pane.locator('.xterm-rows')).toContainText('final-dom-output')
    expect(pageErrors).toEqual([])
  })
})
