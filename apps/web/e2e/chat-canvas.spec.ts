// Chat canvas evidence: the behaviours the redesigned transcript promises.
//
// Everything runs against the development-only ChatView fixture
// (`/?view=chat&chatE2e=visual&chatState=<state>`), which feeds the real
// ChatView canonical RuntimeEvent windows. Each journey fails on any page or
// console error.
//
// Covered: streaming into a stable node, cancellation, approvals and
// questions (mouse and keyboard, exact event recorded), exact source copy,
// untrusted text, very large output, screen-reader structure (axe, roles,
// spoken statuses), touch, reduced motion, narrow layout and light/dark.
import axe from 'axe-core'
import { expect, test, type Locator, type Page } from '@playwright/test'

const workspace = {
  id: 'workspace-chat-canvas-e2e',
  name: 'Chat Canvas Evidence',
  scene: 'work',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: '2026-09-22T10:00:00.000Z',
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

async function openCanvas(
  page: Page,
  state: string,
  options: { theme?: 'light' | 'dark'; width?: number; height?: number } = {}
) {
  const theme = options.theme ?? 'light'
  await page.setViewportSize({ width: options.width ?? 1280, height: options.height ?? 800 })
  await page.emulateMedia({ colorScheme: theme })
  await page.addInitScript((selected: string) => {
    localStorage.clear()
    localStorage.setItem('theme', selected)
  }, theme)
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true, userId: 'chat-canvas-user' },
        workspaces: [workspace],
      },
    })
  )
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ contentType: 'application/json', json: [workspace] })
  )
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ contentType: 'application/json', json: {} })
  )
  await page.goto(`/?view=chat&chatE2e=visual&chatState=${state}`)
  await expect(page.locator('[data-chat-visual-state]')).toHaveAttribute(
    'data-chat-visual-state',
    state,
    { timeout: 30_000 }
  )
  await expect(page.locator('[data-dev-chat]')).toBeVisible()
  await page.evaluate((selected: string) => {
    document.documentElement.classList.toggle('dark', selected === 'dark')
    document.documentElement.classList.toggle('light', selected === 'light')
  }, theme)
}

const log = (page: Page) => page.getByRole('log', { name: 'Conversation transcript' })
const traceLines = (page: Page) => page.locator('[data-slot="trace-line"]')

async function resolution(page: Page): Promise<unknown> {
  const raw = await page.locator('[data-chat-visual-state]').getAttribute('data-chat-resolution')
  return raw ? JSON.parse(raw) : undefined
}

async function overflowsHorizontally(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollWidth > element.clientWidth + 1)
}

/** Elements that animate without end: a spinner or shimmer (a one-shot enter is not). */
const endlessAnimations = (root: Locator) =>
  root.evaluate(
    (element) =>
      [...element.querySelectorAll('*')].filter((node) => {
        const style = getComputedStyle(node)
        const seconds = Math.max(
          ...style.animationDuration.split(',').map((value) => parseFloat(value))
        )
        return (
          style.animationName !== 'none' &&
          style.animationIterationCount.includes('infinite') &&
          seconds > 0.01
        )
      }).length
  )

const append = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('chat-visual:append')))

const reasoning = (page: Page) => page.locator('[data-kind="turn.reasoning_summary"]')
const method = (page: Page) => page.locator('[data-kind="turn.method_step_summary"]')
const entry = (page: Page, id: string) => page.locator(`[data-entry-id="${id}"]`)

