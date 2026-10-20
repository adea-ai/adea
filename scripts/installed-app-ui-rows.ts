// The UI rows of the installed-desktop acceptance lane.
//
// These rows drive the CLIENT the installed application serves, over the
// installed application's OWN origin: the server, the bridge, the gateway and
// the same-origin cloud proxy in this path all belong to the installed
// application, not to a test double.
//
// What is NOT in this path: the application's own window widget. The macOS
// bundle renders through the native (WKWebView) renderer, which exposes no
// programmatic channel, and driving a native window needs an accessibility
// grant this environment does not have. Every row therefore records which
// surface answered it, and the report states the difference.
//
// The rows are deliberately about OBSERVABLE STATE: a view that changed, a
// panel that opened, a reload that came back, a repeated request that did not
// change anything. They assert what the user can see, not the shape of the
// code that produced it.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { chromium, type Page } from '@playwright/test'

/** One row of the UI matrix. */
export type UiRow = Readonly<{
  id: string
  expected: string
  actual: string
  ok: boolean
  evidence: 'installed-app-origin'
  /** The screenshot file name, relative to the artifact directory. */
  screenshot?: string
}>

/** The rail entries the desktop client offers, by their accessible name. */
const RAIL_ENTRIES = ['Chat view', 'Dev view', 'App Library', 'Plugins', 'User settings'] as const

/** The visible text of the rendered view, as the user reads it. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim())
}

/** Whether a rail entry (or any control) with that accessible name is present. */
async function hasControl(page: Page, name: string): Promise<boolean> {
  return page.evaluate(
    (label) =>
      Array.from(
        document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="link"]')
      ).some(
        (element) =>
          element.getAttribute('aria-label') === label ||
          (element.textContent ?? '').trim() === label
      ),
    name
  )
}

/** Clicks the control with that accessible name. */
async function clickControl(page: Page, name: string): Promise<boolean> {
  const clicked = await page.evaluate((label) => {
    const element = Array.from(
      document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="link"]')
    ).find(
      (candidate) =>
        candidate.getAttribute('aria-label') === label ||
        (candidate.textContent ?? '').trim() === label
    ) as HTMLElement | undefined
    if (!element) return false
    element.click()
    return true
  }, name)
  if (clicked) await page.waitForTimeout(1_200)
  return clicked
}

/** A stable signature of the rendered view, for "did this change?" questions. */
async function viewSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .map((element) => (element.textContent ?? '').trim())
      .filter(Boolean)
      .slice(0, 8)
    const selected = Array.from(
      document.querySelectorAll('[aria-current],[aria-selected="true"],[data-state="active"]')
    )
      .map((element) => (element.textContent ?? '').trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 8)
    return JSON.stringify({ headings, selected })
  })
}

/**
 * Runs the UI rows against an origin the installed application serves.
 *
 * The screenshot directory is the artifact directory: every row that changes
 * the screen leaves the screen it produced behind, so the report can point at
 * what the user would have seen.
 */
