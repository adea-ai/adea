// M13 #536: Chat surface evidence against the served app.
//
// The M13 chat slices (composer, transcript, streaming, approvals, reconnect,
// Dev↔Chat switching) are driven through the development-only ChatView fixture
// (`/?view=chat&chatE2e=visual`, `import.meta.env.DEV`-gated in
// workspace-navigation.tsx) and, for the view-switch proof, the existing Dev
// View `devE2e=preserved` fixtures. Everything asserted here is user-visible
// state in the real window: the model-level counterparts of these guarantees
// live in packages/dev-view/tests/chat-conversation-model.test.ts (notably the
// "Dev↔Chat repeated switching" proof) and chat-surface.test.ts.
//
// Every journey fails on any page error or console error: the chat surface
// must render and stream without a single one.
import { expect, test, type Page } from '@playwright/test'

const workspace = {
  id: 'workspace-chat-e2e',
  name: 'Chat Evidence',
  scene: 'work',
  updatedAt: '2026-09-22T10:00:00.000Z',
}

const bootstrapReply = {
  activeWorkspace: workspace,
  principal: { temporary: true, userId: 'chat-e2e-user' },
  workspaces: [workspace],
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

async function mockBootstrap(page: Page) {
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({ contentType: 'application/json', json: bootstrapReply })
  )
  // The fixture surface needs no workspace data; blanket-mock the workspace
  // API namespace (as the workspace visual/flow gates do) so no unauthenticated
  // request reaches the real backend and logs a console error.
  await page.route('**/api/v1/workspaces/**', (route) =>
    route.fulfill({ contentType: 'application/json', json: {} })
  )
}

async function openChatFixture(page: Page, state: string) {
  await mockBootstrap(page)
  await page.goto(`/?view=chat&chatE2e=visual&chatState=${state}`)
  const fixture = page.locator('[data-chat-visual-state]')
  await expect(fixture).toHaveAttribute('data-chat-visual-state', state, { timeout: 30_000 })
  await expect(page.locator('section.dev-chat')).toBeVisible()
}

test('renders the canonical conversation surface: transcript rows, live status, and a working composer', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openChatFixture(page, 'conversation')

  // The header names the canonical runtime session and its generation, and
  // the transcript stream is announced as a live region.
  const chat = page.locator('section.dev-chat')
  await expect(chat).toBeVisible()
  await expect(page.locator('.dev-chat__heading h2')).toHaveText('Deployment plan review')
  await expect(page.locator('.dev-chat__heading p')).toContainText('generation 3')
  await expect(page.locator('.dev-chat__status')).toContainText('Live')
  await expect(page.getByLabel('Conversation transcript')).toHaveAttribute('aria-live', 'polite')

  // Tiered transcript rows: the user turn, two tool events, and the assistant
  // message — each rendered from bounded, known payload fields only.
  const rows = page.locator('article.dev-chat__row')
  await expect(rows).toHaveCount(5)
  await expect(page.locator('article.dev-chat__row--user')).toHaveCount(1)
  await expect(page.locator('article.dev-chat__row--tool')).toHaveCount(2)
  await expect(page.locator('article.dev-chat__row--assistant')).toHaveCount(2)
  await expect(rows.first()).toContainText('Review the deployment plan and summarize the risks.')
  await expect(page.getByText('Found 4 relevant notes.')).toBeVisible()
  // The streamed delta and the completed message share the sentence, so the
  // assertion scopes to the first rendering.
  await expect(
    page.getByText('The plan is ready. I found two risks worth addressing before approval.').first()
  ).toBeVisible()

  // The composer is authoritative for an active, connected chat conversation:
  // sending clears the draft, and the busy surface offers Stop and Steer.
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await expect(composer).toBeEnabled()
  await expect(page.locator('#dev-chat-composer-status')).toContainText(
    'Input is sent with the current runtime generation.'
  )
  await composer.fill('Watch the staging rollout while I review.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(composer).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeEnabled()

  expect(errors).toEqual([])
})

test('keeps earlier transcript rows mounted while a streamed event appends', async ({ page }) => {
  const errors = trackPageErrors(page)
  await openChatFixture(page, 'streaming')

  const rows = page.locator('article.dev-chat__row')
  await expect(rows).toHaveCount(5)
  const firstRow = await rows.first().elementHandle()
  expect(firstRow).not.toBeNull()

  // The live transcript stream appends exactly when the spec dispatches the
  // fixture's `chat-visual:append` event — no wall-clock race. The row that
  // was already on screen must remain the same mounted node (the "#588
  // preserve live transcript rows during streaming" regression).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(rows).toHaveCount(6, { timeout: 10_000 })
  await expect(page.getByText('A later stream update arrived.')).toBeVisible()
  const stayedMounted = await firstRow?.evaluate(
    (node) => node.isConnected && node === document.querySelector('article.dev-chat__row')
  )
  expect(stayedMounted).toBe(true)

  // Repeated delivery keeps appending without disturbing earlier rows.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('chat-visual:append')))
  await expect(rows).toHaveCount(7, { timeout: 10_000 })
  await expect(page.getByText('Streaming continues to append rows.')).toBeVisible()
  await expect(rows.first()).toContainText('Review the deployment plan')

  expect(errors).toEqual([])
})

