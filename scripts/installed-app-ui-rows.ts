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
// surface answered it.
//
// The rows are deliberately about OBSERVABLE STATE: a view that changed, a
// panel that opened, a reload that came back, a repeated request that did not
// change anything. They assert what the user can see, not the shape of the
// code that produced it.
//
// A row that cannot be VERIFIED with the authority this run has is `pending`,
// and a pending row is never a pass: the run's verdict stays red until the
// row is either proved or explicitly owned elsewhere.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { chromium, type Page } from '@playwright/test'

/** The outcome of one UI row. `pending` is never a pass. */
export type UiStatus = 'pass' | 'fail' | 'pending'

/** One row of the UI matrix. */
export type UiRow = Readonly<{
  id: string
  expected: string
  actual: string
  ok: boolean
  status: UiStatus
  evidence: 'installed-app-origin'
  /** The screenshot file name, relative to the artifact directory. */
  screenshot?: string
}>

/** Builds a row, deriving `ok` from the status. */
function row(input: Omit<UiRow, 'ok'> & { ok?: boolean }): UiRow {
  const status = input.status ?? (input.ok === false ? 'fail' : 'pass')
  return { ...input, status, ok: status === 'pass' }
}

/**
 * The exact command the shell registers for the native folder picker.
 *
 * The identity is exact: a command that merely CONTAINS "folder" or "pick"
 * is a different command, and the assessment below refuses to treat it as the
 * folder-pick command.
 */
export const FOLDER_PICK_COMMAND = 'desktop_folder_pick'

/**
 * The verdict of the folder-pick command's presence on the command surface.
 *
 * The command is PROVED only when the surface exposes exactly
 * `desktop_folder_pick`. A surface that exposes no command list at all
 * cannot prove it, and the row stays pending; a surface that exposes a list
 * WITHOUT the folder pick is a failure of the expectation, not a pending.
 */
export function assessFolderCommandExposure(input: {
  /** Whether the bridge exposes an invoke surface at all. */
  hasInvoke: boolean
  /** The command names the surface exposes, when it exposes any. */
  commands: readonly string[]
}): { status: UiStatus; actual: string } {
  if (!input.hasInvoke) {
    return {
      status: 'fail',
      actual: 'the installed application exposed no invoke surface at all',
    }
  }
  if (input.commands.includes(FOLDER_PICK_COMMAND)) {
    return {
      status: 'pass',
      actual: `the command surface exposed ${FOLDER_PICK_COMMAND}`,
    }
  }
  if (input.commands.length === 0) {
    return {
      status: 'pending',
      actual:
        'the command surface exposes no command list, so the folder-pick command could not be verified; calling it would open the native panel, which needs a UI grant this run does not have',
    }
  }
  return {
    status: 'fail',
    actual: `the command surface exposed ${input.commands.length} command(s) and none of them is exactly ${FOLDER_PICK_COMMAND}`,
  }
}

/**
 * The verdict of the interrupted-navigation observation.
 *
 * `issuedOverlapping` says the two navigation requests were dispatched
 * WITHOUT waiting for the first to settle. When they were not overlapping,
 * the interruption was not exercised and the row is pending rather than a
 * pass.
 */
export function assessInterruptedNavigation(input: {
  issuedOverlapping: boolean
  settledSignature: string
  devSignature: string
  chatSignature: string
}): { status: UiStatus; actual: string } {
  if (!input.issuedOverlapping) {
    return {
      status: 'pending',
      actual:
        'the two navigation requests were not dispatched concurrently, so no interruption was exercised',
    }
  }
  if (input.devSignature === '' || input.devSignature === input.chatSignature) {
    return {
      status: 'pending',
      actual:
        'the Dev view and the Chat view render the same content, so the settled view could not be distinguished',
    }
  }
  if (input.settledSignature === input.devSignature) {
    return {
      status: 'pass',
      actual:
        'two overlapping navigation requests settled on the view the second request named, and that view is the one the destination renders on its own',
    }
  }
  return {
    status: 'fail',
    actual:
      'two overlapping navigation requests did not settle on the view the second request named',
  }
}

/**
 * The rows this module produces.
 *
 * The lane uses the list to record them as pending when the installed
 * application was not launched, so a row is never silently dropped.
 */
export const INSTALLED_APP_UI_ROW_IDS = [
  'ui-first-run-opens-a-guest-workspace',
  'ui-chat-view-opens',
  'ui-dev-view-opens',
  'ui-app-library-opens',
  'ui-default-destinations-are-chat-and-dev',
  'ui-optional-destinations-are-offered',
  'ui-back-and-forward-navigate',
  'ui-repeated-navigation-is-idempotent',
  'ui-interrupted-navigation-settles-on-the-last-request',
  'ui-interrupted-navigation-leaves-no-half-open-view',
  'ui-reload-returns-to-the-workspace',
  'ui-the-installed-bridge-is-present-in-the-page',
  'ui-folder-flow-command-is-offered',
  'ui-no-uncaught-client-error',
] as const

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

