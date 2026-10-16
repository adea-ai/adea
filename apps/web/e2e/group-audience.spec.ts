import { expect, test, type Locator, type Page } from '@playwright/test'
import axe from 'axe-core'
import { resolve } from 'node:path'

// The group audience dialogs over an in-page stand-in for the server and for the grant issuer that does not
// exist yet. Every identity is synthetic. What the browser shows for the real roster, same-named Agents,
// keyboard and focus, narrow layouts, stale versions, revoked access, workspace and account switches,
// duplicate submission and failed creation is proven here; the server rules themselves are proven against
// the real routes and database in apps/web/test/integration/group-channel-routes.test.ts.

const ids = {
  alexAdmin: '44444444-0000-4000-8000-0000000000d2',
  alexMember: '44444444-0000-4000-8000-0000000000d1',
  ariaAcme: '5a1c0e11-0000-4000-8000-0000000000e1',
  ariaGlobex: '9f20b7c4-0000-4000-8000-0000000000e2',
  existingGroup: '33333333-0000-4000-8000-0000000000c3',
  globex: '22222222-0000-4000-8000-0000000000b2',
  sam: '44444444-0000-4000-8000-0000000000d3',
}
const EARLIER_SECRET = 'Q3 acquisition target is Initech'

async function open(page: Page) {
  const path = '/__group-audience'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html lang="en"><head><title>Group audience</title></head><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  const entry = resolve(process.cwd(), 'apps/web/e2e/helpers/group-audience-harness-app.tsx')
  await page.addScriptTag({ type: 'module', content: `import '${'/@fs' + entry}'` })
  await expect(page.getByRole('button', { name: 'Open new group' })).toBeVisible()
}

// The shared checkbox paints its own control over a visually hidden input, so a person clicks the row.
const toggle = async (box: Locator) => {
  const labelId = await box.getAttribute('aria-labelledby')
  await box.page().locator(`[id="${labelId}"]`).click()
}
const dialog = (page: Page) => page.getByRole('dialog')
const harness = <T>(page: Page, run: () => T) => page.evaluate(run)
const people = (page: Page) => dialog(page).locator('[data-audience-people]')
const agents = (page: Page) => dialog(page).locator('[data-audience-agents]')
const roster = (page: Page, label: string) => dialog(page).getByRole('list', { name: label })

async function openCreate(page: Page) {
  await open(page)
  await page.getByRole('button', { name: 'Open new group' }).click()
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByRole('textbox', { name: 'Conversation name' }).fill('Launch review 2')
}

test('the new-group dialog shows the creator and the tenant’s real people and Agents, not an assumed roster', async ({
  page,
}) => {
  await openCreate(page)
  await expect(roster(page, 'Group audience').getByRole('listitem')).toHaveCount(1)
  await expect(roster(page, 'Group audience')).toContainText('You')
  await expect(roster(page, 'Group audience')).toContainText('Creator')
  // The person creating is never offered as someone to add.
  await expect(people(page).getByRole('checkbox')).toHaveCount(3)
  await expect(people(page).getByRole('checkbox', { name: 'Morgan' })).toHaveCount(0)
  await expect(agents(page).getByRole('checkbox')).toHaveCount(3)
  await expect(dialog(page)).toContainText('You start the group as its creator')
  await expect(dialog(page)).toContainText(
    'Everyone added sees the conversation from the moment they join'
  )
  await expect(dialog(page)).toContainText('never shared by joining')
})