test('gates the composer and renders approval and question resolution while attention is pending', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openChatFixture(page, 'attention')

  // Input authority is held by the pending approval: the composer states the
  // exact reason and refuses input instead of accepting a doomed send.
  const composer = page.getByRole('textbox', { name: 'Message runtime' })
  await expect(composer).toBeDisabled()
  await expect(page.locator('#dev-chat-composer-status')).toContainText(
    'Waiting for approval before sending input.'
  )

  // The approval row offers a real resolution path and renders its bounded
  // payload text; the question row requires a non-empty answer before its
  // submit control enables.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
  await expect(
    page.getByText('The runtime is waiting for approval to apply the reviewed changes.')
  ).toBeVisible()
  const questionInput = page.getByLabel('Answer question')
  const submitAnswer = page.getByRole('button', { name: 'Submit answer' })
  await expect(submitAnswer).toBeDisabled()
  await questionInput.fill('Staging first, then production.')
  await expect(submitAnswer).toBeEnabled()
  await submitAnswer.click()

  // Resolving must not throw and must not silently unmount the pending rows.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()

  expect(errors).toEqual([])
})

test('surfaces a transcript sequence gap and offers the reconnect recovery affordance', async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await openChatFixture(page, 'reconnect')

  await expect(page.getByRole('alert').filter({ hasText: 'Transcript gap detected' })).toBeVisible()
  const reconnect = page.getByRole('button', { name: 'Reconnect transcript' })
  await expect(reconnect).toBeEnabled()
  await expect(page.locator('.dev-chat__status')).toContainText('Disconnected')
  await expect(page.locator('#dev-chat-composer-status')).toContainText(
    'Chat is unavailable while the runtime is disconnected.'
  )

  // Reconnecting re-attaches the transcript stream; the gap is still reported
  // truthfully because the fixture stream cannot recover the missing range.
  await reconnect.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Transcript gap detected' })).toBeVisible()
  await expect(page.locator('.dev-chat__status')).toContainText('Disconnected')

  expect(errors).toEqual([])
})

test('repeated Dev↔Chat switches preserve the session state in the real window', async ({
  page,
}) => {
  test.slow()
  const errors = trackPageErrors(page)
  // The Dev surface carries the preserved E2E fixtures; `chatE2e=visual`
  // routes the Chat side of the switch to the M13 ChatView fixture, so the
  // journey crosses the exact boundary the model-layer proof exercises
  // (chat-conversation-model.test.ts, "Dev↔Chat repeated switching").
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved&chatE2e=visual&sentinel=keep')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })

  // The fixture terminal's attached scrollback proves the Dev surface mounted
  // with its authenticated transport before any switching begins.
  await expect(page.getByLabel('Terminal output')).toContainText(
    /fixture terminal (re)?connected/,
    { timeout: 30_000 }
  )

  // Make session-scoped state: select the second project's session (which
  // mirrors into devProject/devSession URL params), then collapse the Product
  // group.
  const otherSession = page.getByRole('button', { name: 'Other project session' })
  await otherSession.click()
  await expect(otherSession).toHaveAttribute('aria-current', 'page')
  await expect(page).toHaveURL(/devProject=fixture-tools/)
  await expect(page).toHaveURL(/devSession=fixture-tools-session/)
  const group = page.getByRole('button', { name: 'PRODUCT' })
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')

  // Three switch cycles: the chat surface mounts and unmounts between Dev
  // visits, and every Dev-side session fact survives — the selection (store
  // and its URL mirror) and the collapsed hierarchy. Nothing relaunches or
  // resets; unknown params ride every patch.
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await page.getByRole('button', { name: 'Chat view' }).click()
    await expect(page).toHaveURL(/view=chat/)
    await expect(page).toHaveURL(/sentinel=keep/)
    await expect(page).toHaveURL(/devE2e=preserved/)
    await expect(page.locator('section.dev-chat')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-chat-visual-state="conversation"]')).toBeVisible()
    await expect(page.locator('.dev-chat__heading h2')).toHaveText('Deployment plan review')

    await page.getByRole('button', { name: 'Dev view' }).click()
    await expect(page).toHaveURL(/view=dev/)
    await expect(page).toHaveURL(/sentinel=keep/)
    await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
      timeout: 60_000,
    })
    await expect(page).toHaveURL(/devProject=fixture-tools/)
    await expect(page).toHaveURL(/devSession=fixture-tools-session/)
    const collapsedGroup = page.getByRole('button', { name: 'PRODUCT' })
    await expect(collapsedGroup).toHaveAttribute('aria-expanded', 'false')
    // Expanding the surviving collapse state reveals the surviving selection.
    await collapsedGroup.click()
    await expect(page.getByRole('button', { name: 'Other project session' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    // Re-collapse for the next cycle so every cycle starts from the same
    // state and proves the fact was re-preserved, not left mounted.
    await page.getByRole('button', { name: 'PRODUCT' }).click()
    await expect(page.getByRole('button', { name: 'PRODUCT' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  }

  expect(errors).toEqual([])
})
