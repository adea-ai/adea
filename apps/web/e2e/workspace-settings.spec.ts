import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import {
  settingsSectionLabels,
  settingsSections,
  workspaceSettingsSectionLabels,
  workspaceSettingsSections,
} from '../../../packages/workspace-ui/src/settings-section'

/**
 * Pins the Input & notifications regression (round 4): mounting that section
 * used to throw `useSound must be used within <SoundProvider>` from the
 * soundtrack row's MusicToggle, white-screening the app. The harness mounts
 * the dialog with no providers above it, so any section that stops rendering
 * standalone fails here instead of in the product.
 */
async function openSettingsHarness(
  page: Page,
  microphoneMode: 'retry' | 'delayed' | undefined = undefined,
  desktopPreferences = false,
  desktopWriteFailure = false,
  missingDesktopBridge = false,
  themeProvider = false
): Promise<Error[]> {
  const path = '/__workspace-settings'
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(`${path}#settings/input-notifications`)
  if (microphoneMode) {
    await page
      .locator('#harness-root')
      .evaluate(
        (element, mode) => element.setAttribute(`data-microphone-${mode}`, ''),
        microphoneMode
      )
  }
  if (desktopPreferences) {
    await page
      .locator('#harness-root')
      .evaluate((element) => element.setAttribute('data-desktop-preferences', ''))
  }
  if (desktopWriteFailure) {
    await page
      .locator('#harness-root')
      .evaluate((element) => element.setAttribute('data-desktop-write-failure', ''))
  }
  if (missingDesktopBridge) {
    await page
      .locator('#harness-root')
      .evaluate((element) => element.setAttribute('data-missing-desktop-bridge', ''))
  }
  if (themeProvider)
    await page
      .locator('#harness-root')
      .evaluate((element) => element.setAttribute('data-theme-provider', ''))
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-settings-harness-app.tsx')
  )
  return errors
}

test('every settings section survives missing desktop services and repeated navigation', async ({
  page,
}) => {
  const errors = await openSettingsHarness(page, undefined, true, false, true)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  for (const section of [...settingsSections, ...settingsSections.toReversed()]) {
    const tab = dialog.getByRole('tab', {
      name: settingsSectionLabels[section],
      exact: true,
    })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`#settings-panel-${section}`)).toBeVisible()
    if (section === 'appearance')
      await expect(dialog.getByRole('status')).toHaveText(
        'Appearance settings are unavailable in this view.'
      )
    await expect(dialog).toBeVisible()
    expect(errors).toEqual([])
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Open settings fixture', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: 'Input & notifications', exact: true }).click()
  await expect(page.locator('#settings-panel-input-notifications')).toBeVisible()
  expect(errors).toEqual([])
})

