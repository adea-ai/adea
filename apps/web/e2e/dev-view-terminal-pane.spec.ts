// #538 terminal pane Playwright coverage: the REAL dev-view TerminalPane
// (xterm + search addon + clipboard affordance + transport) mounted through
// the dev-terminal-pane-harness and driven over the scripted terminal-bytes-v1
// socket. Complements dev-view-terminal.spec.ts, which covers the Dev View
// fixture journey; this lane covers the production pane's user-facing surface:
// attach, output rendering, input, resize, search open/next/prev, the
// selection+copy affordance state, and reconnect after a sidecar restart.
//
// The lane renders its own intercepted page and asserts no console errors, so
// it cannot pollute the conventional-workspace visual lane.
import { expect, test, type Page } from '@playwright/test'

import {
  TERMINAL_PANE_HARNESS_PATH,
  terminalPaneHarnessHtml,
  terminalPaneHarnessModuleSource,
} from './helpers/dev-terminal-pane-harness'

// The headless lane pins the DOM renderer: WebGL (SwiftShader here) paints
// into a canvas where no text is assertable, while the WebGL/DOM fallback
// ladder itself is pinned by the renderer-policy unit tests. Disabling WebGL
// exercises the pane's real webglInitFailed → DOM fallback path on mount.
test.use({
  launchOptions: {
    args: ['--disable-webgl', '--disable-webgl2', '--disable-features=LocalNetworkAccessChecks'],
  },
})

/** Reads the harness report from the page. */
async function report(page: Page) {
  return page.evaluate(() => window.__adeaTerminalPaneHarness.report())
}