test('same-named Agents and people are told apart by identity in the accessible names', async ({
  page,
}) => {
  await openCreate(page)
  const aria = agents(page).getByRole('checkbox')
  const names = await aria.evaluateAll((boxes) =>
    boxes.map(
      (box) => document.getElementById(box.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''
    )
  )
  expect(new Set(names).size).toBe(3)
  await expect(agents(page).getByRole('checkbox', { name: /^Aria · Globex$/ })).toBeVisible()
  await expect(
    agents(page).getByRole('checkbox', { name: /^Aria · Acme · Agent 5a1c0e11$/ })
  ).toBeVisible()
  await expect(
    agents(page).getByRole('checkbox', { name: /^Aria · Acme · Agent c3d4e5f6$/ })
  ).toBeVisible()
  await expect(people(page).getByRole('checkbox', { name: /^Alex · Member$/ })).toBeVisible()
  await expect(people(page).getByRole('checkbox', { name: /^Alex · Admin$/ })).toBeVisible()
  await expect(agents(page)).toContainText('told apart by their workspace and their short id')
})

test('a grant is asked for by qualified identity and the group is shown only from the server’s answer', async ({
  page,
}) => {
  await openCreate(page)
  await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
  await toggle(people(page).getByRole('checkbox', { name: /Alex · Admin/ }))
  await expect(roster(page, 'Group audience').getByRole('listitem')).toHaveCount(3)
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toBeFocused()
  const issued = await harness(page, () => window.audienceHarness.calls.issued)
  expect(issued).toHaveLength(1)
  expect(issued[0]!.humans).toEqual([ids.alexAdmin])
  // The Globex Aria, not the Acme one that shares her name.
  expect(issued[0]!.agents).toEqual([{ agentId: ids.ariaGlobex, workspaceId: ids.globex }])
  const groups = await harness(page, () => window.audienceHarness.groups())
  expect(groups).toHaveLength(1)
  expect(groups[0]!.participants).toHaveLength(3)
  const confirmed = roster(page, 'Who is in the group')
  await expect(confirmed.getByRole('listitem')).toHaveCount(3)
  await expect(confirmed).toContainText('Aria · Globex')
  await expect(confirmed).toContainText('Alex · Admin')
  await dialog(page).getByRole('button', { name: 'Open conversation' }).click()
  await expect(
    page.getByRole('status', { name: 'Opened conversation' }).or(page.locator('output'))
  ).toHaveText(groups[0]!.channelId)
})

test('the whole create flow works by keyboard and focus lands where the next step is', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('button', { name: 'Open new group' }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
  await page.keyboard.type('Keyboard group')
  const alexMember = people(page).getByRole('checkbox', { name: /Alex · Member/ })
  await alexMember.focus()
  await page.keyboard.press('Space')
  await expect(alexMember).toBeChecked()
  await page.keyboard.press('Enter')
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator(':focus')).toHaveText('Close')
})

test('a double submit makes one request and the busy state is announced', async ({ page }) => {
  await openCreate(page)
  await harness(page, () => window.audienceHarness.nextCreate('hold'))
  const submit = dialog(page).getByRole('button', { name: 'Create conversation' })
  await submit.click()
  await expect(dialog(page).getByRole('button', { name: 'Creating…' })).toBeDisabled()
  await dialog(page)
    .getByRole('textbox', { name: 'Conversation name' })
    .press('Enter')
    .catch(() => {})
  await expect(dialog(page).locator('form')).toHaveAttribute('aria-busy', 'true')
  await harness(page, () => window.audienceHarness.releaseCreate())
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toBeVisible()
  const { created } = await harness(page, () => window.audienceHarness.calls)
  expect(created).toHaveLength(1)
  expect(await harness(page, () => window.audienceHarness.groups())).toHaveLength(1)
})