/**
 * A stable signature of the rendered view, for "did this change?" questions.
 *
 * It carries the view's headings AND the controls that are marked as current
 * or selected — the rendered content, not the rail. The rail offers every
 * destination at all times, so a rail-only signature would make every
 * navigation question trivially true.
 */
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
    const landmarks = Array.from(document.querySelectorAll('main,[role="main"]'))
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120))
      .slice(0, 4)
    return JSON.stringify({ headings, selected, landmarks })
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
  const add = (entry: UiRow) => {
    rows.push(entry)
  }

  /** The rendered signature of each destination, as it was actually observed. */
  let homeSignature = ''
  let chatSignature = ''
  let devSignature = ''

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
    add(
      row({
        id: 'ui-first-run-opens-a-guest-workspace',
        expected:
          'the installed application opens into a guest workspace with its rail (Chat, Dev, App Library) available',
        actual: railPresent
          ? 'the guest workspace rendered with its rail entries'
          : `the rail never appeared; the rendered view was "${firstRunText.slice(0, 120)}"`,
        status: railPresent ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('first-run'),
      })
    )

    homeSignature = await viewSignature(page)

    // 2. The Chat view opens.
    const chatClicked = await clickControl(page, 'Chat view')
    chatSignature = await viewSignature(page)
    const chatText = await visibleText(page)
    add(
      row({
        id: 'ui-chat-view-opens',
        expected: 'the Chat view opens and the rendered view changes',
        actual: chatClicked
          ? `the Chat view rendered "${chatText.slice(0, 120)}"`
          : 'the Chat view control was not present',
        status: chatClicked && chatSignature !== homeSignature ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('chat-view'),
      })
    )

    // 3. The Dev view opens.
    const devClicked = await clickControl(page, 'Dev view')
    devSignature = await viewSignature(page)
    const devText = await visibleText(page)
    add(
      row({
        id: 'ui-dev-view-opens',
        expected: 'the Dev view opens and the rendered view changes',
        actual: devClicked
          ? `the Dev view rendered "${devText.slice(0, 120)}"`
          : 'the Dev view control was not present',
        status: devClicked && devSignature !== chatSignature ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('dev-view'),
      })
    )

    // 4. The App Library opens, and the optional entries are reachable.
    const libraryClicked = await clickControl(page, 'App Library')
    const libraryText = await visibleText(page)
    const librarySignature = await viewSignature(page)
    // The library names its optional destinations as the product names them:
    // Virtual, Kanban and Source control.
    const optionalEntries = ['Virtual', 'Kanban', 'Source control'].map((name) => ({
      name,
      present: libraryText.includes(name),
    }))
    add(
      row({
        id: 'ui-app-library-opens',
        expected: 'the App Library opens and lists the optional destinations it offers',
        actual: libraryClicked
          ? `the App Library rendered "${libraryText.slice(0, 120)}"`
          : 'the App Library control was not present',
        status: libraryClicked && librarySignature !== devSignature ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('app-library'),
      })
    )
    add(
      row({
        id: 'ui-default-destinations-are-chat-and-dev',
        expected: 'the App Library offers Chat and Dev as the destinations that are on by default',
        actual: libraryText.includes('Chat and Dev are on by default')
          ? 'the library states that Chat and Dev are on by default'
          : 'the library did not state its default destinations',
        status: libraryText.includes('Chat and Dev are on by default') ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('app-library-defaults'),
      })
    )
    add(
      row({
        id: 'ui-optional-destinations-are-offered',
        expected:
          'the optional destinations (Virtual, Kanban, Source control) are offered by the App Library, whether or not they are enabled',
        actual: `the App Library offered ${optionalEntries
          .map((entry) => `${entry.name}: ${entry.present ? 'present' : 'absent'}`)
          .join(', ')}`,
        status: optionalEntries.every((entry) => entry.present) ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('app-library-optional'),
      })
    )

    // 5. Back and forward.
    await clickControl(page, 'Chat view')
    const afterChat = await viewSignature(page)
    const backClicked = await clickControl(page, 'Back')
    const afterBack = await viewSignature(page)
    const forwardClicked = await clickControl(page, 'Forward')
    const afterForward = await viewSignature(page)
    add(
      row({
        id: 'ui-back-and-forward-navigate',
        expected: 'Back returns to the previous view and Forward returns to the later one',
        actual:
          backClicked && forwardClicked
            ? `back changed the view: ${afterBack !== afterChat}; forward restored it: ${
                afterForward === afterChat
              }`
            : 'the Back or Forward control was not present',
        status:
          backClicked && forwardClicked && afterBack !== afterChat && afterForward === afterChat
            ? 'pass'
            : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('back-forward'),
      })
    )

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
    add(
      row({
        id: 'ui-repeated-navigation-is-idempotent',
        expected: 'repeating the same navigation request leaves the view exactly as it was',
        actual: `three requests to the same destination left the view ${
          repeatedBefore === repeatedAfter ? 'unchanged' : 'changed'
        }`,
        status: repeatedBefore === repeatedAfter ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('repeated-navigation'),
      })
    )

    // 7. An interrupted navigation settles on the last request.
    //
    // The observation is the RENDERED view, and it is compared with the
    // signature the Dev view produced when it was opened on its own. The
    // permanent Dev rail entry proves nothing about an interruption: it is
    // present before and after any navigation, so a row that only looks for
    // it is true by construction.
    // Both dispatches happen in ONE evaluation, so the second request is
    // issued before the first can settle. The previous version waited for the
    // Chat view to settle first, which proved ordinary navigation rather than
    // an interruption.
    const issuedOverlapping = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const chat = buttons.find((element) => element.getAttribute('aria-label') === 'Chat view') as
        | HTMLElement
        | undefined
      const dev = buttons.find((element) => element.getAttribute('aria-label') === 'Dev view') as
        | HTMLElement
        | undefined
      if (!chat || !dev) return false
      chat.click()
      dev.click()
      return true
    })
    await page.waitForTimeout(2_500)
    const settled = await viewSignature(page)
    const settledText = await visibleText(page)
    const interruption = assessInterruptedNavigation({
      issuedOverlapping,
      settledSignature: settled,
      devSignature,
      chatSignature,
    })
    add(
      row({
        id: 'ui-interrupted-navigation-settles-on-the-last-request',
        expected:
          'two navigation requests dispatched without waiting for the first to settle leave the rendered view on the destination the second request named',
        actual: `${interruption.actual}; it rendered "${settledText.slice(0, 120)}"`,
        status: interruption.status,
        evidence: 'installed-app-origin',
        screenshot: await shoot('interrupted-navigation'),
      })
    )

    add(
      row({
        id: 'ui-interrupted-navigation-leaves-no-half-open-view',
        expected:
          "an interrupted navigation leaves no half-open intermediate view behind in the client's own state",
        actual:
          'the rendered view cannot show whether an intermediate request left state behind; that needs an instrumented client, so the broad interruption claim is not proved here',
        status: 'pending',
        evidence: 'installed-app-origin',
        screenshot: await shoot('interrupted-navigation-state'),
      })
    )

    // 8. A reload brings the application back into its workspace.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    const reloaded = await page
      .waitForFunction(() => (document.body?.innerText ?? '').includes('Chat view'), undefined, {
        timeout: 60_000,
      })
      .then(() => true)
      .catch(() => false)
    add(
      row({
        id: 'ui-reload-returns-to-the-workspace',
        expected:
          'reloading the application returns to the workspace, with the client state intact',
        actual: reloaded
          ? 'the application returned to the workspace after the reload'
          : 'the application did not return to the workspace',
        status: reloaded ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
        screenshot: await shoot('reload'),
      })
    )

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
    add(
      row({
        id: 'ui-the-installed-bridge-is-present-in-the-page',
        expected: 'the page carries the desktop bridge the installed application injects',
        actual: bridge.present
          ? `the bridge exposed ${bridge.keys.length} entries`
          : 'the page carried no desktop bridge',
        status: bridge.present ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
      })
    )

    // 10. The folder flow's command.
    //
    // The command is only PROVED when the installed application's own command
    // surface exposes it. When the list is not exposed, the row is pending:
    // invoking the folder pick would open the native panel, a modal on the
    // operator's screen that needs an accessibility grant this run does not
    // have, so the row cannot be proved by calling it either.
    const folderCommand = await page.evaluate(() => {
      const desktop = (
        window as unknown as {
          __adeaDesktop?: {
            invoke?: (command: string, payload?: unknown) => Promise<unknown>
            commands?: string[]
          }
        }
      ).__adeaDesktop
      if (typeof desktop?.invoke !== 'function') return { hasInvoke: false, list: [] }
      const list = Array.isArray(desktop.commands) ? desktop.commands : []
      return { hasInvoke: true, list }
    })
    const folder = assessFolderCommandExposure({
      hasInvoke: folderCommand.hasInvoke,
      commands: folderCommand.list,
    })
    add(
      row({
        id: 'ui-folder-flow-command-is-offered',
        expected: `the installed application exposes exactly ${FOLDER_PICK_COMMAND} on its own command surface, so the flow's command is proved rather than assumed`,
        actual: folder.actual,
        status: folder.status,
        evidence: 'installed-app-origin',
      })
    )

    // 11. The client never raised an uncaught error during the whole run.
    add(
      row({
        id: 'ui-no-uncaught-client-error',
        expected: 'the client raised no uncaught error while the rows ran',
        actual:
          pageErrors.length === 0
            ? 'the client raised no uncaught error'
            : `the client raised ${pageErrors.length} uncaught errors: ${pageErrors[0] ?? ''}`,
        status: pageErrors.length === 0 ? 'pass' : 'fail',
        evidence: 'installed-app-origin',
      })
    )
  } catch (error) {
    add(
      row({
        id: 'ui-rows-completed',
        expected: 'the UI rows ran against the installed application origin',
        actual: `the UI run stopped early: ${error instanceof Error ? error.message : String(error)}`,
        status: 'fail',
        evidence: 'installed-app-origin',
      })
    )
  } finally {
    await browser.close()
  }

  return rows
}
