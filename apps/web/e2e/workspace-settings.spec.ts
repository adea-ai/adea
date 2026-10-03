import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * Pins the Input & notifications regression (round 4): mounting that section
 * used to throw `useSound must be used within <SoundProvider>` from the
 * soundtrack row's MusicToggle, white-screening the app. The harness mounts
 * the dialog with no providers above it, so any section that stops rendering
 * standalone fails here instead of in the product.
 */
async function openSettingsHarness(
  page: Page,
  microphoneMode: 'retry' | 'delayed' | undefined = undefined
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
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-settings-harness-app.tsx')
  )
  return errors
}

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