test('the appearance fallback updates its host theme when a provider is present', async ({
  page,
}) => {
  const errors = await openSettingsHarness(page, undefined, false, false, false, true)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click()
  await dialog.getByLabel('Dark', { exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await dialog.getByLabel('Light', { exact: true }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await expect(dialog.getByText('Appearance settings are unavailable in this view.')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a rejected microphone permission check stays recoverable and retries', async ({ page }) => {
  const errors = await openSettingsHarness(page, 'retry')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const microphone = dialog.getByRole('button', { name: 'Check microphone', exact: true })
  await microphone.click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Microphone access could not be checked. Try again.'
  )
  await expect(microphone).toBeEnabled()
  await microphone.click()
  await expect(dialog.getByRole('button', { name: 'granted', exact: true })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await dialog.getByRole('tab', { name: 'Privacy & data' }).click()
  await expect(page.locator('#settings-panel-privacy-data')).toBeVisible()
  expect(errors).toEqual([])
})

test('a permission result from a closed dialog cannot change the reopened dialog', async ({
  page,
}) => {
  const errors = await openSettingsHarness(page, 'delayed')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Check microphone', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Check microphone', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Open settings fixture', exact: true }).click()
  await dialog.getByRole('tab', { name: 'Input & notifications', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Check microphone', exact: true })).toBeEnabled()
  // Simulate host completion while the outside fixture control is inert behind the dialog.
  await page
    .locator('#resolve-permission-fixture')
    .evaluate((element: HTMLButtonElement) => element.click())
  await expect(dialog.getByRole('button', { name: 'Check microphone', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'granted', exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('the Input & notifications section renders without the app sound providers', async ({
  page,
}) => {
  const errors = await openSettingsHarness(page)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Input & notifications' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  const panel = page.locator('#settings-panel-input-notifications')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Composer dictation')).toBeVisible()
  await expect(panel.getByText('Dictation language')).toBeVisible()
  await expect(panel.getByText('Workspace soundtrack')).toBeVisible()
  await expect(panel.getByText('Mention notifications')).toBeVisible()
  // The soundtrack row composes the shared music toggle, which must render
  // (and stay operable) even though this tree has no SoundProvider.
  const musicToggle = panel.getByRole('button', { name: /music/ })
  await expect(musicToggle).toBeVisible()
  const pressedBefore = await musicToggle.getAttribute('aria-pressed')
  await musicToggle.click()
  await expect(musicToggle).not.toHaveAttribute('aria-pressed', pressedBefore ?? '')
  expect(errors).toEqual([])
})

test('leaving and re-entering the section keeps the dialog operable', async ({ page }) => {
  const errors = await openSettingsHarness(page)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('tab', { name: 'Privacy & data' }).click()
  await expect(page.locator('#settings-panel-privacy-data')).toBeVisible()
  await page.getByRole('tab', { name: 'Input & notifications' }).click()
  await expect(dialog).toBeVisible()
  await expect(page.locator('#settings-panel-input-notifications')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check microphone' })).toBeVisible()
  expect(errors).toEqual([])
})

test('desktop settings stay operable with a missing preferences file and null save acknowledgements', async ({
  page,
}) => {
  const errors = await openSettingsHarness(page, undefined, true)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const inputPanel = page.locator('#settings-panel-input-notifications')
  const locale = inputPanel.getByRole('textbox', { name: 'Dictation language' })
  await expect(locale).toHaveValue('')
  const mentions = inputPanel.getByRole('switch', { name: 'Mention notifications' })
  await expect(mentions).toBeChecked()
  await mentions.press('Space')
  await expect(mentions).not.toBeChecked()
  await expect(dialog.getByText('Settings saved', { exact: true })).toHaveCount(1)
  await locale.fill('es-PR')
  await locale.press('Tab')
  await expect(dialog.getByText('Settings saved', { exact: true })).toHaveCount(1)
  await dialog.getByRole('tab', { name: 'Privacy & data', exact: true }).click()
  const previews = dialog.getByRole('switch', { name: 'Private notification previews' })
  await expect(previews).not.toBeChecked()
  await previews.locator('..').click()
  await expect(previews).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Open settings fixture', exact: true }).click()
  await dialog.getByRole('tab', { name: 'Input & notifications', exact: true }).click()
  await expect(locale).toHaveValue('es-PR')
  await expect(mentions).not.toBeChecked()
  await dialog.getByRole('tab', { name: 'Privacy & data', exact: true }).click()
  await expect(previews).toBeChecked()
  expect(errors).toEqual([])
})

test('a failed native settings write leaves the dialog operable and the next save can recover', async ({
  page,
}) => {
  const errors = await openSettingsHarness(page, undefined, true, true)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const mentions = dialog.getByRole('switch', { name: 'Mention notifications' })
  await mentions.press('Space')
  await expect(dialog.getByText('Settings could not be saved', { exact: true })).toHaveCount(1)
  await expect(dialog).toBeVisible()
  await expect(mentions).toBeEnabled()
  await mentions.press('Space')
  await expect(dialog.getByText('Settings saved', { exact: true })).toHaveCount(1)
  await expect(dialog.getByText('Settings could not be saved', { exact: true })).toHaveCount(0)
  await dialog.getByRole('tab', { name: 'Privacy & data', exact: true }).click()
  await expect(dialog.getByRole('switch', { name: 'Private notification previews' })).toBeVisible()
  expect(errors).toEqual([])
})

test('missing desktop bridge degrades private health and System Settings actions without crashing', async ({
  page,
}) => {
  const errors = await openSettingsHarness(page, undefined, false, false, true)
  expect(await page.evaluate(() => Reflect.get(window, '__adeaDesktop'))).toBeUndefined()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: 'Privacy & data', exact: true }).click()
  await expect(page.locator('#settings-panel-privacy-data')).toContainText(
    'Unavailable in this app or on this device.'
  )
  await dialog.getByRole('tab', { name: 'Permissions', exact: true }).click()
  const pane = dialog.getByRole('region', { name: 'macOS permissions' })
  const openSystemSettings = pane
    .getByRole('button', { name: 'Open System Settings', exact: true })
    .first()
  await expect(openSystemSettings).toBeEnabled()
  await openSystemSettings.click()
  await expect(pane.getByRole('status')).toContainText(
    /could not open system settings for .* from this lane/i
  )
  await expect(openSystemSettings).toBeEnabled()
  await dialog.getByRole('tab', { name: 'Input & notifications', exact: true }).click()
  await expect(page.locator('#settings-panel-input-notifications')).toBeVisible()
  expect(errors).toEqual([])
})

test('app Settings no longer lists the workspace-scoped sections', async ({ page }) => {
  const errors = await openSettingsHarness(page)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const tablist = dialog.getByRole('tablist', { name: 'Settings sections' })
  await expect(tablist.getByRole('tab')).toHaveText(
    settingsSections.map((section) => settingsSectionLabels[section])
  )
  for (const moved of ['Workspace', 'Memory', 'Skills', 'Connections'])
    await expect(tablist.getByRole('tab', { name: moved, exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

async function openWorkspaceSettingsHarness(
  page: Page,
  section: string,
  readOnly = false
): Promise<Error[]> {
  const path = '/__workspace-settings'
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(`${path}#workspace-settings/${section}`)
  if (readOnly)
    await page
      .locator('#harness-root')
      .evaluate((element) => element.setAttribute('data-read-only', ''))
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-settings-harness-app.tsx')
  )
  return errors
}

test('every workspace settings section renders standalone and keeps its deep link', async ({
  page,
}) => {
  const errors = await openWorkspaceSettingsHarness(page, 'general')
  const dialog = page.getByRole('dialog', { name: 'Settings harness workspace settings' })
  await expect(dialog).toBeVisible()
  const tablist = dialog.getByRole('tablist', { name: 'Workspace settings sections' })
  await expect(tablist).toHaveAttribute('aria-orientation', 'vertical')
  await expect(tablist.getByRole('tab')).toHaveText(
    workspaceSettingsSections.map((section) => workspaceSettingsSectionLabels[section])
  )
  for (const section of [...workspaceSettingsSections, ...workspaceSettingsSections.toReversed()]) {
    const tab = tablist.getByRole('tab', {
      name: workspaceSettingsSectionLabels[section],
      exact: true,
    })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`#workspace-settings-panel-${section}`)).toBeVisible()
    await expect(
      dialog.getByRole('heading', {
        name: workspaceSettingsSectionLabels[section],
        level: 3,
        exact: true,
      })
    ).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`#workspace-settings/${section}$`))
    expect(errors).toEqual([])
  }
  await tablist.getByRole('tab', { name: 'General', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(tablist.getByRole('tab', { name: 'Memory', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(tablist.getByRole('tab', { name: 'Connections', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(tablist.getByRole('tab', { name: 'General', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(new URL(page.url()).hash).toBe('')
  expect(errors).toEqual([])
})

test('General saves workspace identity changes as they are made', async ({ page }) => {
  const errors = await openWorkspaceSettingsHarness(page, 'general')
  await expect(
    page.getByRole('dialog', { name: 'Settings harness workspace settings' })
  ).toBeVisible()
  const panel = page.locator('#workspace-settings-panel-general')
  await expect(panel.getByRole('status')).toHaveText('Changes save as you make them.')
  const name = panel.getByRole('textbox', { name: 'Workspace name' })
  await name.fill('Renamed harness')
  await name.press('Enter')
  await expect(panel.getByRole('status')).toHaveText('Saved.')
  // The title follows the saved name.
  await expect(
    page.getByRole('dialog', { name: 'Renamed harness workspace settings' })
  ).toBeVisible()
  await panel.getByText('Home', { exact: true }).click()
  await expect
    .poll(async () =>
      JSON.parse((await page.locator('#harness-root').getAttribute('data-workspace')) ?? '{}')
    )
    .toMatchObject({ name: 'Renamed harness', scene: 'home', version: 3 })
  expect(errors).toEqual([])
})

test('a host without workspace updates renders General read-only', async ({ page }) => {
  const errors = await openWorkspaceSettingsHarness(page, 'general', true)
  const panel = page.locator('#workspace-settings-panel-general')
  await expect(panel.getByRole('textbox', { name: 'Workspace name' })).toBeDisabled()
  await expect(panel.getByText('Changes save as you make them.')).toHaveCount(0)
  expect(errors).toEqual([])
})

/** Inert canary standing in for a connector secret; it must never reappear on the page. */
const CLOUD_SECRET_CANARY = 'canary-cloud-secret-0b7e'

async function openControlPlaneHarness(
  page: Page,
  mode: 'scoped' | 'unscoped',
  section: 'connections' | 'skills'
): Promise<Error[]> {
  const path = '/__workspace-settings'
  const errors: Error[] = []
  page.on('pageerror', (error) => errors.push(error))
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(`${path}#workspace-settings/${section}`)
  await page
    .locator('#harness-root')
    .evaluate((element, value) => element.setAttribute('data-control-plane', value), mode)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-settings-harness-app.tsx')
  )
  return errors
}

async function recordedRequests(page: Page) {
  return JSON.parse(
    (await page.locator('#harness-root').getAttribute('data-requests')) ?? '[]'
  ) as Array<{ method: string; path: string; body: Record<string, unknown> | null }>
}

test('Skills lists workspace and read-only system skills and deprecates after confirmation', async ({
  page,
}) => {
  const errors = await openControlPlaneHarness(page, 'scoped', 'skills')
  const panel = page.locator('#workspace-settings-panel-skills')
  await expect(panel.getByText('Release notes')).toBeVisible()
  await expect(panel.getByText('This workspace · 1.0.0 · revision 2')).toBeVisible()
  await expect(panel.getByText('Code review')).toBeVisible()
  await expect(panel.getByText('Read-only', { exact: true })).toHaveCount(1)
  // System items offer no lifecycle actions.
  await expect(panel.getByRole('button', { name: 'Deprecate Code review' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Revoke Code review' })).toHaveCount(0)
  await expect(
    panel.getByText('No agent profiles are visible to this workspace yet.')
  ).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Reload skills' })).toBeVisible()

  await panel.getByRole('button', { name: 'Deprecate Release notes' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Deprecate Release notes?')
  await confirm.getByRole('textbox', { name: 'Reason' }).fill('Replaced by 2.0.0')
  await confirm.getByRole('button', { name: 'Deprecate', exact: true }).click()
  await expect(
    panel.getByRole('status').filter({ hasText: 'Release notes deprecated.' })
  ).toBeVisible()
  await expect(panel.getByText('Deprecated', { exact: true })).toBeVisible()
  const deprecation = (await recordedRequests(page)).find(({ path }) => path.endsWith('/deprecate'))
  expect(deprecation?.method).toBe('POST')
  expect(deprecation?.body).toMatchObject({ reason: 'Replaced by 2.0.0' })
  expect(String(deprecation?.body?.idempotencyKey)).toMatch(/^adea-/u)
  expect(errors).toEqual([])
})

test('Cloud connections adds a connection with a write-only secret, rotates and revokes', async ({
  page,
}) => {
  const errors = await openControlPlaneHarness(page, 'scoped', 'connections')
  const panel = page.locator('#workspace-settings-panel-connections')
  await expect(panel.getByRole('heading', { name: 'Cloud' })).toBeVisible()
  await expect(panel.getByText('connector:github · revision 1 · added 2026-10-06')).toBeVisible()

  await panel.getByRole('button', { name: 'Add cloud connection…' }).click()
  await panel.getByLabel('Provider').fill('openai')
  const secret = panel.getByLabel('Secret', { exact: true })
  await expect(secret).toHaveAttribute('type', 'password')
  await secret.fill(CLOUD_SECRET_CANARY)
  await panel.getByRole('button', { name: 'Add connection' }).click()
  await expect(
    panel.getByRole('status').filter({ hasText: 'openai cloud connection added.' })
  ).toBeVisible()
  await expect(panel.getByText('openai', { exact: true })).toBeVisible()
  await expect(panel.getByLabel('Secret', { exact: true })).toHaveCount(0)

  const created = (await recordedRequests(page)).find(
    ({ method, path }) => method === 'POST' && path.endsWith('/cloud-connections')
  )
  // The fixture records only the secret's length, so the page itself never holds it.
  expect(created?.body).toMatchObject({
    connectorRef: 'connector:openai',
    provider: 'openai',
    secret: `<${CLOUD_SECRET_CANARY.length} characters>`,
  })

  await panel.getByRole('button', { name: 'Rotate the github secret' }).click()
  await panel.getByLabel('New github secret').fill(`${CLOUD_SECRET_CANARY}-2`)
  await panel.getByRole('button', { name: 'Rotate secret' }).click()
  await expect(
    panel.getByRole('status').filter({ hasText: 'github secret rotated.' })
  ).toBeVisible()
  await expect(panel.getByText(/revision 2 · rotated 2026-10-07/u)).toBeVisible()

  await panel.getByRole('button', { name: 'Revoke the github cloud connection' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Revoke the github connection?')
  await confirm.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(panel.getByText('Revoked', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Rotate the github secret' })).toHaveCount(0)

  // The secret left once per write and never appears anywhere in the page.
  expect(await page.content()).not.toContain(CLOUD_SECRET_CANARY)
  expect(errors).toEqual([])
})

test('an unscoped deployment explains why Skills and cloud connections are unavailable', async ({
  page,
}) => {
  const errors = await openControlPlaneHarness(page, 'unscoped', 'connections')
  const connections = page.locator('#workspace-settings-panel-connections')
  await expect(connections.getByText(/need per-workspace Control Plane credentials/u)).toBeVisible()
  await expect(connections.getByRole('button', { name: 'Add cloud connection…' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Skills', exact: true }).click()
  await expect(
    page
      .locator('#workspace-settings-panel-skills')
      .getByText(/need per-workspace Control Plane credentials/u)
  ).toHaveCount(2)
  expect(errors).toEqual([])
})