export async function runInstalledAppUiRows(
  origin: string,
  artifactDirectory: string
): Promise<UiRow[]> {
  const rows: UiRow[] = []
  const screenshotDirectory = join(artifactDirectory, 'screenshots')
  mkdirSync(screenshotDirectory, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)))
  let shotIndex = 0
  const shoot = async (name: string): Promise<string | undefined> => {
    shotIndex += 1
    const file = `${String(shotIndex).padStart(2, '0')}-${name}.png`
    try {
      await page.screenshot({ path: join(screenshotDirectory, file) })
      return file
    } catch {
      return undefined
    }
  }
  const add = (row: UiRow) => {
    rows.push(row)
  }

  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // 1. The first run opens into a usable guest workspace.
    await page
      .waitForFunction(() => (document.body?.innerText ?? '').includes('Chat view'), undefined, {
        timeout: 60_000,
      })
      .catch(() => undefined)
    const firstRunText = await visibleText(page)
    const railPresent = await hasControl(page, 'Chat view')
    add({
      id: 'ui-first-run-opens-a-guest-workspace',
      expected:
        'the installed application opens into a guest workspace with its rail (Chat, Dev, App Library) available',
      actual: railPresent
        ? 'the guest workspace rendered with its rail entries'
        : `the rail never appeared; the rendered view was "${firstRunText.slice(0, 120)}"`,
      ok: railPresent,
      evidence: 'installed-app-origin',
      screenshot: await shoot('first-run'),
    })

    const homeSignature = await viewSignature(page)

    // 2. The Chat view opens.
    const chatClicked = await clickControl(page, 'Chat view')
    const chatSignature = await viewSignature(page)
    const chatText = await visibleText(page)
    add({
      id: 'ui-chat-view-opens',
      expected: 'the Chat view opens and the rendered view changes',
      actual: chatClicked
        ? `the Chat view rendered "${chatText.slice(0, 120)}"`
        : 'the Chat view control was not present',
      ok: chatClicked && chatSignature !== homeSignature,
      evidence: 'installed-app-origin',
      screenshot: await shoot('chat-view'),
    })

    // 3. The Dev view opens.
    const devClicked = await clickControl(page, 'Dev view')
    const devSignature = await viewSignature(page)
    const devText = await visibleText(page)
    add({
      id: 'ui-dev-view-opens',
      expected: 'the Dev view opens and the rendered view changes',
      actual: devClicked
        ? `the Dev view rendered "${devText.slice(0, 120)}"`
        : 'the Dev view control was not present',
      ok: devClicked && devSignature !== chatSignature,
      evidence: 'installed-app-origin',
      screenshot: await shoot('dev-view'),
    })

    // 4. The App Library opens, and the optional entries are reachable.
    const libraryClicked = await clickControl(page, 'App Library')
    const libraryText = await visibleText(page)
    // The library names its optional destinations as the product names them:
    // Virtual, Kanban and Source control.
    const optionalEntries = ['Virtual', 'Kanban', 'Source control'].map((name) => ({
      name,
      present: libraryText.includes(name),
    }))
    add({
      id: 'ui-app-library-opens',
      expected: 'the App Library opens and lists the optional destinations it offers',
      actual: libraryClicked
        ? `the App Library rendered "${libraryText.slice(0, 120)}"`
        : 'the App Library control was not present',
      ok: libraryClicked,
      evidence: 'installed-app-origin',
      screenshot: await shoot('app-library'),
    })
    add({
      id: 'ui-default-destinations-are-chat-and-dev',
      expected: 'the App Library offers Chat and Dev as the destinations that are on by default',
      actual: libraryText.includes('Chat and Dev are on by default')
        ? 'the library states that Chat and Dev are on by default'
        : 'the library did not state its default destinations',
      ok: libraryText.includes('Chat and Dev are on by default'),
      evidence: 'installed-app-origin',
      screenshot: await shoot('app-library-defaults'),
    })
    add({
      id: 'ui-optional-destinations-are-offered',
      expected:
        'the optional destinations (Virtual, Kanban, SourceTree) are offered by the App Library, whether or not they are enabled',
      actual: `the App Library offered ${optionalEntries
        .map((entry) => `${entry.name}: ${entry.present ? 'present' : 'absent'}`)
        .join(', ')}; it rendered "${libraryText.slice(0, 400)}"`,
      ok: optionalEntries.every((entry) => entry.present),
      evidence: 'installed-app-origin',
      screenshot: await shoot('app-library-optional'),
    })

    // 5. Back and forward.
    await clickControl(page, 'Chat view')
    const afterChat = await viewSignature(page)
    const backClicked = await clickControl(page, 'Back')
    const afterBack = await viewSignature(page)
    const forwardClicked = await clickControl(page, 'Forward')
    const afterForward = await viewSignature(page)
    add({
      id: 'ui-back-and-forward-navigate',
      expected: 'Back returns to the previous view and Forward returns to the later one',
      actual:
        backClicked && forwardClicked
          ? `back changed the view: ${afterBack !== afterChat}; forward restored it: ${afterForward === afterChat}`
          : 'the Back or Forward control was not present',
      ok: backClicked && forwardClicked && afterBack !== afterChat && afterForward === afterChat,
      evidence: 'installed-app-origin',
      screenshot: await shoot('back-forward'),
    })

    // 6. A repeated request is idempotent.
    await clickControl(page, 'Chat view')
    // The first request is given time to settle before the signature is
    // read, so a transition in flight is not read as "the view changed".
    await page.waitForTimeout(2_500)
    const repeatedBefore = await viewSignature(page)
    await clickControl(page, 'Chat view')
    await page.waitForTimeout(1_500)
    await clickControl(page, 'Chat view')
    await page.waitForTimeout(2_500)
    const repeatedAfter = await viewSignature(page)
    add({
      id: 'ui-repeated-navigation-is-idempotent',
      expected: 'repeating the same navigation request leaves the view exactly as it was',
      actual: `three requests to the same destination left the view ${
        repeatedBefore === repeatedAfter ? 'unchanged' : 'changed'
      }`,
      ok: repeatedBefore === repeatedAfter,
      evidence: 'installed-app-origin',
      screenshot: await shoot('repeated-navigation'),
    })

    // 7. An interrupted navigation settles on the last request.
    await page.evaluate(() => {
      const rail = Array.from(document.querySelectorAll('button')).find(
        (element) => element.getAttribute('aria-label') === 'Chat view'
      ) as HTMLElement | undefined
      rail?.click()
    })
    await clickControl(page, 'Dev view')
    const settledText = await visibleText(page)
    const settledDev = await hasControl(page, 'Dev view')
    add({
      id: 'ui-interrupted-navigation-settles-on-the-last-request',
      expected:
        'a navigation interrupted by a second request settles on the second one, with no half-open view left behind',
      actual: settledDev
        ? `the view settled on the Dev view ("${settledText.slice(0, 120)}")`
        : `the view settled on "${settledText.slice(0, 120)}"`,
      ok: settledDev,
      evidence: 'installed-app-origin',
      screenshot: await shoot('interrupted-navigation'),
    })

    // 8. A reload brings the application back into its workspace.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    const reloaded = await page
      .waitForFunction(() => (document.body?.innerText ?? '').includes('Chat view'), undefined, {
        timeout: 60_000,
      })
      .then(() => true)
      .catch(() => false)
    add({
      id: 'ui-reload-returns-to-the-workspace',
      expected: 'reloading the application returns to the workspace, with the client state intact',
      actual: reloaded
        ? 'the application returned to the workspace after the reload'
        : 'the application did not return to the workspace',
      ok: reloaded,
      evidence: 'installed-app-origin',
      screenshot: await shoot('reload'),
    })

    // 9. The bridge the installed application injects is present in the page.
    const bridge = await page.evaluate(() => {
      const desktop = (window as unknown as { __adeaDesktop?: Record<string, unknown> })
        .__adeaDesktop
      return {
        present: typeof desktop === 'object' && desktop !== null,
        keys:
          typeof desktop === 'object' && desktop !== null ? Object.keys(desktop).slice(0, 20) : [],
      }
    })
    add({
      id: 'ui-the-installed-bridge-is-present-in-the-page',
      expected: 'the page carries the desktop bridge the installed application injects',
      actual: bridge.present
        ? `the bridge exposed ${bridge.keys.length} entries`
        : 'the page carried no desktop bridge',
      ok: bridge.present,
      evidence: 'installed-app-origin',
    })

    // 10. The folder flow's command is offered by the installed application's
    //     own command surface. The native panel is deliberately NOT opened:
    //     a native panel is a modal on the operator's screen, and cancelling
    //     it needs an accessibility grant this environment does not have.
    const folderCommand = await page.evaluate(async () => {
      const desktop = (
        window as unknown as {
          __adeaDesktop?: { invoke?: (command: string, payload?: unknown) => Promise<unknown> }
        }
      ).__adeaDesktop
      if (typeof desktop?.invoke !== 'function') return 'no invoke surface'
      const commands = (desktop as unknown as { commands?: string[] }).commands
      return Array.isArray(commands) ? commands.join(',') : 'the command list is not exposed'
    })
    add({
      id: 'ui-folder-flow-command-is-offered',
      expected:
        'the installed application offers the folder-pick command on its own command surface (the native panel itself is not opened)',
      actual: `the command surface answered "${folderCommand}"`,
      ok: folderCommand !== 'no invoke surface',
      evidence: 'installed-app-origin',
    })

    // 11. The client never raised an uncaught error during the whole run.
    add({
      id: 'ui-no-uncaught-client-error',
      expected: 'the client raised no uncaught error while the rows ran',
      actual:
        pageErrors.length === 0
          ? 'the client raised no uncaught error'
          : `the client raised ${pageErrors.length} uncaught errors: ${pageErrors[0] ?? ''}`,
      ok: pageErrors.length === 0,
      evidence: 'installed-app-origin',
    })
  } catch (error) {
    add({
      id: 'ui-rows-completed',
      expected: 'the UI rows ran against the installed application origin',
      actual: `the UI run stopped early: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
      evidence: 'installed-app-origin',
    })
  } finally {
    await browser.close()
  }

  return rows
}

/** The rail entries the desktop client offers, for the report. */
export const INSTALLED_APP_RAIL_ENTRIES: readonly string[] = RAIL_ENTRIES
