// History pane: prompts with a reply summary, search over the same window, and
// accessible names that tell result buttons apart. Every result belongs to one
// session, so the session title alone would name each jump button identically;
// the matched event kind and preview have to reach the accessible name.
import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const HARNESS_PATH = '/__history-pane'

test.use({ headless: true })

async function mount(page: Page, query = '', harness = 'history-pane-harness-app.tsx') {
  await page.route(`**${HARNESS_PATH}*`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(`${HARNESS_PATH}${query}`)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), `apps/web/e2e/helpers/${harness}`)
  )
  await expect(page.getByRole('group', { name: 'History view' })).toBeVisible()
}

test('lists prompts newest first with a reply summary', async ({ page }) => {
  await mount(page)
  const list = page.getByRole('list', { name: 'Prompts and replies, newest first' })
  const rows = list.getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('write the release notes')
  await expect(rows.first()).toContainText('No reply recorded')
  await expect(rows.last()).toContainText('deploy the staging build')
  await expect(rows.last()).toContainText('Staging is live; production awaits your approval.')
  await expect(rows.last()).toContainText('1 tool call')
  await expect(rows.last()).toContainText('Done')
})

test('a row expands to the full prompt and reply and reports its state', async ({ page }) => {
  await mount(page)
  const toggle = page.getByRole('button', { name: 'Show full prompt and reply' }).last()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const less = page.getByRole('button', { name: 'Show less of this prompt' })
  await expect(less).toHaveAttribute('aria-expanded', 'true')
  await less.click()
  await expect(page.getByRole('button', { name: 'Show less of this prompt' })).toHaveCount(0)
})

test('result buttons for one session carry distinct accessible names', async ({ page }) => {
  await mount(page)
  await page.getByRole('textbox', { name: 'Search this conversation' }).fill('deploy')
  await expect(page.getByRole('status').filter({ hasText: 'result' })).toContainText('for “deploy”')

  const jumps = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button', { name: /^Go to Deploy planning,/ })
  const count = await jumps.count()
  expect(count).toBeGreaterThanOrEqual(2)
  const names = await jumps.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label'))
  )
  expect(new Set(names).size).toBe(count)
  expect(names).toContain('Go to Deploy planning, prompt: deploy the staging build')
  expect(names).toContain('Go to Deploy planning, approval: Deploy to production')

  await page
    .getByRole('button', { name: 'Go to Deploy planning, approval: Deploy to production' })
    .click()
  await expect(page.getByTestId('jumps')).toHaveText('event-3')
})

test('clearing the search returns to the turns list', async ({ page }) => {
  await mount(page)
  const search = page.getByRole('textbox', { name: 'Search this conversation' })
  await search.fill('nothing matches this')
  await expect(page.getByText('No matching history')).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(search).toHaveValue('')
  await expect(page.getByRole('list', { name: 'Prompts and replies, newest first' })).toBeVisible()
})

test('pages through a full 1,000-event window without dropping rows', async ({ page }) => {
  await mount(page, '?turns=995&bounded=1')
  await expect(page.getByText('Showing the latest events only.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search this conversation' }).fill('filler prompt')
  const results = page.getByRole('list', { name: 'Search results' }).getByRole('listitem')
  await expect(results).toHaveCount(100)
  const more = page.getByRole('button', { name: 'Load more' })
  for (let loaded = 100; loaded < 995; loaded += 100) {
    await more.click()
    await expect(results).toHaveCount(Math.min(loaded + 100, 995))
  }
  await expect(more).toHaveCount(0)
})