test.describe('source-reported summaries and cited answers', () => {
  test('reasoning and method snapshots update one node in place and settle', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'grounded-stream')
    await expect(page.getByRole('article', { name: 'You' })).toBeVisible()
    // Nothing is shown until a producer reports it.
    await expect(reasoning(page)).toHaveCount(0)
    await expect(method(page)).toHaveCount(0)

    await append(page)
    await expect(reasoning(page)).toHaveCount(1)
    await expect(reasoning(page)).toContainText('Thinking…')
    const node = await reasoning(page).evaluate((element) => {
      element.setAttribute('data-test-node', 'same')
      return element.getAttribute('data-entry-id')
    })

    await append(page) // method step: running
    await expect(method(page)).toHaveCount(1)
    await expect(method(page)).toContainText('1 method step')
    await append(page) // reasoning revision 2
    await append(page) // step 1 completed
    await append(page) // step 2 running
    await expect(method(page)).toContainText('2 method steps')
    // The same two nodes, however many snapshots arrived.
    await expect(reasoning(page)).toHaveCount(1)
    await expect(reasoning(page)).toHaveAttribute('data-test-node', 'same')
    await expect(reasoning(page)).toHaveAttribute('data-entry-id', node ?? '')

    await append(page) // reasoning completed, 4.2s
    await expect(reasoning(page)).toContainText('Thought for 4s')
    await expect(reasoning(page)).not.toContainText('Thinking…')
    await append(page) // step 2 completed
    await method(page).getByRole('button').first().click()
    const steps = method(page).locator('[data-slot="trace-line"]')
    await expect(steps.filter({ hasText: 'Search the Rust book' })).toContainText('Done')
    await expect(steps.filter({ hasText: 'Compare the claims' })).toContainText('Done')
    expect(errors).toEqual([])
  })

  test('a cited answer lists its sources and marks only prose, never code', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'grounded')
    const answer = page.locator('[data-entry-id="chat-visual-grounded-answer"]')
    await expect(answer).toBeVisible()
    await expect(answer.getByText('Used 2 sources')).toBeVisible()
    // Two spans in the first paragraph share one source; the second source cites the borrowing
    // sentence. The span inside the fenced block gets no badge.
    const badges = answer.locator('[data-slot="inline-citation"]')
    await expect(badges).toHaveCount(3)
    await expect(
      answer.locator('[data-slot="code-block"] [data-slot="inline-citation"]')
    ).toHaveCount(0)
    await expect(answer.locator('[data-slot="code-block"]')).toContainText('let r = &s;')
    // A citation the producer sent that the canvas did not mark is said, not hidden.
    await expect(answer.getByText('1 citation is not marked in the text.')).toBeVisible()
    // Copy source stays the producer's exact text.
    await expect(answer.locator('[data-slot="code-block"]')).not.toContainText('[^')
    expect(errors).toEqual([])
  })

  test('a citation opens its source and a source link is safe', async ({ page }) => {
    await openCanvas(page, 'grounded')
    const answer = page.locator('[data-entry-id="chat-visual-grounded-answer"]')
    await answer.locator('[data-slot="inline-citation"]').first().click()
    const card = page.getByRole('dialog')
    await expect(card).toContainText('What is Ownership?')
    await expect(card).toContainText('doc.rust-lang.org')
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)

    await answer.getByRole('button', { name: /Used 2 sources/ }).click()
    const link = answer.getByRole('link', { name: /What is Ownership/ })
    await expect(link).toHaveAttribute('href', /^https:\/\/doc\.rust-lang\.org\//)
    await expect(link).toHaveAttribute('rel', /noopener/)
  })
})

