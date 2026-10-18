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
  options: { theme?: 'light' | 'dark'; width?: number; height?: number; query?: string } = {}
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
  await page.goto(`/?view=chat&chatE2e=visual&chatState=${state}${options.query ?? ''}`)
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

const appendMany = (page: Page, count: number) =>
  page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('chat-visual:append', { detail })),
    {
      count,
    }
  )

// The fixture's letters-only word for an event sequence (digits read as secrets to redaction).
const word = (seq: number) =>
  `w${[...String(seq)].map((digit) => String.fromCodePoint(97 + Number(digit))).join('')}`

test.describe('identity across the retention window', () => {
  // The fixture feeds the real transcript accumulator, which keeps the newest
  // 1,000 events and drops the oldest for each new one past that.
  test('a reply keeps its nodes, selection, focus and fold when its prompt is evicted', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const errors = trackPageErrors(page)
    await openCanvas(page, 'retention-turn')
    const prompt = page.getByRole('article', { name: 'You' })
    await expect(prompt).toBeVisible()

    // The reader opens the reasoning, selects a sentence of it and leaves focus on its toggle.
    const toggle = reasoning(page).getByRole('button').first()
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Double-click the middle of a word, so the selection cannot reach past the text.
    const picked = await reasoning(page).evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf('cleanup') ?? -1
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at + 2)
        range.setEnd(node, at + 4)
        const box = range.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      return undefined
    })
    expect(picked).toBeDefined()
    await page.mouse.dblclick(picked!.x, picked!.y)
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(selected).toBe('cleanup')
    await toggle.focus()

    const reply = (await page.getByRole('article', { name: 'Assistant' }).elementHandle())!
    const line = (await reasoning(page).elementHandle())!
    const anchor = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('[data-anchor-id]')]
            .map((element) => element.getAttribute('data-anchor-id') ?? '')
            .find((id) => id.endsWith(':reply')) ?? null
      )
    const anchored = await anchor()
    const settled = async () => {
      expect(await reply.evaluate((element) => element.isConnected)).toBe(true)
      expect(await line.evaluate((element) => element.isConnected)).toBe(true)
      await expect(toggle).toBeFocused()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(selected)
      expect(await anchor()).toBe(anchored)
      await expect(reasoning(page)).toHaveCount(1)
    }

    // Fill the window to its limit: nothing has been evicted yet.
    await appendMany(page, 997)
    await expect(page.getByText('Finished step 1000.')).toBeAttached()
    await expect(prompt).toBeVisible()
    await settled()

    // One more event evicts the prompt, the oldest. The reply is now a turn with no prompt.
    await appendMany(page, 1)
    await expect(prompt).toHaveCount(0)
    await expect(page.getByText('Finished step 1001.')).toBeAttached()
    await settled()

    // And again (the next oldest, an activity line that is not the reasoning).
    await appendMany(page, 1)
    await expect(page.getByText('Finished step 1002.')).toBeAttached()
    await settled()
    expect(errors).toEqual([])
  })

  test('a reply longer than the window is not rebuilt as its leading deltas are evicted', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const errors = trackPageErrors(page)
    await openCanvas(page, 'retention-stream')
    const prompt = page.getByRole('article', { name: 'You' })
    await expect(prompt).toBeVisible()
    await appendMany(page, 998)
    const block = page.locator('[data-entry-id^="chat-visual-d"]')
    await expect(block).toHaveCount(1)
    await expect(block).toContainText(word(1000))
    const firstId = await block.getAttribute('data-entry-id')
    const reply = (await page.getByRole('article', { name: 'Assistant' }).elementHandle())!
    const blockHandle = (await block.elementHandle())!

    // Every further event evicts the oldest: the prompt, the reasoning, then one delta each time.
    const outcome = await page.evaluate(
      async ({ reply: replyNode, block: blockNode }) => {
        for (let step = 0; step < 80; step += 1) {
          window.dispatchEvent(new CustomEvent('chat-visual:append', { detail: { count: 1 } }))
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
          if (!replyNode.isConnected || !blockNode.isConnected) return { ok: false, step }
        }
        return { ok: true, step: 80 }
      },
      { reply, block: blockHandle }
    )
    expect(outcome).toEqual({ ok: true, step: 80 })
    await expect(prompt).toHaveCount(0)
    // It really was evicting: the block is now named after a later delta and has lost the first words.
    await expect(block).toHaveCount(1)
    expect(await block.getAttribute('data-entry-id')).not.toBe(firstId)
    await expect(block).not.toHaveText(new RegExp(`(^|\\s)${word(3)}(\\s|$)`))
    // Once its prefix is evicted, retain the block but withhold the unsafe suffix.
    await expect(block).not.toContainText(word(1080))
    await expect(block.getByText('Safe response context is unavailable')).toBeVisible()
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

  test('a request longer than the card description keeps its decisive tail inspectable', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'approval-long')
    const card = page.locator('[data-slot="confirmation"]')
    await expect(card).toHaveAttribute('data-state', 'requested')
    await expect(card).toContainText('Run cleanup plan')

    // The description is clipped; the full request is in a block of its own.
    const full = card.locator('[data-slot="code-block"]', { hasText: 'Full request' })
    await expect(full).toBeVisible()
    await expect(full).toContainText('FINAL STEP: drop table audit_log (irreversible)')

    // Deciding still records the exact event, from the same card.
    await card.getByRole('button', { name: 'Approve' }).click()
    expect(await resolution(page)).toMatchObject({
      eventId: 'chat-visual-2',
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

const call = (page: Page, id: string) => page.locator(`[data-entry-id="${id}"]`)

test.describe('tool and subagent calls', () => {
  test('calls the producer identified are drawn inside the call that parented them', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'calls')
    const agent = call(page, 'call-agent-start')
    await expect(agent).toHaveAttribute('data-kind', 'subagent.observed')
    await expect(agent).toHaveAttribute('data-call-phase', 'completed')
    await expect(agent).toContainText('reviewer')
    await expect(agent).toContainText('2 steps')
    // Only the three top-level calls are drawn until the subagent is opened.
    await expect(page.locator('[data-call-phase]')).toHaveCount(3)
    await agent.getByRole('button').first().click()
    await expect(page.locator('[data-call-phase]')).toHaveCount(5)
    await expect(agent.locator('[data-call-phase]')).toHaveCount(2)
    const read = agent.locator('[data-entry-id="call-read-start"]')
    await expect(read).toContainText('read_file')
    await expect(read).toContainText('<1s')
    await read.getByRole('button').first().click()
    await expect(read).toContainText('0055.sql')
    await expect(read).toContainText('"lines": 48')
    expect(errors).toEqual([])
  })

  test('a failed call says so, and content held by reference is not pretended to be shown', async ({
    page,
  }) => {
    await openCanvas(page, 'calls')
    const agent = call(page, 'call-agent-start')
    await agent.getByRole('button').first().click()
    const failed = agent.locator('[data-entry-id="call-test-failed"]')
    await expect(failed).toHaveAttribute('data-status', 'error')
    await expect(failed.locator('.sr-only').first()).toHaveText('Failed')
    await failed.getByRole('button').first().click()
    await expect(failed.locator('[data-call-note]')).toContainText(
      'Output is held by reference (4096 bytes) and is not shown here.'
    )
  })

  test('a call with no known parent stays a top-level line, and a last word of progress is not a success', async ({
    page,
  }) => {
    await openCanvas(page, 'calls')
    const orphan = call(page, 'call-orphan-done')
    await expect(orphan).toHaveAttribute('data-call-phase', 'completed')
    await expect(orphan.locator('xpath=ancestor::*[@data-call-phase]')).toHaveCount(0)
    const progress = call(page, 'call-lint-progress')
    await expect(progress).toHaveAttribute('data-call-phase', 'progress')
    await expect(progress).not.toHaveAttribute('data-status', 'success')
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`no serious accessibility violations with nested calls open (${theme})`, async ({
      page,
    }) => {
      await openCanvas(page, 'calls', { theme })
      const agent = call(page, 'call-agent-start')
      await agent.getByRole('button').first().click()
      await agent.locator('[data-entry-id="call-read-start"]').getByRole('button').first().click()
      await page.addScriptTag({ content: axe.source })
      const violations = await page.evaluate(async () => {
        const runner = (
          window as unknown as {
            axe: {
              run: (c: Element) => Promise<{
                violations: Array<{ id: string; impact: string | null }>
              }>
            }
          }
        ).axe
        const result = await runner.run(document.querySelector('[data-dev-chat]') as Element)
        return result.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => violation.id)
      })
      expect(violations).toEqual([])
    })
  }
})