test('shows a loading status while the feed opens', async ({ page }) => {
  await mount(page, '?status=loading')
  await expect(page.getByRole('status', { name: 'Loading history' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Search this conversation' })).toBeDisabled()
})

test('a stale feed says so, hides the partial list and offers a reload', async ({ page }) => {
  await mount(page, '?status=stale')
  await expect(page.getByRole('status').filter({ hasText: 'History is out of date' })).toBeVisible()
  await expect(page.getByText('deploy the staging build')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Search this conversation' })).toBeDisabled()
  await page.getByRole('button', { name: 'Reload' }).click()
  await expect(page.getByTestId('jumps')).toHaveText('retry')
})

test('the Turns and Runs switch works from the keyboard', async ({ page }) => {
  await mount(page)
  const group = page.getByRole('group', { name: 'History view' })
  const turns = group.getByRole('button', { name: 'Turns' })
  const runs = group.getByRole('button', { name: 'Runs' })
  const turnsList = page.getByRole('list', { name: 'Prompts and replies, newest first' })
  const runHistory = page.getByRole('region', { name: 'Run history' })

  await expect(turns).toHaveAttribute('aria-pressed', 'true')
  await expect(turnsList).toBeVisible()

  // Turns -> Runs: Tab to the second control and activate it with Enter.
  await turns.focus()
  await page.keyboard.press('Tab')
  await expect(runs).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(runs).toHaveAttribute('aria-pressed', 'true')
  await expect(turns).toHaveAttribute('aria-pressed', 'false')
  await expect(runHistory).toBeVisible()
  await expect(turnsList).toHaveCount(0)

  // Runs -> Turns: Shift+Tab back and activate with Space.
  await page.keyboard.press('Shift+Tab')
  await expect(turns).toBeFocused()
  await page.keyboard.press('Space')
  await expect(turns).toHaveAttribute('aria-pressed', 'true')
  await expect(runs).toHaveAttribute('aria-pressed', 'false')
  await expect(turnsList).toBeVisible()
  await expect(runHistory).toHaveCount(0)
})

const allSessions = (page: Page) => page.getByRole('button', { name: 'All sessions' })
const search = (page: Page) => page.getByRole('textbox', { name: 'Search all sessions' })

// #716: searching every session, jumping to a result, and resuming a run.
test.describe('showing an event in the pane', () => {
  test('waits for the opened session’s feed instead of judging the old one', async ({ page }) => {
    await mount(page, '?focus=event-5')
    await expect(page.getByRole('status', { name: 'Loading history' })).toBeVisible()
    await expect(page.getByTestId('jumps')).toHaveText('')
    await expect(page.getByTestId('jumps')).toHaveText('focus:found')
    await expect(page.locator('[data-revealed]')).toContainText('write the release notes')
  })

  test('says so once the feed is ready and does not hold the event', async ({ page }) => {
    await mount(page, '?focus=event-gone')
    await expect(page.getByTestId('jumps')).toHaveText('focus:missing')
  })

  test('does not call an event missing until the host proves the replay finished', async ({
    page,
  }) => {
    await mount(page, '?focus=event-gone&unconfirmed=1')
    await expect(page.getByText('Not confirmed complete')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(page.getByTestId('jumps')).toHaveText('')
    // The proof arrives with no such event: only now is it reported missing.
    await expect(page.getByTestId('jumps')).toHaveText('focus:missing')
    await expect(page.getByText('Not confirmed complete')).toHaveCount(0)
  })

  test('shows an event that has already arrived without waiting for the proof', async ({
    page,
  }) => {
    await mount(page, '?focus=event-5&unconfirmed=1')
    await expect(page.getByTestId('jumps')).toHaveText('focus:found')
    await expect(page.locator('[data-revealed]')).toContainText('write the release notes')
  })
})

test.describe('all sessions', () => {
  test('the scope switch keeps the query and defaults to this session', async ({ page }) => {
    await mount(page, '?scopes=1')
    const group = page.getByRole('group', { name: 'Search scope' })
    await expect(group.getByRole('button', { name: 'This session' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.getByRole('textbox', { name: 'Search this conversation' }).fill('deploy')
    await expect(
      page.getByText(
        'Searching this session. Switch to All sessions to search the whole workspace.'
      )
    ).toBeVisible()
    await allSessions(page).click()
    await expect(search(page)).toHaveValue('deploy')
    await expect(allSessions(page)).toHaveAttribute('aria-pressed', 'true')
  })

  test('groups results by session with counts, a jump per row and the partial note', async ({
    page,
  }) => {
    await mount(page, '?scope=all&partial=1&bound=shell')
    await search(page).fill('terminal')
    await expect(page.getByRole('status').filter({ hasText: 'results in' })).toHaveText(
      '7 results in 3 sessions'
    )
    await expect(
      page.getByText(
        'Searched the most recent events of 3 sessions. Older history, and any session that has not finished loading, may not be included.'
      )
    ).toBeVisible()
    const shell = page.getByRole('list', { name: 'Matches in Shell switcher' })
    await expect(shell.getByRole('listitem')).toHaveCount(3)
    await expect(page.getByText('3 matches')).toBeVisible()
    // A session whose title matches contributes every row, its run included.
    await expect(page.getByText('2 matches')).toHaveCount(2)

    await shell.getByRole('button', { name: /^Go to Shell switcher, prompt:/ }).click()
    await expect(page.getByTestId('jumps')).toHaveText('shell-event-1')
    // The session open in the pane is marked; the others are reached by a row's Go to.
    await expect(page.getByText('Open session', { exact: true })).toHaveCount(1)
    const resize = page.getByRole('list', { name: 'Matches in Fix terminal resize on Windows' })
    await resize
      .getByRole('button', { name: /^Go to / })
      .first()
      .click()
    await expect(page.getByTestId('jumps')).toContainText('shell-event-1,')
  })

  test('an empty query lists the most recent prompts across sessions', async ({ page }) => {
    await mount(page, '?scope=all')
    await expect(page.getByText('Recent prompts across your sessions')).toBeVisible()
    await expect(page.getByText('1 recent').first()).toBeVisible()
    const rows = page.getByRole('list', { name: 'Matches in all sessions' }).getByText('Prompt')
    await expect(rows.first()).toBeVisible()
    await expect(page.getByText('Reply', { exact: true })).toHaveCount(0)
  })

  test('says when nothing matches, when loading and when the search failed', async ({ page }) => {
    await mount(page, '?scope=all')
    await search(page).fill('kubernetes')
    await expect(page.getByText('No matches in 3 sessions')).toBeVisible()
    await expect(
      page.getByText('Search covers prompts, replies, tool calls, approvals and statuses.')
    ).toBeVisible()

    await mount(page, '?scope=all&all=loading')
    await expect(page.getByRole('status', { name: 'Searching all sessions' })).toBeVisible()

    await mount(page, '?scope=all&all=unavailable')
    await expect(page.getByText('History search is unavailable')).toBeVisible()
    await expect(
      page.getByText('The sessions could not be searched from this runtime.')
    ).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByTestId('attempts')).toHaveText('1')
  })

  test('resume names why a run cannot be resumed, in the design’s words', async ({ page }) => {
    await mount(page, '?scope=all')
    await search(page).fill('terminal')
    await expect(page.getByText('This run was cancelled and cannot be resumed')).toBeVisible()
    await expect(page.getByText('This run is still active')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume Shell switcher' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Resume Fix terminal resize/ })).toHaveCount(0)
  })

  test('resume asks first in place, can be cancelled, and retries after a refusal', async ({
    page,
  }) => {
    await mount(page, '?scope=all&resumeFails=1')
    await search(page).fill('terminal')
    await page.getByRole('button', { name: 'Resume Shell switcher' }).click()
    const dialog = page.getByRole('group', { name: 'Resume “Shell switcher”?' })
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText(
        'Starts generation 7 of run 1 in this session. Nothing already recorded is changed.'
      )
    ).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('jumps')).toHaveText('')

    await page.getByRole('button', { name: 'Resume Shell switcher' }).click()
    await dialog.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(
      dialog.getByText('The run could not be resumed: the runtime did not accept the request.')
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Try again' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('jumps')).toHaveText('resume:run-shell')
  })

  test('pages 50 at a time and stops at 1,000 rows, saying what is left', async ({ page }) => {
    await mount(page, '?scope=all&cap=1')
    await search(page).fill('terminal')
    const rows = page.getByRole('list', { name: /^Matches in Bulk session/ }).getByRole('listitem')
    await expect(rows).toHaveCount(50)
    await expect(page.getByText('Showing 50 of 6,000 matches')).toBeVisible()
    const more = page.getByRole('button', { name: 'Load more' })
    for (let shown = 50; shown < 1_000; shown += 50) {
      await more.click()
      await expect(rows).toHaveCount(shown + 50)
    }
    await expect(page.getByText('Showing the first 1,000 of 6,000 matches')).toBeVisible()
    await expect(page.getByText('Narrow your search to see the rest.')).toBeVisible()
    await expect(more).toHaveCount(0)
  })

  test('Up and Down walk the results, Enter goes to one, Up from the first returns to search', async ({
    page,
  }) => {
    await mount(page, '?scope=all')
    await search(page).fill('terminal')
    await search(page).press('ArrowDown')
    const first = page.getByRole('button', { name: /^Go to / }).first()
    await expect(first).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('button', { name: /^Go to / }).nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(first).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('jumps')).not.toHaveText('')
    await first.focus()
    await page.keyboard.press('ArrowUp')
    await expect(search(page)).toBeFocused()
  })
})

// The real section owns the focus request, so these run through its own
// callback: the request is consumed after the reveal, never before it.
test.describe('Go to across sessions through the section', () => {
  test('scrolls to the event and highlights it until the reveal ends', async ({ page }) => {
    await mount(page, '', 'history-section-harness-app.tsx')
    await search(page).fill('needle')
    await page.getByRole('button', { name: /^Go to Long session,/ }).click()
    const revealed = page.locator('[data-revealed]')
    await expect(revealed).toContainText('find the needle in the haystack')
    // 41 prompts at 3 lines each cannot fit the pane: the row only shows if the
    // scheduled scroll ran.
    const pane = await page.locator('.h-96').boundingBox()
    const row = await revealed.boundingBox()
    expect(row!.y).toBeGreaterThanOrEqual(pane!.y)
    expect(row!.y + row!.height).toBeLessThanOrEqual(pane!.y + pane!.height)
    // The highlight ends on its own timer, which the consumed request must not cancel.
    await expect(revealed).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByText('That prompt is no longer in the retained history.')).toHaveCount(0)
  })
})