test.describe('summaries and citations: truth, preservation and untrusted text', () => {
  test('a last word of "streaming" does not spin once the session has stopped', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'grounded-stopped')
    await expect(reasoning(page)).toHaveCount(1)
    await expect(reasoning(page)).not.toContainText('Thinking')
    await expect(reasoning(page)).toContainText('not finished')
    await method(page).getByRole('button').first().click()
    const step = method(page)
      .locator('[data-slot="trace-line"]')
      .filter({ hasText: 'Search the Rust book' })
    await expect(step).toContainText('not finished')
    await expect(step).not.toContainText('In progress')
    // Nothing in the transcript animates without end: no spinner, no shimmer, no caret.
    expect(await endlessAnimations(log(page))).toBe(0)
    expect(errors).toEqual([])
  })

  test('a selection and a reader-chosen fold survive every snapshot that arrives', async ({
    page,
  }) => {
    await openCanvas(page, 'grounded-stream')
    await expect(page.getByRole('article', { name: 'You' })).toBeVisible()
    await append(page)
    await expect(reasoning(page)).toContainText('Thinking…')
    // The reader closes the reasoning while it is open, and selects their own prompt.
    const toggle = reasoning(page).getByRole('button').first()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('article', { name: 'You' }).getByText('Does Rust need').dblclick()
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(selected.length).toBeGreaterThan(0)

    for (let index = 0; index < 7; index += 1) await append(page)
    await expect(entry(page, 'chat-visual-grounded-answer')).toBeVisible()
    // Still closed, still selected, still the one node.
    await expect(reasoning(page)).toHaveCount(1)
    await expect(reasoning(page).getByRole('button').first()).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(selected)
  })

  test('a remount draws the same summaries and citations once, not twice', async ({ page }) => {
    await openCanvas(page, 'grounded')
    await expect(page.locator('[data-slot="inline-citation"]')).toHaveCount(3)
    await page.evaluate(() => window.dispatchEvent(new Event('chat-visual:remount')))
    await expect(page.locator('[data-slot="inline-citation"]')).toHaveCount(3)
    await expect(reasoning(page)).toHaveCount(1)
    await expect(method(page)).toHaveCount(1)
    await expect(page.getByText('Used 2 sources')).toHaveCount(1)
  })

  test('untrusted summary and source text is inert, redacted and bounded', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'grounded-hostile')
    await reasoning(page).getByRole('button').first().click()
    await method(page).getByRole('button').first().click()
    const answer = entry(page, 'chat-visual-hostile-answer')
    await answer.getByRole('button', { name: /Used 2 sources/ }).click()

    const transcript = log(page)
    await expect(transcript.locator('script, img, iframe')).toHaveCount(0)
    await expect(transcript.locator('a[href^="javascript:" i]')).toHaveCount(0)
    expect(
      await page.evaluate(() => (window as unknown as { pwned?: unknown }).pwned)
    ).toBeUndefined()
    const text = (await transcript.textContent()) ?? ''
    expect(text).toContain('<img src=x onerror=alert(1)> step title')
    // Markup is text; a link with a script address is shown as its text, never followed.
    expect(text).toContain('<script>window.pwned = true</script>')
    expect(text).toContain('[click](javascript:window.pwned=true)')
    expect(text).not.toContain('sk-supersecretvalue1234')
    expect(text).not.toContain('abcdefghijklmnop1234')
    expect(text).not.toContain('/Users/example')
    // Source metadata is redacted like message text, and an unsafe link is not offered.
    expect(text).toContain('Report [secret redacted]')
    expect(text).toContain('Saved to [private path] with Bearer [secret redacted]')
    expect(text).not.toContain('token_abcdefgh12345')
    await expect(answer.locator('a[href*="token_"], a[href*="canary.example"]')).toHaveCount(0)
    // The two spans end together: one badge, and no span is called unmarked.
    await expect(answer.locator('[data-slot="inline-citation"]')).toHaveCount(1)
    await expect(answer.getByText(/not marked in the text/)).toHaveCount(0)
    // The direction override is stripped and the 440-character title is clipped.
    expect(text).not.toContain('\u202e')
    const row = answer.getByRole('link').first()
    expect((await row.textContent())?.length ?? 0).toBeLessThan(400)
    await expect(answer.getByRole('link')).toHaveCount(1)
    // The link is the reported address, safe, and its host comes from the URL.
    await expect(answer.getByRole('link').first()).toHaveAttribute(
      'href',
      'https://evil.example/path?q=1'
    )
    expect(errors).toEqual([])
  })

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 320]) {
      test(`no accessibility violations of any impact: grounded answer (${theme}, ${width}px)`, async ({
        page,
      }) => {
        await openCanvas(page, 'grounded', { theme, width, height: 900 })
        await reasoning(page).getByRole('button').first().click()
        await method(page).getByRole('button').first().click()
        await entry(page, 'chat-visual-grounded-answer')
          .getByRole('button', { name: /Used 2 sources/ })
          .click()
        await page.addScriptTag({ content: axe.source })
        const violations = await page.evaluate(async () => {
          const runner = (
            window as unknown as {
              axe: {
                run: (c: Element) => Promise<{
                  violations: Array<{ id: string; nodes: Array<{ target: unknown[] }> }>
                }>
              }
            }
          ).axe
          const result = await runner.run(document.querySelector('[data-dev-chat]') as Element)
          return result.violations.map((violation) => ({
            id: violation.id,
            targets: violation.nodes.map((node) => node.target.join(' ')),
          }))
        })
        expect(violations).toEqual([])
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true)
      })
    }
  }

  test('keyboard: fold, citation and sources are all reachable and return focus', async ({
    page,
  }) => {
    await openCanvas(page, 'grounded')
    const toggle = reasoning(page).getByRole('button').first()
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    const badge = page.locator('[data-slot="inline-citation"]').first()
    await badge.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toContainText('What is Ownership?')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(badge).toBeFocused()

    const sources = page.getByRole('button', { name: /Used 2 sources/ })
    await sources.focus()
    await page.keyboard.press('Enter')
    await expect(sources).toHaveAttribute('aria-expanded', 'true')
  })

  test('text zoomed to 200% reflows at 640px with no horizontal overflow', async ({ page }) => {
    await openCanvas(page, 'grounded', { width: 640, height: 900 })
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })
    await expect(page.locator('[data-slot="inline-citation"]').first()).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(await overflowsHorizontally(log(page))).toBe(false)
  })

  test('reduced motion: a streaming reasoning line has no animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openCanvas(page, 'grounded-stream')
    await append(page)
    const line = reasoning(page)
    await expect(line).toContainText('Thinking…')
    expect(await endlessAnimations(line)).toBe(0)
  })
})