const older = (page: Page) => page.getByText('First question: what changed?')
const attempts = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { chatHistoryAttempts?: number }).chatHistoryAttempts ?? 0
  )

test.describe('earlier messages', () => {
  test('an earlier turn loads once, above the one on screen', async ({ page }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'history')
    await expect(page.getByText('Second question: any risks?')).toBeVisible()
    // The reader is at the top of a short thread, so the scroller asks for it; a click
    // would ask for the same page, never a second one.
    const load = page.getByRole('button', { name: 'Load earlier messages' })
    if (await load.isVisible()) await load.click()
    await expect(older(page)).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0)
    expect(await attempts(page)).toBe(1)
    const order = await page
      .locator('[data-dev-chat] [role="article"], [data-dev-chat] article')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''))
    const first = order.findIndex((text) => text.includes('First question'))
    const second = order.findIndex((text) => text.includes('Second question'))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(second)
    expect(errors).toEqual([])
  })

  test('a failed load says so, keeps the control and does not retry on its own', async ({
    page,
  }) => {
    await openCanvas(page, 'history-offline')
    await expect(page.getByText('Earlier messages could not be loaded')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Load earlier messages' })).toBeVisible()
    await expect(older(page)).toHaveCount(0)
    const settled = await attempts(page)
    await page.waitForTimeout(1500)
    expect(await attempts(page)).toBe(settled)
    expect(settled).toBeLessThanOrEqual(2)
  })

  test('after a failure the reader can ask again and the turn lands', async ({ page }) => {
    await openCanvas(page, 'history-retry')
    await expect(page.getByText('Second question: any risks?')).toBeVisible()
    await expect
      .poll(async () => (await older(page).count()) > 0 || (await attempts(page)) >= 1)
      .toBe(true)
    // If the first (failing) request has not already been retried, ask again.
    const load = page.getByRole('button', { name: 'Load earlier messages' })
    if ((await older(page).count()) === 0) await load.click()
    await expect(older(page)).toHaveCount(1)
    await expect(page.getByText('Earlier messages could not be loaded')).toHaveCount(0)
  })
})

