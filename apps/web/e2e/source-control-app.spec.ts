// Source control app: the production SourceControlApp over a deterministic
// runtime. Covers the sidebar tree and shortcuts, the show-more bar (per-row
// hide/show controls plus the pointer drag across the bar), inbox grouping and
// row actions, filters, the pull request conversation with thread resolution
// and commenting, the merge dock's plan/commit merge with confirmation, update
// branch, the review flow with a pending inline comment, checks with the
// failing log, the new pull request dialog, a GitLab project through the same
// screens (rebase-only updates, no change requests), the disconnected states,
// and keyboard-only navigation, in dark and light.
import { expect, test, type Page } from '@playwright/test'
import axe from 'axe-core'
import type { AppearanceEditorFontSettings } from '@adea-ai/ui/lib/appearance-font-settings'

import {
  SOURCE_CONTROL_HARNESS_PATH,
  sourceControlHarnessHtml,
  sourceControlHarnessModuleSource,
} from './helpers/source-control-harness'
import { disableTransitions } from './helpers/visual'

const SCREENSHOTS = process.env.SOURCE_CONTROL_SCREENSHOTS

async function openHarness(page: Page, query = '') {
  await disableTransitions(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.route(new RegExp(`${SOURCE_CONTROL_HARNESS_PATH}(?:\\?.*)?$`), (route) =>
    route.fulfill({ contentType: 'text/html', body: sourceControlHarnessHtml() })
  )
  await page.goto(`${SOURCE_CONTROL_HARNESS_PATH}${query}`)
  await page.addScriptTag({ type: 'module', content: sourceControlHarnessModuleSource() })
  // A cold dev server compiles the Tailwind sheet on first load; give it room.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.sourceControlHarness)), { timeout: 90_000 })
    .toBe(true)
  await expect(page.getByRole('main', { name: 'Source control' })).toBeVisible({ timeout: 30_000 })
}

type Violation = { id: string; impact: string; targets: string[][] }

/** The first sync rewrites the sidebar tree; measure geometry only after it. */
async function settled(page: Page) {
  await expect(
    page.getByRole('toolbar', { name: 'Workspace toolbar' }).getByText(/Synced/)
  ).toBeVisible()
}

async function audit(page: Page): Promise<Violation[]> {
  await page.addScriptTag({ content: axe.source })
  return page.evaluate(async () => {
    const runner = window as unknown as {
      axe: {
        run: (
          context: Document,
          options: object
        ) => Promise<{
          violations: { id: string; impact: string; nodes: { target: string[] }[] }[]
        }>
      }
    }
    const result = await runner.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    })
    return result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map(({ target }) => target),
    }))
  })
}

async function commands(page: Page): Promise<string[]> {
  return page.evaluate(() => window.sourceControlHarness.commands().map((entry) => entry.operation))
}

async function expectFontLoaded(page: Page, family: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          [...document.fonts].some(
            (face) => face.family.includes(name) && face.status === 'loaded'
          ),
        family
      )
    )
    .toBe(true)
}

