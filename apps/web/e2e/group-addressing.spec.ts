import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

// The group conversation over an in-page stand-in for the addressed-turn routes: what the browser shows
// for qualified Agents, addressing mode, committed order, cancellation, a lost response and a reconnect.
// The same ledger and queue are proven against the real routes and database in
// apps/web/test/integration/addressed-turn-client-convergence.test.ts.

async function open(page: Page) {
  const path = '/__group-addressing'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/group-addressing-harness-app.tsx')
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + entry}'` })
  await expect(page.getByRole('heading', { name: 'Launch review' })).toBeVisible()
}

const picker = (page: Page) =>
  page.getByRole('group', { name: 'Agents your next message addresses' })
const aria = (page: Page) => picker(page).getByRole('button', { name: 'Aria · Acme' })
const guest = (page: Page) =>
  picker(page).getByRole('button', { name: 'Agent 55555555 · Another workspace' })
const addressed = (page: Page) => page.getByRole('list', { name: 'Addressed Agents' })

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox')
  await box.fill(text)
  await box.press('Enter')
  await expect(box).toHaveValue('')
}

test('the group header names every participant with its workspace, the audience and the addressing mode', async ({
  page,
}) => {
  await open(page)
  const roster = page.getByRole('navigation', { name: 'People in this conversation' })
  await expect(roster.getByRole('listitem', { name: 'Aria · Acme' })).toBeVisible()
  await expect(roster.getByRole('listitem', { name: /^Agent 55555555/ })).toContainText(
    'Another workspace'
  )
  await expect(roster).toContainText('Audience: Participants only')
  await expect(roster).toContainText('Next message: No Agent addressed')
  await aria(page).click()
  await expect(roster).toContainText('Next message: Addressing Aria · Acme')
  await guest(page).click()
  await expect(roster).toContainText('Next message: Addressing 2 Agents')
  await aria(page).click()
  await guest(page).click()
  await expect(roster).toContainText('Next message: No Agent addressed')
})

test('a message with no recipient chosen addresses no one', async ({ page }) => {
  await open(page)
  await send(page, 'Just thinking out loud')
  await expect(page.getByText('Just thinking out loud')).toBeVisible()
  await expect(addressed(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.addressingHarness.calls.address)).toBe(0)
})

test('two recipients are addressed by identity in committed order, and the non-lead one stays visibly unstarted', async ({
  page,
}) => {
  await open(page)
  await aria(page).click()
  await guest(page).click()
  await send(page, 'Can you both review this?')
  const rows = addressed(page).getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('1 of 2')
  await expect(rows.nth(0)).toContainText('Aria · Acme')
  await expect(rows.nth(0)).toContainText('Dispatched')
  await expect(rows.nth(1)).toContainText('2 of 2')
  await expect(rows.nth(1)).toContainText('Agent 55555555 · Globex')
  await expect(rows.nth(1)).toContainText('Not started')
  await expect(rows.nth(1)).toContainText('Nothing has started')
  await expect(rows.nth(1)).toContainText('only the group’s lead runs turns today')
  // The recipients travelled as identities on the message, not as typed names.
  expect(await page.evaluate(() => window.addressingHarness.calls.mentions)).toEqual([
    ['44444444-0000-4000-8000-0000000000d4', '55555555-0000-4000-8000-0000000000e5'],
  ])
  // The home workspace learned from the retained turn now qualifies the header too.
  await expect(
    page
      .getByRole('navigation', { name: 'People in this conversation' })
      .getByRole('listitem', { name: 'Agent 55555555 · Globex' })
  ).toBeVisible()
})

test('a lost response shows Not delivered, and Retry converges on the one turn the server holds', async ({
  page,
}) => {
  await open(page)
  await aria(page).click()
  await page.evaluate(() => window.addressingHarness.dropNextAddressResponse())
  await send(page, 'Please answer')
  await expect(addressed(page)).toContainText('Not delivered')
  await expect(addressed(page)).toContainText('Retrying never starts a second turn')
  expect(await page.evaluate(() => window.addressingHarness.turns().length)).toBe(1)
  await addressed(page).getByRole('button', { name: 'Retry' }).click()
  await expect(addressed(page)).toContainText('Dispatched')
  await expect(addressed(page)).not.toContainText('Not delivered')
  expect(await page.evaluate(() => window.addressingHarness.turns().length)).toBe(1)
  expect(await page.evaluate(() => window.addressingHarness.calls.address)).toBe(2)
})