const transcript = (page: Page) => page.locator('[data-dev-chat]')

test.describe('a reply that starts behind the window', () => {
  const REPLY = 'The build failed in two places.'

  test('none of it is drawn until its start is restored, then it is one block', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'history-split')
    // The window holds only the last delta of the reply; showing it would show a fragment
    // whose start (and any secret it began) is out of view.
    await expect(transcript(page)).not.toContainText('two places.')
    // The scroller asks for older messages by itself, one page at a time; wait for both.
    await expect.poll(() => attempts(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    const load = page.getByRole('button', { name: 'Load earlier messages' })
    for (let step = 0; step < 4; step += 1) {
      if (await transcript(page).getByText(REPLY).count()) break
      await load.click({ timeout: 1_000 }).catch(() => undefined)
      await page.waitForTimeout(250)
    }
    await expect(transcript(page).getByText(REPLY)).toHaveCount(1)
    await expect(transcript(page).getByText('What failed in the build?')).toBeVisible()
    // The pieces were never drawn on their own.
    await expect(transcript(page).getByText('failed in', { exact: true })).toHaveCount(0)
    expect(await attempts(page)).toBe(2)
    expect(errors).toEqual([])
  })
})

const lastEvent = (page: Page) =>
  page.getByRole('region', { name: 'Evidence from the retained transcript' }).locator('dd').first()