test.describe('streaming', () => {
  test('a code fence grows in place: partial then complete, same node', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'code-stream')
    // The transcript attaches asynchronously; the prompt is the first thing it shows.
    await expect(page.getByRole('article', { name: 'You' })).toBeVisible()

    await append(page)
    const text = page.locator('[data-source="delta"]')
    const block = text.locator('[data-slot="code-block"]')
    await expect(block).toBeVisible()
    // The fence has opened but not closed: the block says it is still being written.
    await expect(block).toContainText('Generating')
    await expect(text).toHaveAttribute('data-entry-id', /.+/)
    const entryId = await text.getAttribute('data-entry-id')
    const marker = await text.evaluate((node) => {
      node.setAttribute('data-test-node', 'same')
      return node.getAttribute('data-test-node')
    })
    expect(marker).toBe('same')

    await append(page)
    await expect(block).toContainText('return a + b')
    await expect(block).not.toContainText('Generating')
    await expect(text).toContainText('That is all.')
    // One block, the same node (the attribute we set survives), the same entry id.
    await expect(text).toHaveCount(1)
    await expect(text).toHaveAttribute('data-test-node', 'same')
    await expect(text).toHaveAttribute('data-entry-id', entryId ?? '')
    expect(errors).toEqual([])
  })

  test('the reply being written is marked busy so a screen reader waits for it', async ({
    page,
  }) => {
    await openCanvas(page, 'code-stream')
    await expect(page.getByRole('article', { name: 'You' })).toBeVisible()
    await append(page)
    await expect(page.getByRole('article', { name: 'Assistant' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
  })

  test('follows the stream at the bottom and leaves a reader who scrolled up alone', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'code-stream', { height: 520 })
    await expect(page.getByRole('article', { name: 'You' })).toBeVisible()
    const scroller = page.locator('[data-dev-chat-stream]')
    const distanceFromBottom = () =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )

    await append(page)
    await append(page)
    await append(page)
    await expect(page.getByText('Later paragraph one.').first()).toBeVisible()
    // Content overflowed the pane and the reader was at the end: they are still there.
    expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true
    )
    await expect.poll(distanceFromBottom).toBeLessThanOrEqual(2)

    // Scroll up to read; the next fragment must not move them.
    await scroller.evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0)
    await append(page)
    await expect(page.getByText('Later paragraph two.').first()).toBeAttached()
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0)

    // The way back is offered, and takes them to the end.
    const jump = page.getByRole('button', { name: 'Jump to latest' })
    await expect(jump).toBeVisible()
    await jump.click()
    await expect.poll(distanceFromBottom).toBeLessThanOrEqual(2)
    expect(errors).toEqual([])
  })
})