test('coming back online retries what was not delivered without another click', async ({
  page,
}) => {
  await open(page)
  await aria(page).click()
  await page.evaluate(() => window.addressingHarness.dropNextAddressResponse())
  await send(page, 'Please answer')
  await expect(addressed(page)).toContainText('Not delivered')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(addressed(page)).toContainText('Dispatched')
  expect(await page.evaluate(() => window.addressingHarness.turns().length)).toBe(1)
})

test('cancelling a live turn is confirmed by the server and cannot be repeated', async ({
  page,
}) => {
  await open(page)
  await aria(page).click()
  await send(page, 'Please answer')
  await expect(addressed(page)).toContainText('Dispatched')
  await page.getByRole('button', { name: 'Cancel turn for Aria · Acme' }).click()
  await expect(addressed(page)).toContainText('Cancelled')
  await expect(addressed(page)).toContainText('Cancellation was requested from the runtime.')
  await expect(page.getByRole('button', { name: /Cancel turn for/ })).toHaveCount(0)
  expect(await page.evaluate(() => window.addressingHarness.calls.cancel)).toBe(1)
})

test('a reconnect shows the answer, and a newer message shows superseded', async ({ page }) => {
  await open(page)
  await aria(page).click()
  await send(page, 'First question')
  await expect(addressed(page)).toContainText('Dispatched')
  const turnId = await page.evaluate(() => window.addressingHarness.turns()[0]!.id)
  await page.evaluate((id) => window.addressingHarness.answer(id), turnId)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(addressed(page)).toContainText('Answered')
  // The chosen recipients stay chosen, and the header says so, so a follow-up addresses the same Agent.
  await send(page, 'Second question')
  const lists = addressed(page)
  await expect(lists).toHaveCount(2)
  await aria(page).click()
  await send(page, 'Thinking out loud')
  await expect(lists).toHaveCount(2)
  await page.evaluate(() => window.addressingHarness.humanMessage('A newer message from someone'))
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(lists.last()).toContainText('Superseded')
  await expect(lists.last()).toContainText('A newer message arrived')
})

test('a failed refresh keeps the turns and Cancel with a notice, and an empty read withdraws them', async ({
  page,
}) => {
  await open(page)
  await aria(page).click()
  await send(page, 'Please answer')
  await expect(addressed(page)).toContainText('Dispatched')
  await page.evaluate(() => window.addressingHarness.failReplay(true))
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByText('Addressed turns could not be refreshed')).toBeVisible()
  await expect(addressed(page)).toContainText('Dispatched')
  await expect(page.getByRole('button', { name: 'Cancel turn for Aria · Acme' })).toBeVisible()
  // The server answers again, but lists nothing: the turns it withdrew do not linger.
  await page.evaluate(() => window.addressingHarness.failReplay(false))
  await page.evaluate(() => window.addressingHarness.hideTurns(true))
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('Addressed turns could not be refreshed')).toHaveCount(0)
  await expect(addressed(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Cancel turn for/ })).toHaveCount(0)
})

test('a lost message response retried with the same recipients converges on one message and one turn', async ({
  page,
}) => {
  await open(page)
  await aria(page).click()
  await page.evaluate(() => window.addressingHarness.dropNextMessageResponse())
  const box = page.getByRole('textbox')
  await box.fill('Please answer')
  await box.press('Enter')
  await expect(page.getByText('Message not sent')).toBeVisible()
  await box.press('Enter')
  await expect(box).toHaveValue('')
  await expect(addressed(page)).toContainText('Dispatched')
  expect(await page.evaluate(() => window.addressingHarness.calls.messages)).toBe(1)
  expect(await page.evaluate(() => window.addressingHarness.turns().length)).toBe(1)
})

test('changing recipients after a lost message response sends the new choice, not a conflicting retry', async ({
  page,
}) => {
  await open(page)
  await aria(page).click()
  await page.evaluate(() => window.addressingHarness.dropNextMessageResponse())
  const box = page.getByRole('textbox')
  await box.fill('Please answer')
  await box.press('Enter')
  await expect(page.getByText('Message not sent')).toBeVisible()
  await guest(page).click()
  await box.press('Enter')
  await expect(box).toHaveValue('')
  await expect(page.getByText('Message not sent')).toHaveCount(0)
  const sent = await page.evaluate(() => window.addressingHarness.calls.mentions)
  expect(sent.at(-1)).toEqual([
    '44444444-0000-4000-8000-0000000000d4',
    '55555555-0000-4000-8000-0000000000e5',
  ])
  const rows = addressed(page).last().getByRole('listitem')
  await expect(rows).toHaveCount(2)
})