test.describe('handoff evidence follows the displayed thread', () => {
  test('a streamed event updates the last event', async ({ page }) => {
    await openCanvas(page, 'streaming', { query: '&chatHandoff=1' })
    const before = (await lastEvent(page).textContent()) ?? ''
    await page.evaluate(() => window.dispatchEvent(new Event('chat-visual:append')))
    await expect(page.getByText('A later stream update arrived.')).toBeVisible()
    await expect(lastEvent(page)).not.toHaveText(before)
    await expect(lastEvent(page)).toContainText('turn.assistant_delta')
  })

  test('loaded history changes the window completeness the strip reports', async ({ page }) => {
    await openCanvas(page, 'history', { query: '&chatHandoff=1' })
    await expect(page.getByText(/counts are lower bounds/)).toBeVisible()
    const load = page.getByRole('button', { name: 'Load earlier messages' })
    await expect(older(page).or(load)).toBeVisible()
    // The scroller may already have asked; a click then has nothing to press.
    await load.click({ timeout: 2_000 }).catch(() => undefined)
    await expect(older(page)).toHaveCount(1)
    await expect(page.getByText(/counts are lower bounds/)).toHaveCount(0)
  })

  test('history that never loads keeps the counts labelled as lower bounds', async ({ page }) => {
    await openCanvas(page, 'history-offline', { query: '&chatHandoff=1' })
    await expect(page.getByText(/counts are lower bounds/)).toBeVisible()
  })
})