test('a lost response keeps the draft, shows no group, and the retry cannot make a second one', async ({
  page,
}) => {
  await openCreate(page)
  await toggle(people(page).getByRole('checkbox', { name: /Sam/ }))
  await harness(page, () => window.audienceHarness.nextCreate('lost'))
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  const alert = dialog(page).getByRole('alert')
  await expect(alert).toContainText('not known whether this was saved')
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toHaveCount(0)
  // The title and the selection survive.
  await expect(dialog(page).getByRole('textbox', { name: 'Conversation name' })).toHaveValue(
    'Launch review 2'
  )
  await expect(people(page).getByRole('checkbox', { name: /Sam/ })).toBeChecked()
  await dialog(page).getByRole('button', { name: 'Try again' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toBeVisible()
  const { created, issued } = await harness(page, () => window.audienceHarness.calls)
  // The identical request, with the grants it was already issued: one group, one issuance.
  expect(created).toHaveLength(2)
  expect(created[1]).toEqual(created[0])
  expect(issued).toHaveLength(1)
  expect(await harness(page, () => window.audienceHarness.groups())).toHaveLength(1)
})

test('a participant the server refuses is marked, nothing is created, and the selections are kept', async ({
  page,
}) => {
  await openCreate(page)
  await toggle(people(page).getByRole('checkbox', { name: /Alex · Admin/ }))
  await toggle(people(page).getByRole('checkbox', { name: /Sam/ }))
  await harness(page, () => window.audienceHarness.nextCreate('rejected'))
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  await expect(dialog(page).locator('[data-group-failure="rejected"]')).toContainText(
    'no group was created'
  )
  await expect(roster(page, 'Group audience').locator('[data-roster-problem]')).toContainText(
    'The grant for this participant was withdrawn.'
  )
  await expect(people(page).getByRole('checkbox', { name: /Alex · Admin/ })).toBeChecked()
  await expect(people(page).getByRole('checkbox', { name: /Sam/ })).toBeChecked()
  expect(await harness(page, () => window.audienceHarness.groups())).toHaveLength(0)
  // Changing the selection is a new request with a new identity and fresh grants.
  await toggle(people(page).getByRole('checkbox', { name: /Alex · Admin/ }))
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toBeVisible()
  const { created, issued } = await harness(page, () => window.audienceHarness.calls)
  expect(created[1]!.channelId).not.toBe(created[0]!.channelId)
  expect(issued).toHaveLength(2)
})

test('an issuer that fails, or answers for the wrong group or Agent, sends nothing to the server', async ({
  page,
}) => {
  for (const mode of ['fail', 'wrong-group', 'wrong-agent-workspace'] as const) {
    await openCreate(page)
    await page.evaluate((value) => window.audienceHarness.setIssuer(value), mode)
    await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
    await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
    await expect(dialog(page).locator('[data-group-failure="issuer"]')).toContainText(
      'nothing was sent'
    )
    await expect(agents(page).getByRole('checkbox', { name: 'Aria · Globex' })).toBeChecked()
    expect((await harness(page, () => window.audienceHarness.calls)).created).toHaveLength(0)
    await page.reload()
  }
})

test('revoked access ends the attempt with the uniform answer and shows no group', async ({
  page,
}) => {
  await openCreate(page)
  await harness(page, () => window.audienceHarness.nextCreate('unavailable'))
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  const failure = dialog(page).locator('[data-group-failure="unavailable"]')
  await expect(failure).toContainText('not available to you anymore')
  await expect(failure).toContainText('Nothing was changed')
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toHaveCount(0)
  await expect(dialog(page).getByRole('textbox', { name: 'Conversation name' })).toHaveValue(
    'Launch review 2'
  )
})

test('an answer that arrives after switching workspace is not shown, and the draft does not carry over', async ({
  page,
}) => {
  await openCreate(page)
  await toggle(people(page).getByRole('checkbox', { name: /Sam/ }))
  await harness(page, () => window.audienceHarness.nextCreate('hold'))
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  await expect(dialog(page).getByRole('button', { name: 'Creating…' })).toBeVisible()
  await harness(page, () =>
    window.audienceHarness.switchWorkspace('22222222-0000-4000-8000-0000000000b2')
  )
  await harness(page, () => window.audienceHarness.releaseCreate())
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toHaveCount(0)
  await expect(dialog(page).locator('[data-group-failure]')).toHaveCount(0)
  await expect(people(page).getByRole('checkbox', { name: /Sam/ })).not.toBeChecked()
})

test('switching account resets the selections', async ({ page }) => {
  await openCreate(page)
  await toggle(people(page).getByRole('checkbox', { name: /Sam/ }))
  await harness(page, () =>
    window.audienceHarness.switchAccount('44444444-0000-4000-8000-0000000000d1')
  )
  await expect(people(page).getByRole('checkbox', { name: /Sam/ })).not.toBeChecked()
  await expect(roster(page, 'Group audience').getByRole('listitem')).toHaveCount(1)
})

test('a member who leaves the workspace is dropped from the selection and the person is told', async ({
  page,
}) => {
  await openCreate(page)
  await toggle(people(page).getByRole('checkbox', { name: /Sam/ }))
  await toggle(people(page).getByRole('checkbox', { name: /Alex · Member/ }))
  await harness(page, () =>
    window.audienceHarness.dropMember('44444444-0000-4000-8000-0000000000d3')
  )
  await expect(dialog(page).locator('[data-group-notice]')).toContainText('Sam')
  await expect(people(page).getByRole('checkbox', { name: /Sam/ })).toHaveCount(0)
  await expect(people(page).getByRole('checkbox', { name: /Alex · Member/ })).toBeChecked()
})

test('without a trusted grant source the group starts with only its creator, and says so', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('button', { name: 'Remove issuer' }).click()
  await page.getByRole('button', { name: 'Open new group' }).click()
  await dialog(page).getByRole('textbox', { name: 'Conversation name' }).fill('Solo')
  await expect(dialog(page).locator('[data-group-issuer-missing]')).toContainText(
    'none can be requested from here yet'
  )
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(0)
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toBeVisible()
  await expect(roster(page, 'Who is in the group').getByRole('listitem')).toHaveCount(1)
})

async function openManage(page: Page) {
  await open(page)
  await page.getByRole('button', { name: 'Open manage' }).click()
  await expect(dialog(page)).toBeVisible()
}

test('the manage dialog shows the roster the server holds, with the history and removal consequences', async ({
  page,
}) => {
  await openManage(page)
  const participants = roster(page, 'Participants')
  await expect(participants.getByRole('listitem')).toHaveCount(3)
  await expect(participants).toContainText('You')
  await expect(participants).toContainText('Alex · Member')
  await expect(participants).toContainText('Aria · Acme')
  await expect(dialog(page)).toContainText('from the moment they join')
  await expect(dialog(page)).toContainText(
    'Jobs already started keep running under their own owner'
  )
  await expect(dialog(page)).toContainText('Records already kept are not erased')
  // Nothing from before anyone joined is anywhere in the dialog.
  expect(await dialog(page).innerText()).not.toContain(EARLIER_SECRET)
  expect(await page.locator('body').innerText()).toContain(EARLIER_SECRET)
  expect(JSON.stringify(await harness(page, () => window.audienceHarness.calls))).not.toContain(
    EARLIER_SECRET
  )
})

test('adding and removing saves against the version seen, with grants for everyone who stays', async ({
  page,
}) => {
  await openManage(page)
  await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
  await roster(page, 'Participants').getByRole('button', { name: 'Remove Alex · Member' }).click()
  await expect(dialog(page).locator('[data-group-draft-summary]')).toHaveText(
    '1 to add, 1 to remove'
  )
  await expect(roster(page, 'Participants')).toContainText('Will be removed when you save.')
  await expect(roster(page, 'Participants')).toContainText(
    'Sees the conversation from the moment they join'
  )
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).locator('[data-group-saved]')).toBeVisible()
  const { issued, saves } = await harness(page, () => window.audienceHarness.calls)
  expect(saves).toHaveLength(1)
  expect(saves[0]!.expectedVersion).toBe(4)
  expect(issued[0]!.humans.toSorted()).toEqual(['44444444-0000-4000-8000-0000000000d9'])
  expect(issued[0]!.agents.map(({ agentId }) => agentId).toSorted()).toEqual(
    [ids.ariaAcme, ids.ariaGlobex].toSorted()
  )
  await expect(roster(page, 'Participants').getByRole('listitem')).toHaveCount(3)
  await expect(roster(page, 'Participants')).not.toContainText('Alex · Member')
})