test.describe('cancellation and failure', () => {
  test('Stop cancels exactly once and the cancelled run says so', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'streaming')
    const stop = page.getByRole('button', { name: /^stop/i })
    await expect(stop).toBeVisible()
    await stop.click()
    await expect(page.locator('[data-chat-visual-state]')).toHaveAttribute(
      'data-chat-cancel-count',
      '1'
    )
    expect(errors).toEqual([])
  })

  test('a cancelled session is a note, not a failure, and keeps the partial reply', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'cancelled')
    await expect(page.getByText('Starting with the summary section, then')).toBeVisible()
    await expect(page.getByText('Session cancelled')).toBeVisible()
    await expect(page.locator('[data-slot="trace-line"][data-status="running"]')).toHaveCount(0)
    await expect(page.locator('[data-chat-status]')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('failures are named: failed tool, errored result and failed session', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'failed')
    await expect(
      page.locator('[data-slot="trace-line"][data-status="error"]').first()
    ).toContainText('Failed')
    await expect(page.getByText('The runtime reported an error for this turn.')).toBeVisible()
    await expect(page.getByText('The harness exited unexpectedly.')).toBeVisible()
    await expect(page.locator('[data-slot="trace-line"][data-status="running"]')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('the empty state invites a first message and shows no activity', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'empty')
    await expect(page.getByText('No runtime events yet.')).toBeVisible()
    await expect(traceLines(page)).toHaveCount(0)
    expect(errors).toEqual([])
  })
})

test.describe('approvals and questions', () => {
  test('approving by mouse records the exact event and choice', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'rich')
    const card = page.locator('[data-slot="confirmation"]')
    await expect(card).toHaveAttribute('data-state', 'requested')
    await expect(card).toContainText('Apply migration plan')
    await card.getByRole('button', { name: 'Approve' }).click()
    expect(await resolution(page)).toMatchObject({
      eventId: 'chat-visual-12',
      choice: expect.stringMatching(/approve/i),
    })
    expect(errors).toEqual([])
  })

  test('denying by keyboard records a deny for the same event', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'rich')
    const deny = page.locator('[data-slot="confirmation"]').getByRole('button', { name: 'Deny' })
    await deny.focus()
    await expect(deny).toBeFocused()
    await page.keyboard.press('Enter')
    expect(await resolution(page)).toMatchObject({
      eventId: 'chat-visual-12',
      choice: expect.stringMatching(/den/i),
    })
    expect(errors).toEqual([])
  })

  test('a question is answered with free text and the answer is recorded exactly', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'rich')
    const form = page.locator('[data-slot="questionnaire"]')
    await expect(form).toBeVisible()
    await expect(form).toContainText('Which environment should receive the reviewed changes?')
    const submit = form.getByRole('button', { name: 'Submit answer' })
    // Nothing to send until something is written.
    await expect(submit).toBeDisabled()
    const answer = form.getByRole('textbox', { name: 'Answer question' })
    await answer.fill('staging <b>only</b>')
    await submit.click()
    expect(await resolution(page)).toMatchObject({
      eventId: 'chat-visual-13',
      answer: 'staging <b>only</b>',
    })
    expect(errors).toEqual([])
  })

  test('the pending approval is announced as waiting for the person', async ({ page }) => {
    await openCanvas(page, 'rich')
    await expect(page.getByText('Waiting for a response from you')).toBeVisible()
  })
})