test.describe('structured results', () => {
  test('terminal output, a test run with its stack, files, a plan and a task are drawn as such', async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    await openCanvas(page, 'results')
    const terminal = call(page, 'res-term-start')
    await expect(terminal).toHaveAttribute('data-result', 'terminal')
    await expect(terminal).toContainText('bun test packages/db')
    await expect(terminal).toHaveAttribute('data-status', 'error')
    await terminal.getByRole('button').first().click()
    await expect(terminal).toContainText('Exited with code 1')
    await expect(terminal).toContainText('(fail) keeps applied history across a rebase')

    // Counts are the producer's: three passed were reported, one test is listed.
    const tests = call(page, 'res-tests')
    await expect(tests).toHaveAttribute('data-status', 'error')
    await tests.getByRole('button').first().click()
    await expect(tests).toContainText('3 passed (1 listed)')
    await expect(tests).toContainText('expected journal entry 0054 to be unchanged')
    await expect(tests).toContainText('packages/db/src/journal.ts:41:9')

    const files = call(page, 'res-files')
    await expect(files).toContainText('2 files · +12 −3')
    await files.getByRole('button').first().click()
    await expect(files).toContainText('renamed from packages/db/src/check.ts')

    // A plan is the thing being followed, so it opens by itself.
    const plan = call(page, 'res-plan')
    await expect(plan).toContainText('Fix the journal check')
    await expect(plan).toContainText('1 of 3 steps done')
    await expect(plan).toContainText('Keep applied entries unchanged')
    await expect(call(page, 'res-task')).toContainText('Follow up on the rollout order')
    expect(errors).toEqual([])
  })

  test('a checkpoint is only a marker, and the reported context is a trigger that opens its figures', async ({
    page,
  }) => {
    await openCanvas(page, 'results')
    const checkpoint = page.locator('[data-slot="checkpoint"]')
    await expect(checkpoint).toContainText('Before the journal fix')
    await expect(checkpoint).toContainText('2026-09-22 10:00 UTC')
    // No restore operation reaches the canvas, so nothing offers one.
    await expect(checkpoint.getByRole('button')).toHaveCount(0)

    const trigger = page.locator('[data-slot="context"]')
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.getByRole('dialog')).toContainText('84,000')
    await expect(page.getByRole('dialog')).toContainText('200,000')
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  })

  test.describe('adapters keep what the producer said', () => {
    test('a subagent keeps its input, its references and the redaction of a private path', async ({
      page,
    }) => {
      const errors = trackPageErrors(page)
      await openCanvas(page, 'results-edge')
      const agent = call(page, 'edge-agent-in')
      await agent.getByRole('button').first().click()
      const input = agent.locator('[data-call-input]')
      await input.getByRole('button').first().click()
      await expect(input).toContainText('summarize')
      await expect(input).toContainText('[private path]')
      await expect(input).not.toContainText('someone')
      // An output held by reference is said to be, not dropped.
      await expect(agent).toContainText('Output is held by reference (8192 bytes)')

      const held = call(page, 'edge-agent-ref')
      await held.getByRole('button').first().click()
      await held.locator('[data-call-input]').getByRole('button').first().click()
      await expect(held).toContainText('Input is held by reference (2048 bytes)')
      expect(errors).toEqual([])
    })

    test('a suite keeps its reported status and nothing claims work is under way once stopped', async ({
      page,
    }) => {
      await openCanvas(page, 'results-edge')
      const tests = call(page, 'edge-tests')
      await tests.getByRole('button').first().click()
      const suites = tests.locator('[data-suite-status]')
      await expect(suites).toContainText('auth suite: failed')
      await expect(suites).toContainText('ui suite: not finished')
      await expect(tests.locator('[data-status="running"]')).toHaveCount(0)
    })

    test('a failed plan with an incomplete list does not imply completion', async ({ page }) => {
      await openCanvas(page, 'results-edge')
      const plan = call(page, 'edge-plan')
      await expect(plan).toContainText('Roll out the fix')
      await expect(plan).toContainText('failed · 1 listed')
      await expect(plan).toContainText('The producer marked this plan incomplete')
      await expect(plan).toContainText('The producer counts 4 steps')
      await expect(plan).toContainText('Write the migration')
      await expect(plan).not.toContainText('done')
    })

    test('changed files with no totals claim neither a total nor zero lines', async ({ page }) => {
      await openCanvas(page, 'results-edge')
      const files = call(page, 'edge-files')
      await expect(files).toContainText('1 listed')
      await expect(files).not.toContainText('+0')
      await expect(files).not.toContainText('1 file ')
      await files.getByRole('button').first().click()
      await expect(files).toContainText('did not say whether this list is complete')
    })

    test("context is the named model's, and its cost keeps the exact decimal text", async ({
      page,
    }) => {
      await openCanvas(page, 'results-edge')
      await expect(page.locator('[data-usage-model]')).toHaveAttribute(
        'data-usage-model',
        'fixture-model'
      )
      await expect(page.locator('[data-usage-cost]')).toHaveText('Cost 0.000000123456789 USD')
      await page.locator('[data-slot="context"]').click()
      await expect(page.getByRole('dialog')).toContainText('30,000')
      await expect(page.getByRole('dialog')).not.toContainText('1,000,000')
    })
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`no serious accessibility violations with every result open (${theme})`, async ({
      page,
    }) => {
      await openCanvas(page, 'results', { theme })
      for (const id of ['res-term-start', 'res-tests', 'res-files'])
        await call(page, id).getByRole('button').first().click()
      await page.addScriptTag({ content: axe.source })
      const violations = await page.evaluate(async () => {
        const runner = (
          window as unknown as {
            axe: {
              run: (c: Element) => Promise<{
                violations: Array<{ id: string; impact: string | null }>
              }>
            }
          }
        ).axe
        const result = await runner.run(document.querySelector('[data-dev-chat]') as Element)
        return result.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => violation.id)
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