test('a group that changes under an open draft keeps the draft and asks for a review before saving', async ({
  page,
}) => {
  await openManage(page)
  await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
  await harness(page, () => window.audienceHarness.concurrentEdit())
  const stale = dialog(page).locator('[data-group-stale]')
  await expect(stale).toContainText('version 4 to 5')
  await expect(stale).toContainText('Added since: Sam')
  await expect(dialog(page).getByRole('button', { name: 'Save changes' })).toBeDisabled()
  await expect(agents(page).getByRole('checkbox', { name: 'Aria · Globex' })).toBeChecked()
  await dialog(page).getByRole('button', { name: 'Review updated roster' }).click()
  await expect(stale).toHaveCount(0)
  await expect(roster(page, 'Participants')).toContainText('Sam')
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).locator('[data-group-saved]')).toBeVisible()
  const { saves } = await harness(page, () => window.audienceHarness.calls)
  expect(saves).toHaveLength(1)
  expect(saves[0]!.expectedVersion).toBe(5)
  expect(saves[0]!.participants.some((p) => p.kind === 'user' && p.userId === ids.sam)).toBe(true)
})

test('a stale version the page was not told about is refused, the draft stays, and the host re-reads', async ({
  page,
}) => {
  await openManage(page)
  await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
  await harness(page, () => window.audienceHarness.nextSaveIsStale())
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).locator('[data-group-failure="conflict"]')).toContainText(
    'Your changes are kept'
  )
  await expect(agents(page).getByRole('checkbox', { name: 'Aria · Globex' })).toBeChecked()
  expect((await harness(page, () => window.audienceHarness.calls)).staleReads).toBe(1)
  // The re-read group (version 5) arrives and is reviewed before anything is sent again.
  await expect(dialog(page).locator('[data-group-stale]')).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Save changes' })).toBeDisabled()
})

test('someone who is not an owner or admin sees the roster and why they cannot change it', async ({
  page,
}) => {
  await open(page)
  await harness(page, () => window.audienceHarness.setRole('member'))
  await page.getByRole('button', { name: 'Open manage' }).click()
  await expect(dialog(page).locator('[data-group-readonly]')).toContainText(
    'Only workspace owners and admins'
  )
  await expect(roster(page, 'Participants').getByRole('listitem')).toHaveCount(3)
  await expect(dialog(page).getByRole('button', { name: 'Save changes' })).toHaveCount(0)
  await expect(dialog(page).getByRole('button', { name: /^Remove / })).toHaveCount(0)
})