test.describe('terminal pane (real xterm surface)', () => {
  let consoleErrors: string[]
  let pageErrors: string[]

  test.beforeEach(() => {
    consoleErrors = []
    pageErrors = []
  })

  /**
   * Captures console errors for the no-error policing every test asserts.
   * The dev server's HMR websocket is environmental (Chrome blocks the
   * ws://upgrade under local-network access checks in headless); it is not a
   * product surface, so those named messages are excluded.
   */
  function watchErrors(page: Page): void {
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      if (
        text.includes('failed to connect to websocket') ||
        text.includes('ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS')
      ) {
        return
      }
      consoleErrors.push(text)
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))
  }

  async function openHarness(page: Page) {
    watchErrors(page)
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

  test('attaches, renders streamed output, and reports the authenticated shell state', async ({
    page,
  }) => {
    const pane = await openHarness(page)
    await expect(pane).toHaveAttribute('data-attach-from', '0')
    // WebGL is disabled for this lane, so mount falls back to DOM — the
    // pane's real renderer-policy fallback path, asserted truthfully.
    await expect(pane).toHaveAttribute('data-renderer', 'dom')
    await expect(pane).toHaveAttribute('data-worktree-id', 'fixture-worktree')
    // The attach-time replay line renders through the real renderer.
    await expect(pane.locator('.xterm-rows')).toContainText(
      'scripted sidecar attached (generation 1)'
    )
    // Authenticated shell observations light the integration affordances.
    await expect(pane.locator('.dev-terminal-pane-integration')).toHaveAttribute(
      'data-status',
      'active'
    )
    await expect(pane.locator('.dev-terminal-pane-cwd')).toHaveAttribute(
      'data-cwd-source',
      'authenticated'
    )
    // Live output continues on the same stream.
    await page.evaluate(() => {
      window.__adeaTerminalPaneHarness.write('adea-pane-ready\r\n$ ')
    })
    await expect(pane.locator('.xterm-rows')).toContainText('adea-pane-ready')
    const state = await report(page)
    expect(state.sockets).toBe(1)
    expect(state.dataFramesEmitted).toBe(1)
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('compose input reaches the wire as input bytes and echoes into the pane', async ({
    page,
  }) => {
    const pane = await openHarness(page)
    const editor = pane.getByLabel('Compose terminal input')
    await expect(editor).toBeVisible()
    await editor.fill('echo $((40+2))')
    await editor.press('Enter')
    const state = await report(page)
    expect(state.inputsByGeneration['1']).toEqual(['echo $((40+2))\n'])
    // The harness echoes like the PTY would; the sent command renders.
    await expect(pane.locator('.xterm-rows')).toContainText('echo $((40+2))')
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('search opens, reports live match counts, and steps next/previous', async ({ page }) => {
    const pane = await openHarness(page)
    await page.evaluate(() => {
      const harness = window.__adeaTerminalPaneHarness
      harness.write(
        '\r\nneedle one\r\nfiller line\r\nneedle two\r\nfiller line\r\nneedle three\r\n'
      )
    })
    await expect(pane.locator('.xterm-rows')).toContainText('needle three')
    await pane.click()
    await page.keyboard.press('ControlOrMeta+f')
    const search = pane.getByRole('search', { name: 'Search terminal' })
    await expect(search).toBeVisible()
    await search.getByLabel('Search terminal').fill('needle')
    const count = search.locator('.dev-terminal-search-count')
    await expect(count).toHaveText(/of 3 matches/, { timeout: 15_000 })
    const next = search.getByRole('button', { name: 'Next match' })
    const previous = search.getByRole('button', { name: 'Previous match' })
    await expect(next).toBeEnabled()
    await expect(previous).toBeEnabled()
    // Stepping must stay healthy: repeated Next/Previous clicks keep the live
    // count rendered and the pane error-free. (The active-match ordinal is
    // currently not tracked faithfully by the count while decorations are on
    // — a known #538 finding, filed separately; this lane pins the contract
    // that must keep passing regardless.)
    for (let click = 0; click < 3; click += 1) {
      await next.click()
      await expect(count).toHaveText(/^\d+ of 3 matches$/)
      await previous.click()
      await expect(count).toHaveText(/^\d+ of 3 matches$/)
    }
    await search.getByRole('button', { name: 'Close search' }).click()
    await expect(search).toBeHidden()
    // Escape closes too.
    await pane.click()
    await page.keyboard.press('ControlOrMeta+f')
    await expect(search).toBeVisible()
    await search.getByLabel('Search terminal').press('Escape')
    await expect(search).toBeHidden()
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('selection enables the copy affordance and copy goes through the seam', async ({ page }) => {
    const pane = await openHarness(page)
    const copyButton = pane.locator('.dev-terminal-copy-button').first()
    await expect(copyButton).toBeDisabled()
    await page.evaluate(() => {
      window.__adeaTerminalPaneHarness.write('selectable-marker-word\r\n')
    })
    const target = pane.locator('.xterm-rows').getByText('selectable-marker-word')
    await expect(target).toBeVisible()
    // xterm owns its own mouse handling above the row spans, so dispatch the
    // double click at the span's coordinates rather than relying on
    // Playwright's hit-target check for the span element itself.
    const box = (await target.boundingBox())!
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
    await expect(copyButton).toBeEnabled()
    await copyButton.click()
    await expect(copyButton).toHaveText('Copied')
    const state = await report(page)
    expect(state.copies).toEqual(['selectable-marker-word'])
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('viewport resize refits the terminal and reaches the resize seam', async ({ page }) => {
    const pane = await openHarness(page)
    await expect(pane.locator('.xterm-rows')).toContainText('scripted sidecar attached')
    const before = await report(page)
    await page.setViewportSize({ width: 800, height: 700 })
    await expect
      .poll(async () => (await report(page)).resizes.length, { timeout: 15_000 })
      .toBeGreaterThan(before.resizes.length)
    const after = await report(page)
    const latest = after.resizes[after.resizes.length - 1]
    expect(latest.cols).toBeGreaterThan(20)
    expect(latest.rows).toBeGreaterThan(10)
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('reconnects after a sidecar restart and keeps the stream byte-continuous', async ({
    page,
  }) => {
    const pane = await openHarness(page)
    await expect(pane.locator('.xterm-rows')).toContainText('generation 1)')
    await page.evaluate(() => {
      window.__adeaTerminalPaneHarness.restart()
    })
    // The transport reconnects from the restart within the backoff window and
    // the new grant opens with the bumped generation.
    await expect(pane.locator('.dev-terminal-pane-status')).toHaveAttribute(
      'data-state',
      /open|reconnecting/,
      { timeout: 15_000 }
    )
    await expect(pane.locator('.dev-terminal-pane-status')).toHaveAttribute('data-state', 'open', {
      timeout: 15_000,
    })
    await expect(pane.locator('.xterm-rows')).toContainText('generation 2)')
    // Input flows through the NEW socket under the new generation.
    const editor = pane.getByLabel('Compose terminal input')
    await editor.fill('post-restart')
    await editor.press('Enter')
    const state = await report(page)
    expect(state.restarts).toBe(1)
    expect(state.sockets).toBe(2)
    expect(state.generation).toBe(2)
    expect(state.inputsByGeneration['2']).toEqual(['post-restart\n'])
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
})
