// Source control app: the production SourceControlApp over a deterministic
// runtime. Covers the sidebar tree and shortcuts, inbox grouping and row
// actions, filters, the pull request conversation with thread resolution and
// commenting, the merge dock's plan/commit merge with confirmation, update
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
  }
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
    await expect(sidebar.locator('[data-repo-id="repo-adea"]')).toContainText('adea')
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

  test('a GitLab project runs through the same screens', async ({ page }) => {
    await openHarness(page)
    const sidebar = page.getByRole('complementary', { name: 'Accounts and projects' })
    await expect(sidebar.getByText('GitLab', { exact: true })).toBeVisible()
    await sidebar.locator('[data-repo-id="repo-runner"]').click()
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
      .locator('[data-repo-id="repo-runner"]')
      .click()
    await expect(page.getByText('glab is not authenticated for this operation')).toBeVisible()
    await page.getByRole('button', { name: 'Connect account' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Git providers' })
    await expect(dialog).toContainText('glab auth login')
    await expect(dialog).toContainText('Signed in as octocat on github.com')
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
    await expect(toast).toBeVisible()
    // The toast owns the pointer at its own centre while the dialog is open:
    // it is the top-most layer on screen, never buried by the dialog.
    await expect
      .poll(() =>
        toast.evaluate((node) => {
          const box = node.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          return node === hit || node.contains(hit)
        })
      )
      .toBe(true)
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