test('without a trusted grant source the roster is read-only and the dependency is named', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('button', { name: 'Remove issuer' }).click()
  await page.getByRole('button', { name: 'Open manage' }).click()
  await expect(dialog(page).locator('[data-group-readonly]')).toContainText(
    'none can be requested from here yet'
  )
  await expect(dialog(page).getByRole('button', { name: 'Save changes' })).toHaveCount(0)
})

test('access revoked while editing ends in the uniform answer and nothing is shown as saved', async ({
  page,
}) => {
  await openManage(page)
  await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
  await harness(page, () =>
    window.audienceHarness.dropMember('44444444-0000-4000-8000-0000000000d9')
  )
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).locator('[data-group-failure="unavailable"]')).toContainText(
    'Nothing was changed'
  )
  await expect(dialog(page).locator('[data-group-saved]')).toHaveCount(0)
  await expect(dialog(page).getByRole('button', { name: 'Save changes' })).toBeDisabled()
})

test('a group from another workspace shows nothing about it', async ({ page }) => {
  await openManage(page)
  await harness(page, () =>
    window.audienceHarness.switchWorkspace('22222222-0000-4000-8000-0000000000b2')
  )
  await expect(dialog(page).locator('[data-group-failure="unavailable"]')).toContainText(
    'different workspace'
  )
  await expect(dialog(page).getByRole('list', { name: 'Participants' })).toHaveCount(0)
})

test('removing every person is refused before anything is sent', async ({ page }) => {
  await openManage(page)
  await roster(page, 'Participants').getByRole('button', { name: 'Remove You' }).click()
  await roster(page, 'Participants').getByRole('button', { name: 'Remove Alex · Member' }).click()
  await dialog(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog(page).locator('[data-group-local]')).toContainText(
    'A group needs at least one person'
  )
  expect((await harness(page, () => window.audienceHarness.calls)).saves).toHaveLength(0)
})

test.describe('narrow layout', () => {
  test.use({ viewport: { height: 640, width: 360 } })

  test('the create and manage dialogs fit 360px wide with no sideways scroll', async ({ page }) => {
    await openCreate(page)
    await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
    const overflow = () =>
      dialog(page).evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
        viewport: window.innerWidth,
      }))
    const create = await overflow()
    expect(create.scroll).toBeLessThanOrEqual(create.client)
    expect(create.client).toBeLessThanOrEqual(create.viewport)
    await dialog(page).getByRole('button', { name: 'Create conversation' }).scrollIntoViewIfNeeded()
    await expect(dialog(page).getByRole('button', { name: 'Create conversation' })).toBeVisible()
    await page.reload()
    await openManage(page)
    const manage = await overflow()
    expect(manage.scroll).toBeLessThanOrEqual(manage.client)
  })
})

// Axe over the states a person actually meets, with the shared WCAG 2.2 AA tag set the other dialogs use.
async function violations(page: Page) {
  await page.addScriptTag({ content: axe.source })
  const result = await page.evaluate(async () => {
    const audit = window as unknown as {
      axe: {
        run: (
          context: Document,
          options: object
        ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>
      }
    }
    return audit.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    })
  })
  return result.violations.map(({ id, nodes }) => ({
    id,
    targets: nodes.map(({ target }) => target),
  }))
}

test('the create dialog has no accessibility violations: filled, failed and confirmed', async ({
  page,
}) => {
  await openCreate(page)
  await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
  await toggle(people(page).getByRole('checkbox', { name: /Alex · Admin/ }))
  expect(await violations(page)).toEqual([])
  await page.evaluate(() => window.audienceHarness.nextCreate('rejected'))
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  await expect(dialog(page).locator('[data-group-failure="rejected"]')).toBeVisible()
  expect(await violations(page)).toEqual([])
  await dialog(page).getByRole('button', { name: 'Create conversation' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Group created' })).toBeVisible()
  expect(await violations(page)).toEqual([])
})

test('the manage dialog has no accessibility violations: drafted and stale', async ({ page }) => {
  await openManage(page)
  await toggle(agents(page).getByRole('checkbox', { name: 'Aria · Globex' }))
  await roster(page, 'Participants').getByRole('button', { name: 'Remove Alex · Member' }).click()
  expect(await violations(page)).toEqual([])
  await page.evaluate(() => window.audienceHarness.concurrentEdit())
  await expect(dialog(page).locator('[data-group-stale]')).toBeVisible()
  expect(await violations(page)).toEqual([])
})