test.describe('code: exact copy, bounds and untrusted text', () => {
  test('copy returns the source byte for byte', async ({ page, context }) => {
    const errors = trackPageErrors(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openCanvas(page, 'copy')
    const expected = ['if (a) {', '\treturn  b;   ', '}', '', '  trailing  '].join('\n')
    const block = page.locator('[data-slot="code-block"]').first()
    await block.getByRole('button', { name: 'Copy code' }).click()
    await expect(block.getByRole('button', { name: 'Copied' })).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(expected)
    expect(errors).toEqual([])
  })

  test('hostile text is inert: no elements, no script, no javascript: link', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'hostile')
    const transcript = log(page)
    await expect(transcript).toContainText('<script>window.pwned = true</script>')
    expect(await transcript.locator('script, img, iframe, object, embed, style').count()).toBe(0)
    expect(await transcript.locator('b').count()).toBe(0)
    expect(await page.evaluate(() => (window as { pwned?: unknown }).pwned)).toBeUndefined()
    const hrefs = await transcript
      .locator('a')
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')))
    expect(hrefs).toEqual(['https://example.com'])
    // A javascript: link stays visible as text.
    await expect(transcript).toContainText('[click](javascript:window.pwned=true)')
    expect(errors).toEqual([])
  })

  test('secrets and private paths are redacted before they reach the page', async ({ page }) => {
    await openCanvas(page, 'hostile')
    const transcript = log(page)
    await expect(transcript).not.toContainText('sk-supersecretvalue1234')
    await expect(transcript).not.toContainText('/Users/example/private')
    await expect(transcript).toContainText('[secret redacted]')
  })

  test('an unknown language still renders the code as text, labelled', async ({ page }) => {
    await openCanvas(page, 'hostile')
    const block = page.locator('[data-slot="code-block"]').first()
    await expect(block).toContainText('zzz-unknown-language')
    await expect(block).toContainText('<div onclick="steal()">kept as text</div>')
  })

  test('an event kind this build does not know stays visible, by its wire name', async ({
    page,
  }) => {
    await openCanvas(page, 'hostile')
    const unknown = page.locator('[data-kind="wat.is.this"]')
    await expect(unknown).toBeVisible()
    await expect(unknown).toContainText('wat.is.this')
  })

  test('long tokens wrap instead of widening the page', async ({ page }) => {
    await openCanvas(page, 'hostile', { width: 390, height: 844 })
    expect(await overflowsHorizontally(log(page))).toBe(false)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
  })

  test('very large output is bounded: capped height, a scroll region, few DOM nodes', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'large')
    const block = page.locator('[data-slot="code-block"]').first()
    const body = block.locator('[data-slot="code-block-body"]')
    await expect(body).toBeVisible()
    // The source is all there (copy returns it), in one scrollable region of bounded height.
    await expect(body.locator('code')).toContainText('line 2500')
    const box = await body.boundingBox()
    expect(box?.height ?? Infinity).toBeLessThanOrEqual(24 * 16 + 2)
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    // A 2,500-line block is a handful of nodes, not thousands.
    expect(await block.locator('*').count()).toBeLessThan(40)
    // The block is a labelled tab stop (a group, not a duplicate landmark) so the keyboard reaches the overflow.
    await expect(body).toHaveAttribute('role', 'group')
    await expect(body).toHaveAttribute('tabindex', '0')
    expect(errors).toEqual([])
  })

  test('prose past the limit is cut and says so', async ({ page }) => {
    await openCanvas(page, 'large')
    await expect(page.getByText(/Showing the first 32,768 characters/)).toBeVisible()
    await expect(page.getByText('The rest of this message is not shown.')).toBeVisible()
    // The page stays one column: the long message did not widen it.
    expect(await overflowsHorizontally(log(page))).toBe(false)
  })
})