async function shot(page: Page, name: string) {
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/${name}.png` })
}

declare global {
  interface Window {
    sourceControlHarness: {
      commands(): { operation: string; body: Record<string, unknown> }[]
      setFonts(settings: AppearanceEditorFontSettings): void
      resetFonts(): void
    }
    /** Element churn recorded by instrumentRemovals since instrumentation. */
    __adeaScmChurn?: string[]
  }
}

/** Record every element added or removed inside `scopeSelector`, so a rebuild
 *  cannot hide: the observer sees the churn synchronously, however brief the
 *  window. Assertions filter to the structural classes a rebuild would touch,
 *  never to the busy spinner's own in-place churn. */
async function instrumentRemovals(page: Page, scopeSelector: string) {
  await page.evaluate((selector) => {
    const target = document.querySelector(selector)
    if (!target) throw new Error(`nothing matches ${selector} to instrument`)
    window.__adeaScmChurn = []
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes])
          if (node instanceof Element)
            window.__adeaScmChurn!.push(`${node.nodeName}.${String(node.className).slice(0, 40)}`)
      }
    }).observe(target, { childList: true, subtree: true })
  }, scopeSelector)
}

test.describe('source control app', () => {
  test('source control maps UI, Content, and Code preferences to captions, discussion, and diffs', async ({
    page,
  }) => {
    await openHarness(page)
    await page
      .getByRole('button', { name: /Migrate workspace store to Solid signals/ })
      .first()
      .click()

    const thread = page.getByRole('article', { name: 'Review thread on src/stores/selectors.ts' })
    const uiCaption = thread.locator('.dev-scm-caption').first()
    const content = thread.locator('.dev-scm-card__body')
    const code = thread.locator('.dev-scm-diff')
    await expect(thread).toBeVisible()

    const settings = {
      ui: { family: 'space-grotesk', size: 28 },
      content: { family: 'geist', size: 18 },
      code: { family: 'jetbrains-mono', size: 16 },
    } as const
    await page.evaluate((fonts) => window.sourceControlHarness.setFonts(fonts), settings)
    await expectFontLoaded(page, 'Space Grotesk')
    await expectFontLoaded(page, 'Geist')
    await expectFontLoaded(page, 'JetBrains Mono')
    await expect(uiCaption).toHaveCSS('font-size', '24px')
    await expect(uiCaption).toHaveCSS('font-family', /Space Grotesk/)
    await expect(content).toHaveCSS('font-size', '18px')
    await expect(content).toHaveCSS('font-family', /Geist/)
    await expect(code).toHaveCSS('font-size', '16px')
    await expect(code).toHaveCSS('font-family', /JetBrains Mono/)

    const smallerCodeSettings = {
      ...settings,
      code: { family: 'jetbrains-mono', size: 12 },
    } as const
    await page.evaluate((fonts) => window.sourceControlHarness.setFonts(fonts), smallerCodeSettings)
    await expect(code).toHaveCSS('font-size', '12px')
    await expect(uiCaption).toHaveCSS('font-size', '24px')
    await expect(content).toHaveCSS('font-size', '18px')

    await page.evaluate(() => window.sourceControlHarness.resetFonts())
    await expect(code).toHaveCSS('font-size', '12px')
    await expect(content).toHaveCSS('font-size', '14px')
    await expect(uiCaption).toHaveCSS('font-size', '12px')
    await expect(thread.getByText('Does rooms() ever return undefined')).toBeVisible()
  })

  test('inbox groups pull requests by what they need next', async ({ page }) => {
    await openHarness(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    // The harness catalog uses the deterministic UUID family the strict
    // Worktree DTO requires (see source-control-harness-app.tsx).
    await expect(
      sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    ).toContainText('adea')
    await expect(sidebar.getByText('octocat', { exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Archived projects' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'adea-ai / adea' })).toBeVisible()
    for (const group of ['Ready to merge', 'Needs your review', 'Blocked', 'Drafts'])
      await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible()
    const blocked = page.getByRole('region', { name: 'Blocked' })
    await expect(
      blocked.getByRole('button', { name: 'Update branch: Collapse rail labels into tooltips' })
    ).toBeVisible()
    await expect(
      blocked.getByRole('button', { name: 'Open: Add GitLab provider adapter' })
    ).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: 'Drafts' })
        .getByRole('button', { name: /^Open: Inline review threads/ })
    ).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: 'Needs your review' })
        .getByRole('button', { name: /^Review:/ })
    ).toHaveCount(2)
    await shot(page, '01-inbox-dark')

    await page.getByRole('searchbox', { name: 'Filter pull requests' }).fill('#904')
    await expect(page.locator('[data-pr]')).toHaveCount(1)
    await page.getByRole('searchbox', { name: 'Filter pull requests' }).fill('')
    await page.getByText('Opened by agents only', { exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Opened by agents only' })).toBeChecked()
    await expect(page.locator('[data-pr="911"]')).toHaveCount(0)
    await expect(page.locator('[data-pr="904"]')).toHaveCount(1)

    await page.getByRole('tab', { name: 'Merged' }).click()
    await expect(page.getByText('Ship the conversation transcript')).toBeVisible()
  })

  test('cross-project shortcuts and persisted selection', async ({ page }) => {
    await openHarness(page)
    await page.getByRole('button', { name: /^Needs you/ }).click()
    await expect(page.getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible()
    await expect(page.locator('[data-pr="904"]')).toBeVisible()
    await page.getByRole('button', { name: /^Ready to merge/ }).click()
    await expect(page.locator('[data-pr="912"]')).toBeVisible()
    await expect(page.locator('[data-pr="904"]')).toHaveCount(0)
    // The selection survives a restart.
    await openHarness(page, '?reset=keep')
    await expect(
      page.getByRole('heading', { name: 'Ready to merge', exact: true }).first()
    ).toBeVisible()
    await expect(page.locator('[data-pr="912"]')).toBeVisible()
  })

  test('top bar search jumps to a pull request across projects', async ({ page }) => {
    await openHarness(page)
    const toolbar = page.getByRole('toolbar', { name: 'Workspace toolbar' })
    await expect(toolbar.getByText(/Synced/)).toBeVisible()
    const search = toolbar.getByRole('searchbox', { name: 'Search pull requests and branches' })
    await search.fill('rail-tooltips')
    await expect(
      page.getByRole('button', { name: /Collapse rail labels into tooltips adea #901/ })
    ).toBeVisible()
    await search.press('Enter')
    await expect(
      page.getByRole('heading', { name: /Collapse rail labels into tooltips/ })
    ).toBeVisible()
    await toolbar.getByRole('button', { name: 'Sync now' }).click()
    await expect(toolbar.getByText(/Synced/)).toBeVisible()
  })

  test('merging from the inbox confirms, then plans and commits', async ({ page }) => {
    await openHarness(page)
    await page
      .getByRole('button', { name: 'Merge: Add source control shell and provider adapters' })
      .click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('Squash and merge #912?')
    await shot(page, '02-merge-confirm')
    await dialog.getByRole('button', { name: 'Squash and merge' }).click()
    await expect(dialog).toBeHidden()
    await expect(
      page.getByText('Merged #912 and deleted agent/juno/source-control-shell.')
    ).toBeVisible()
    const sent = await commands(page)
    expect(sent.indexOf('dev.github.mergePlan')).toBeGreaterThan(-1)
    expect(sent.indexOf('dev.github.mergeCommit')).toBeGreaterThan(
      sent.indexOf('dev.github.mergePlan')
    )
  })

  test('conversation, threads, comments and the merge dock', async ({ page }) => {
    await openHarness(page)
    await page
      .getByRole('button', { name: /Migrate workspace store to Solid signals/ })
      .first()
      .click()
    await expect(
      page.getByRole('heading', { name: /Migrate workspace store to Solid signals/ })
    ).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Pull request details' })).toBeVisible()
    await expect(
      page.getByRole('complementary', { name: 'Pull request details' }).getByText('Store migration')
    ).toBeVisible()
    const thread = page.getByRole('article', { name: 'Review thread on src/stores/selectors.ts' })
    await expect(thread).toContainText('Does rooms() ever return undefined')
    const dock = page.getByRole('region', { name: 'Merge status' })
    await expect(dock).toContainText('5 commits behind main')
    await expect(dock.getByRole('button', { name: 'Squash and merge when ready' })).toBeVisible()
    await shot(page, '03-conversation-dark')

    await thread.getByRole('button', { name: 'Resolve conversation' }).click()
    await expect(thread.getByText('Resolved', { exact: true })).toBeVisible()

    await page.getByRole('textbox', { name: 'Comment' }).fill('Looks good to me.')
    await page.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(page.getByText('Looks good to me.')).toBeVisible()

    await dock.getByRole('button', { name: 'Update branch', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Update branch' }).click()
    await expect(page.getByText(/Updated agent\/juno\/solid-store-signals from main/)).toBeVisible()

    await dock.getByRole('button', { name: 'Squash and merge when ready' }).click()
    await expect(page.getByText('Auto-merge enabled.')).toBeVisible()
    await expect(dock.getByRole('button', { name: 'Cancel auto-merge' })).toBeVisible()
    const sent = await commands(page)
    expect(sent).toContain('dev.github.syncBranchCommit')
    expect(sent).toContain('dev.github.autoMergeCommit')
    expect(sent).toContain('dev.github.threadResolve')
  })

  test('review: pending inline comment, then submit with a verdict', async ({ page }) => {
    await openHarness(page)
    await page
      .getByRole('button', { name: /Migrate workspace store to Solid signals/ })
      .first()
      .click()
    await page.getByRole('tab', { name: /Files changed/ }).click()
    await expect(page.getByRole('article', { name: 'src/stores/workspace.ts' })).toBeVisible()
    await expect(page.getByText('GitHub does not show this diff')).toBeVisible()
    await page.getByRole('button', { name: 'Comment on src/stores/workspace.ts line 16' }).click()
    await page
      .getByRole('textbox', { name: /Review comment on src\/stores\/workspace.ts line 16/ })
      .fill('Sort by last activity only?')
    await page.getByRole('button', { name: 'Add to review' }).click()
    await expect(page.getByText('Pending', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Split' }).click()
    await shot(page, '04-files-split')
    await page
      .getByRole('article', { name: 'src/stores/selectors.ts' })
      .getByText('Viewed', { exact: true })
      .click()
    await expect(page.getByText('1 of 3 files viewed')).toBeVisible()

    await page.getByRole('button', { name: /Review changes/ }).click()
    await page.getByRole('textbox', { name: 'Review summary' }).fill('One question on ordering.')
    await page.getByText('Approve', { exact: true }).click()
    await expect(page.getByRole('radio', { name: /Approve/ })).toBeChecked()
    await shot(page, '05-review-popover')
    await page.getByRole('button', { name: 'Submit review' }).click()
    await expect(page.getByText('Review submitted.')).toBeVisible()
    const sent = await page.evaluate(() =>
      window.sourceControlHarness
        .commands()
        .find((entry) => entry.operation === 'dev.github.submitReview')
    )
    expect(sent?.body).toMatchObject({
      verdict: 'approve',
      body: 'One question on ordering.',
      comments: [
        {
          path: 'src/stores/workspace.ts',
          line: 16,
          side: 'right',
          body: 'Sort by last activity only?',
        },
      ],
    })
  })

  test('checks: failing runs, the failures log and re-running', async ({ page }) => {
    await openHarness(page)
    await page
      .getByRole('button', { name: /Migrate workspace store to Solid signals/ })
      .first()
      .click()
    await page.getByRole('tab', { name: /Checks/ }).click()
    await expect(
      page.getByRole('heading', { name: /2 failing, 1 passing, 1 running, 1 skipped/ })
    ).toBeVisible()
    // Failing runs lead the list; the first one's log opens by default.
    await expect(page.getByRole('listitem').first()).toContainText('typecheck')
    await expect(page.getByRole('region', { name: 'Log for typecheck' })).toBeVisible()
    await page.getByRole('button', { name: 'View log for unit-tests' }).click()
    const log = page.getByRole('region', { name: 'Log for unit-tests' })
    await expect(log).toContainText('maps "unapproved" after approval')
    await expect(log).not.toContainText('case 1\n')
    await page.getByRole('tab', { name: 'Full log' }).click()
    await expect(log).toContainText('case 12')
    await shot(page, '06-checks')
    await page.getByRole('button', { name: 'Re-run failed jobs' }).click()
    await expect(page.getByText('Failed jobs are re-running.')).toBeVisible()
  })

  test('new pull request opens a draft and opens it', async ({ page }) => {
    await openHarness(page)
    await page.getByRole('button', { name: 'New pull request' }).click()
    const dialog = page.getByRole('dialog', { name: 'New pull request' })
    await expect(dialog.getByText('6 commits · 9 files')).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('New feature')
    await shot(page, '07-new-pr')
    await dialog.getByRole('button', { name: 'Create pull request' }).click()
    await expect(page.getByRole('heading', { name: /New feature/ })).toBeVisible()
    const sent = await page.evaluate(() =>
      window.sourceControlHarness
        .commands()
        .find((entry) => entry.operation === 'dev.github.createPullRequest')
    )
    expect(sent?.body).toMatchObject({
      headRef: 'agent/juno/new-feature',
      baseRef: 'main',
      draft: true,
    })
  })

  test('a disconnected GitHub CLI explains how to connect', async ({ page }) => {
    await openHarness(page, '?scenario=disconnected')
    await expect(page.getByText('Connect GitHub', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Connect account' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Git providers' })
    await expect(dialog).toContainText('gh auth login')
    await expect(dialog).toContainText('never stores a GitHub token')
    await shot(page, '08-providers')
  })

  test('a connected CLI with unregistered projects says why nothing is listed', async ({
    page,
  }) => {
    // gh is connected and the Dev view has projects, but no registry record
    // was proven: the sidebar must say so honestly — adoption runs
    // automatically when a project is added, a removal is undoable from the
    // Repositories panel, and unregistered archived projects are stated
    // separately because auto-adopt skips them.
    await openHarness(page, '?scenario=unregistered')
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    await expect(
      sidebar.getByText(/5 projects are not listed because their repositories are not registered/)
    ).toBeVisible()
    await expect(
      sidebar.getByText(/Adoption runs automatically when a project is added/)
    ).toBeVisible()
    await expect(sidebar.getByText(/remove repositories from the registry/)).toBeVisible()
    await expect(sidebar.getByText(/1 archived project is also not registered/)).toBeVisible()
    await page.getByRole('button', { name: 'Connect account' }).click()
    const dialog = page.getByRole('dialog', { name: 'Git providers' })
    await expect(
      dialog.getByText('Checking confirms the CLI sign-in Adea uses for your pull requests.')
    ).toBeVisible()
    await expect(
      dialog.getByText(/Adoption runs automatically when a project is added/)
    ).toBeVisible()
    await expect(dialog.getByText(/adopt or remove repositories/)).toBeVisible()
  })

  test('a completed auto-adopt lists the project without any client adopt command', async ({
    page,
  }) => {
    // The host adopts during import as a background side effect. The first
    // catalog read sees nothing registered and the sidebar says so (active
    // and archived projects stated separately); once the proof lands, the
    // next sync lists the project — and the client never issued
    // dev.repo.adopt, which stays a host-side proof.
    await openHarness(page, '?scenario=auto-adopt')
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    await expect(
      sidebar.getByText(/5 projects are not listed because their repositories are not registered/)
    ).toBeVisible()
    // The notice renders as soon as the catalog flips `catalogLoaded`, which
    // happens mid-sync; `sync()` sets `syncedAt` only at the very end, and a
    // focus dispatched meanwhile is swallowed by the in-flight guard. Wait
    // for the first sync to fully settle so the re-sync below is guaranteed
    // to run.
    await settled(page)
    // Adoption completes host-side: advance the clock past the focus
    // re-sync gate and re-focus; no adopt command exists in the log.
    await page.evaluate(() => {
      window.sourceControlHarness.advanceClock(11_000)
      window.dispatchEvent(new Event('focus'))
    })
    await expect(
      sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    ).toBeVisible()
    await expect(
      sidebar.getByText(/projects are not listed because their repositories are not registered/)
    ).toHaveCount(0)
    expect(await commands(page)).not.toContain('dev.repo.adopt')
  })

  test('hiding a repository collapses it below the show-more line and persists', async ({
    page,
  }) => {
    await openHarness(page)
    // Assert against the settled tree, never a mid-sync rebuild (the same
    // discipline the drag tests below follow).
    await settled(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    const row = sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    await expect(row).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Hidden repositories' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Hide adea below the show-more line' }).click()
    // The row left the owner section for the collapsed group; hiding is a
    // display preference — the row stays in the registry and remains
    // selectable inside the group.
    await expect(
      sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    ).toHaveCount(0)
    const hiddenToggle = sidebar.getByRole('button', { name: 'Hidden repositories' })
    await expect(hiddenToggle).toBeVisible()
    await hiddenToggle.click()
    const restored = sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    await expect(restored).toBeVisible()
    await page.getByRole('button', { name: 'Show adea in the sidebar' }).click()
    await expect(row).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Hidden repositories' })).toHaveCount(0)
  })

  test('the hidden set survives a reload', async ({ page }) => {
    await openHarness(page)
    await settled(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    await page.getByRole('button', { name: 'Hide ui below the show-more line' }).click()
    await expect(
      sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000102"]')
    ).toHaveCount(0)
    // A reload that keeps storage must keep the display preference.
    await page.goto(`${SOURCE_CONTROL_HARNESS_PATH}?reset=keep`)
    await page.addScriptTag({ type: 'module', content: sourceControlHarnessModuleSource() })
    await expect
      .poll(() => page.evaluate(() => Boolean(window.sourceControlHarness)), { timeout: 90_000 })
      .toBe(true)
    // The reloaded page boots its own app instance and its own first sync:
    // settle it too, so the absence assertion below measures the restored
    // preference rather than a tree that has not rendered yet.
    await settled(page)
    const reloaded = page.getByRole('complementary', { name: 'Accounts and projects' })
    await expect(
      reloaded.locator('[data-repo-id="00000000-0000-4000-8000-000000000102"]')
    ).toHaveCount(0)
    const hiddenToggle = reloaded.getByRole('button', { name: 'Hidden repositories' })
    await expect(hiddenToggle).toBeVisible()
    await hiddenToggle.click()
    await expect(
      reloaded.locator('[data-repo-id="00000000-0000-4000-8000-000000000102"]')
    ).toBeVisible()
    // Restore for the shared fixture page state.
    await page.getByRole('button', { name: 'Show ui in the sidebar' }).click()
  })

  test('dragging a repository across the show-more bar hides it and drags it back out', async ({
    page,
  }) => {
    await openHarness(page)
    await settled(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    const adea = sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    const bar = sidebar.locator('.dev-scm-dragbar')
    await expect(adea).toBeVisible()
    // Nothing is hidden yet: the bar is a bare seam with no group grip.
    await expect(bar).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Hidden repositories' })).toHaveCount(0)

    // Press the row, drag it below the line, and release: it joins the group.
    const rowBox = (await adea.boundingBox())!
    const barBox = (await bar.boundingBox())!
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(rowBox.x + rowBox.width / 2, barBox.y + barBox.height / 2 + 24, {
      steps: 8,
    })
    // Crossing arms the drop-target line while the button is still held.
    await expect(bar).toHaveAttribute('data-armed', '')
    await page.mouse.up()
    await expect(adea).toHaveCount(0)
    const hiddenToggle = sidebar.getByRole('button', { name: 'Hidden repositories' })
    await expect(hiddenToggle).toHaveCount(1)

    // The row is physically below the bar inside the collapsed group.
    await hiddenToggle.click()
    const hiddenRow = sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    await expect(hiddenRow).toBeVisible()
    const hiddenBox = (await hiddenRow.boundingBox())!
    const barAfter = (await bar.boundingBox())!
    expect(hiddenBox.y).toBeGreaterThan(barAfter.y + barAfter.height)

    // Drag it back above the line: it returns to the owner section and the
    // empty group disappears again.
    const barBox2 = (await bar.boundingBox())!
    await page.mouse.move(hiddenBox.x + hiddenBox.width / 2, hiddenBox.y + hiddenBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(barBox2.x + barBox2.width / 2, barBox2.y - 24, { steps: 8 })
    await expect(bar).toHaveAttribute('data-armed', '')
    await page.mouse.up()
    await expect(adea).toBeVisible()
    const restoredBox = (await adea.boundingBox())!
    expect(restoredBox.y).toBeLessThan(barBox2.y)
    await expect(sidebar.getByRole('button', { name: 'Hidden repositories' })).toHaveCount(0)
  })

  test('a drag that stays on its own side is a no-op and never selects', async ({ page }) => {
    await openHarness(page)
    await settled(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    const ui = sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000102"]')
    await expect(ui).toBeVisible()
    // The default selection is the first visible row, adea.
    await expect(page.getByRole('heading', { name: 'adea-ai / adea' })).toBeVisible()

    // Drag the ui row downwards but release above the bar: no reorder (the
    // bar is not a sort), the row stays visible, and the consumed gesture
    // does not fall through to the row's click.
    const rowBox = (await ui.boundingBox())!
    const barBox = (await sidebar.locator('.dev-scm-dragbar').boundingBox())!
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(rowBox.x + rowBox.width / 2, (rowBox.y + barBox.y) / 2, { steps: 6 })
    await page.mouse.up()
    await expect(ui).toBeVisible()
    await expect(page.getByRole('heading', { name: 'adea-ai / adea' })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Hidden repositories' })).toHaveCount(0)

    // A plain click on the same row still selects: hysteresis belongs to the
    // drag, not to the row.
    await ui.click()
    await expect(page.getByRole('heading', { name: 'adea-ai / ui' })).toBeVisible()
  })

  test('Escape cancels a drag past the bar without hiding anything', async ({ page }) => {
    await openHarness(page)
    await settled(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    const adea = sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    const rowBox = (await adea.boundingBox())!
    const barBox = (await sidebar.locator('.dev-scm-dragbar').boundingBox())!
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(rowBox.x + rowBox.width / 2, barBox.y + barBox.height / 2 + 24, {
      steps: 8,
    })
    await expect(sidebar.locator('.dev-scm-dragbar')).toHaveAttribute('data-armed', '')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    // Aborted: the row never left the visible list and nothing was hidden.
    await expect(adea).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Hidden repositories' })).toHaveCount(0)
    // The consumed gesture must not select the pressed row either.
    await expect(page.getByRole('heading', { name: 'adea-ai / adea' })).toBeVisible()
  })

  test('the bar grip toggles the group and the keyboard controls still hide', async ({ page }) => {
    await openHarness(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    const adea = sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000101"]')
    // The explicit per-row control remains the keyboard path.
    await page.getByRole('button', { name: 'Hide adea below the show-more line' }).click()
    await expect(adea).toHaveCount(0)
    const grip = sidebar.getByRole('button', { name: 'Expand the show-more group' })
    await expect(grip).toBeVisible()
    // The grip is the bar's keyboard representation: it toggles the group.
    await grip.click()
    await expect(adea).toBeVisible()
    await sidebar.getByRole('button', { name: 'Collapse the show-more group' }).click()
    await expect(adea).toHaveCount(0)
    await expect(sidebar.getByRole('button', { name: 'Hidden repositories' })).toBeVisible()
    // Restore for the shared fixture page state: expand the group again, then
    // the row's own control — the keyboard path — puts it back.
    await sidebar.getByRole('button', { name: 'Expand the show-more group' }).click()
    await page.getByRole('button', { name: 'Show adea in the sidebar' }).click()
    await expect(adea).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Hidden repositories' })).toHaveCount(0)
  })

  test('a GitLab project runs through the same screens', async ({ page }) => {
    await openHarness(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    await expect(sidebar.getByText('GitLab', { exact: true })).toBeVisible()
    await sidebar.locator('[data-repo-id="00000000-0000-4000-8000-000000000105"]').click()
    await expect(page.getByRole('heading', { name: 'platform/infra / runner' })).toBeVisible()
    await expect(page.locator('[data-pr="12"]')).toContainText('!12')
    await page
      .getByRole('button', { name: /Cache Go modules between jobs/ })
      .first()
      .click()
    await expect(page.getByRole('heading', { name: /Cache Go modules between jobs/ })).toBeVisible()

    // GitLab updates a branch by rebasing it: no merge-commit option.
    const dock = page.getByRole('region', { name: 'Merge status' })
    await expect(dock.getByRole('button', { name: 'Choose merge or rebase' })).toHaveCount(0)
    await dock.getByRole('button', { name: 'Update branch', exact: true }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('with a rebase?')
    await expect(confirm).toContainText('GitLab rebases the branch onto main')
    await shot(page, '10-gitlab-rebase')
    await confirm.getByRole('button', { name: 'Update branch' }).click()
    await expect(confirm).toBeHidden()

    // Approvals, not change requests.
    await page.getByRole('tab', { name: /Files changed/ }).click()
    await page.getByRole('button', { name: /Review changes/ }).click()
    await expect(page.getByRole('radio', { name: /Approve/ })).toBeVisible()
    await expect(page.getByRole('radio', { name: /Request changes/ })).toHaveCount(0)

    const sent = await page.evaluate(() => window.sourceControlHarness.commands())
    const plan = sent.find((entry) => entry.operation === 'dev.gitlab.syncBranchPlan')
    expect(plan?.body).toMatchObject({
      pullRequestId: 'gl:platform/infra/runner!12',
      method: 'rebase',
    })
    expect(sent.map((entry) => entry.operation)).toContain('dev.gitlab.syncBranchCommit')
    expect(sent.map((entry) => entry.operation)).toContain('dev.gitlab.account')
    expect(sent.some((entry) => entry.operation === 'dev.github.syncBranchPlan')).toBe(false)
  })

  test('one provider signed out leaves the other working', async ({ page }) => {
    await openHarness(page, '?scenario=gitlab-disconnected')
    await expect(page.getByRole('heading', { name: 'adea-ai / adea' })).toBeVisible()
    await expect(page.locator('[data-pr="912"]')).toBeVisible()
    await expect(page.getByText('GitLab not connected')).toBeVisible()
    await page
      .getByRole('complementary', { name: 'Accounts and projects' })
      .locator('[data-repo-id="00000000-0000-4000-8000-000000000105"]')
      .click()
    await expect(page.getByText('glab is not authenticated for this operation')).toBeVisible()
    await page.getByRole('button', { name: 'Connect account' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Git providers' })
    await expect(dialog).toContainText('glab auth login')
    await expect(dialog).toContainText('Signed in as octocat on github.com')
  })

  test('checking a provider updates its row in place and never rebuilds the menu', async ({
    page,
  }) => {
    await openHarness(page, '?scenario=gitlab-disconnected')
    await page.getByRole('button', { name: 'Connect account' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Git providers' })
    await expect(dialog).toBeVisible()
    // Opening the dialog checks both providers; wait for GitLab's refusal to
    // settle so the row carries its sign-in help.
    await expect(dialog.getByText('glab auth login')).toBeVisible()
    await expect(dialog.getByText('Signed in as octocat on github.com')).toBeVisible()

    const dialogHandle = await dialog.elementHandle()
    const gitlabCard = dialog.locator('.dev-scm-card').nth(1)
    const cardHandle = await gitlabCard.elementHandle()
    const helpHandle = await dialog.locator('.dev-scm-summary').first().elementHandle()
    await instrumentRemovals(page, '[role="dialog"]')

    await page.getByRole('button', { name: 'Check GitLab again' }).click()
    // The check settles back into the same refusal; the sign-in help must
    // have stayed mounted through the loading state, not vanished and
    // returned around the CLI invocation. The busy spinner's own churn is
    // filtered out — only a structural teardown would touch these classes.
    await expect(dialog.getByText('glab auth login')).toBeVisible()
    const churn = await page.evaluate(() => window.__adeaScmChurn ?? [])
    expect(
      churn.filter((entry) => /dev-scm-card|dev-scm-summary|dev-scm-provider-row/.test(entry))
    ).toEqual([])
    const sameDialog = await page.evaluate(
      ([before, after]) => before === after,
      [dialogHandle, await dialog.elementHandle()]
    )
    const sameCard = await page.evaluate(
      ([before, after]) => before === after,
      [cardHandle, await gitlabCard.elementHandle()]
    )
    const sameHelp = await page.evaluate(
      ([before, after]) => before === after,
      [helpHandle, await dialog.locator('.dev-scm-summary').first().elementHandle()]
    )
    expect(sameDialog).toBe(true)
    expect(sameCard).toBe(true)
    expect(sameHelp).toBe(true)
    // The check really ran: a fresh account command for GitLab is on record.
    const gitlabChecks = (await page.evaluate(() => window.sourceControlHarness.commands())).filter(
      (entry) => entry.operation === 'dev.gitlab.account'
    )
    expect(gitlabChecks.length).toBeGreaterThanOrEqual(2)
  })

  test('the labels picker keeps its list mounted while refetching', async ({ page }) => {
    await openHarness(page)
    await page.getByRole('button', { name: 'New pull request' }).click()
    const dialog = page.getByRole('dialog', { name: 'New pull request' })
    await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('New feature')
    await dialog.getByRole('button', { name: 'Add labels' }).click()
    const list = page.locator('.dev-scm-picker__list')
    await expect(list.getByRole('button', { name: 'migration' })).toBeVisible()
    const listHandle = await list.elementHandle()
    await instrumentRemovals(page, '.dev-scm-picker')

    // Every query keystroke refetches; the rendered list must stay the same
    // node and update in place instead of collapsing to a loading caption.
    // The removal observer catches a teardown synchronously, however brief
    // the refetch window is.
    await page.getByRole('searchbox', { name: 'Filter labels' }).fill('mi')
    await expect(list.getByRole('button', { name: 'migration' })).toBeVisible()
    await expect(list.getByRole('button', { name: 'solid' })).toHaveCount(0)
    // The refetch narrows the rows in place; the pre-fix behavior swapped the
    // whole list for a "Loading…" caption on every keystroke.
    const churn = await page.evaluate(() => window.__adeaScmChurn ?? [])
    expect(churn.filter((entry) => entry.includes('dev-scm-caption'))).toEqual([])
    const sameList = await page.evaluate(
      ([before, after]) => before === after,
      [listHandle, await list.elementHandle()]
    )
    expect(sameList).toBe(true)
  })

  test('an error toast paints above the Git providers dialog and leaves on its own', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await openHarness(page, '?scenario=gitlab-disconnected')
    await page.getByRole('button', { name: 'Connect account' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Git providers' })
    await expect(dialog).toBeVisible()
    // Opening the dialog checks every provider; the disconnected GitLab
    // check reports its refusal as an error toast.
    const toast = page.getByRole('status').filter({ hasText: 'GitLab:' }).first()
    await page.getByRole('button', { name: 'Check GitLab again' }).click()
    await expect(toast).toBeVisible()
    // The toast layer outranks the dialog layer on the named overlay scale:
    // its fixed ancestor carries the published --z-toast rung (180) while the
    // dialog positioner and scrim ride --z-dialog (120), so an open dialog
    // can never bury a toast. Hit-testing cannot prove paint order here —
    // the modal dialog marks its background siblings inert, and inert
    // elements are skipped by elementFromPoint.
    const layerZ = () =>
      toast.evaluate((node) => {
        let element: HTMLElement | null = node as HTMLElement
        while (element) {
          const style = getComputedStyle(element)
          if (style.position === 'fixed' && style.zIndex !== 'auto') return Number(style.zIndex)
          element = element.parentElement
        }
        return -1
      })
    const dialogLayerZ = () =>
      dialog.evaluate((node) => {
        let element: HTMLElement | null = node as HTMLElement
        while (element) {
          const style = getComputedStyle(element)
          if (style.position === 'fixed' && style.zIndex !== 'auto') return Number(style.zIndex)
          element = element.parentElement
        }
        return -1
      })
    const [toastZ, dialogZ] = await Promise.all([layerZ(), dialogLayerZ()])
    expect(toastZ).toBeGreaterThan(dialogZ)
    // Errors are not dismiss-only: the toast leaves on its own timer.
    await expect(toast).toBeHidden({ timeout: 10_000 })
  })

  test('keyboard reaches the inbox and opens a pull request', async ({ page }) => {
    await openHarness(page)
    const target = page.getByRole('button', { name: /Persist split layout sizes per room/ }).first()
    await target.focus()
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('heading', { name: /Persist split layout sizes per room/ })
    ).toBeVisible()
    await page.getByRole('tab', { name: /Conversation/ }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: /Commits/ })).toBeFocused()
  })

  test('light theme renders the inbox and conversation', async ({ page }) => {
    await openHarness(page, '?theme=light')
    await expect(page.getByRole('heading', { name: 'Ready to merge', exact: true })).toBeVisible()
    await shot(page, '09-inbox-light')
    await page
      .getByRole('button', { name: /Migrate workspace store to Solid signals/ })
      .first()
      .click()
    await expect(page.getByRole('region', { name: 'Merge status' })).toBeVisible()
    await shot(page, '10-conversation-light')
  })

  test('inbox and pull request detail pass a WCAG 2.2 AA audit', async ({ page }) => {
    await openHarness(page)
    await expect(page.getByRole('heading', { name: 'Ready to merge', exact: true })).toBeVisible()
    expect(await audit(page)).toEqual([])
    await page
      .getByRole('button', { name: /Migrate workspace store to Solid signals/ })
      .first()
      .click()
    await expect(page.getByRole('region', { name: 'Merge status' })).toBeVisible()
    await expect(page.getByText('Does rooms() ever return undefined')).toBeVisible()
    expect(await audit(page)).toEqual([])
  })
})