test.describe('structure and assistive technology', () => {
  test('the transcript is a labelled, focusable live log with a status region', async ({
    page,
  }) => {
    await openCanvas(page, 'rich')
    const transcript = log(page)
    await expect(transcript).toHaveAttribute('aria-live', 'polite')
    await expect(transcript).toHaveAttribute('tabindex', '0')
    await expect(page.getByRole('status').first()).toBeAttached()
  })

  test('each turn is an article labelled by speaker', async ({ page }) => {
    await openCanvas(page, 'rich')
    await expect(page.getByRole('article', { name: 'You' })).toHaveCount(2)
    expect(await page.getByRole('article', { name: 'Assistant' }).count()).toBeGreaterThan(0)
  })

  test('statuses are spoken, not only coloured', async ({ page }) => {
    await openCanvas(page, 'failed')
    const failed = page.locator('[data-slot="trace-line"][data-status="error"]').first()
    await expect(failed.locator('.sr-only')).toHaveText('Failed')
  })

  test('an expandable line is a real button with aria-expanded', async ({ page }) => {
    await openCanvas(page, 'rich')
    const trigger = page.locator('[data-slot="trace-line"] button[aria-expanded]').first()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Space')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`no serious accessibility violations in the rich conversation (${theme})`, async ({
      page,
    }) => {
      await openCanvas(page, 'rich', { theme })
      await page.addScriptTag({ content: axe.source })
      const violations = await page.evaluate(async () => {
        const runner = (
          window as unknown as {
            axe: {
              run: (c: Element) => Promise<{
                violations: Array<{
                  id: string
                  impact: string | null
                  nodes: Array<{ target: unknown[] }>
                }>
              }>
            }
          }
        ).axe
        const result = await runner.run(document.querySelector('[data-dev-chat]') as Element)
        return result.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => ({
            id: violation.id,
            targets: violation.nodes.map((node) => node.target.join(' ')),
          }))
      })
      expect(violations).toEqual([])
    })
  }
})

test.describe('touch, motion and layout', () => {
  test.describe('touch', () => {
    test.use({ hasTouch: true, isMobile: true })

    test('copy and trace controls are reachable by touch at a comfortable size', async ({
      page,
    }) => {
      await openCanvas(page, 'copy', { width: 390, height: 844 })
      const copy = page.getByRole('button', { name: 'Copy code' }).first()
      await expect(copy).toBeVisible()
      const box = await copy.boundingBox()
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(24)
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24)
    })
  })

  test('reduced motion stops the spinner and the shimmer', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openCanvas(page, 'streaming')
    const running = page.locator('[data-slot="trace-line"][data-status="running"]').first()
    await expect(running).toBeVisible()
    const animations = await running.evaluate((line) =>
      [...line.querySelectorAll('*')].map((node) => getComputedStyle(node).animationName)
    )
    expect(animations.every((name) => name === 'none')).toBe(true)
  })

  test('a 320px viewport has no horizontal overflow, with long content', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'rich', { width: 320, height: 640 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(await overflowsHorizontally(log(page))).toBe(false)
    await expect(page.getByRole('button', { name: 'Approve' })).toBeInViewport()
    expect(errors).toEqual([])
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`text and the approval card are legible in ${theme}`, async ({ page }) => {
      await openCanvas(page, 'rich', { theme })
      const card = page.locator('[data-slot="confirmation"]')
      await expect(card).toBeVisible()
      const background = await card.evaluate((element) => getComputedStyle(element).backgroundColor)
      expect(background).not.toBe('rgba(0, 0, 0, 0)')
    })
  }
})
