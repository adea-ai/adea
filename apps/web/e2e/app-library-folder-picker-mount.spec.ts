import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

// Browser-mounted checks of the Add repository folder picker. The real dialog and form mount in the page;
// only the host's picker and the Dev Runtime are fakes, so no native panel and no OS interaction happen here.
test.use({ headless: true })

type PickerMode = 'pick' | 'reject' | 'throw' | 'hang'

test.beforeEach(async ({ page }) => {
  await page.route('**/__app-library-folder-picker', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto('/__app-library-folder-picker')
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' +
      resolve(process.cwd(), 'apps/web/e2e/helpers/app-library-folder-picker-harness-app.tsx')
  )
  await expect(page.getByTestId('ready')).toHaveText('ready')
})

const setMode = (page: Page, mode: PickerMode) =>
  page.evaluate((value) => {
    const host = window as unknown as { pickerFixture?: { mode?: PickerMode } }
    host.pickerFixture = { ...host.pickerFixture, mode: value }
  }, mode)

// Answers the pick that is in flight; the harness keeps its resolver until the host answers.
const resolvePick = (page: Page, value: string) =>
  page.evaluate((picked) => {
    const host = window as unknown as {
      pickerFixture?: { resolvePick?: (value: string) => void }
    }
    if (!host.pickerFixture?.resolvePick) throw new Error('no pick is in flight')
    host.pickerFixture.resolvePick(picked)
  }, value)

// The dialog is open when the fixture loads. Once it is open, the page hides everything else from the
// accessibility tree, so the reopen button is only reachable after the dialog has been closed.
const openDialog = async (page: Page) => {
  const dialog = page.getByRole('dialog', { name: 'Add a repository to Fixture project' })
  if ((await dialog.count()) === 0)
    await page.getByRole('button', { name: 'Open repository dialog', exact: true }).click()
  await expect(dialog).toBeVisible()
  return dialog
}

test('a picked folder fills the field and still needs authorization before anything is sent', async ({
  page,
}) => {
  await setMode(page, 'pick')
  const dialog = await openDialog(page)
  const path = dialog.getByRole('textbox', { name: 'Folder path to authorize' })
  await dialog.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(path).toHaveValue('/Users/fixture/projects/app')
  await expect(page.getByTestId('picker-calls')).toHaveText('1')
  await expect(page.getByTestId('authorize-calls')).toHaveText('0')
})

test('a host pick that fails keeps the typed path and sends no authorization', async ({ page }) => {
  await setMode(page, 'reject')
  const dialog = await openDialog(page)
  const path = dialog.getByRole('textbox', { name: 'Folder path to authorize' })
  await path.fill('/srv/typed')
  await dialog.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(page.getByTestId('picker-calls')).toHaveText('1')
  await expect(path).toHaveValue('/srv/typed')
  await expect(page.getByTestId('authorize-calls')).toHaveText('0')
})

test('a host that cannot open a panel keeps the typed path and the form stays usable', async ({
  page,
}) => {
  await setMode(page, 'throw')
  const dialog = await openDialog(page)
  const path = dialog.getByRole('textbox', { name: 'Folder path to authorize' })
  await path.fill('/srv/typed')
  await dialog.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(page.getByTestId('picker-calls')).toHaveText('1')
  await expect(path).toHaveValue('/srv/typed')
  await expect(dialog.getByRole('button', { name: 'Choose folder…' })).toBeEnabled()
  await expect(page.getByTestId('authorize-calls')).toHaveText('0')
})

test('a repeated Choose folder request while a pick is in flight reaches the host once', async ({
  page,
}) => {
  await setMode(page, 'hang')
  const dialog = await openDialog(page)
  const path = dialog.getByRole('textbox', { name: 'Folder path to authorize' })
  await dialog.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(page.getByTestId('picker-calls')).toHaveText('1')
  // While the host is answering, the mounted form relabels the control and disables it, so a second request cannot be sent.
  const choosing = dialog.getByRole('button', { name: 'Choosing…' })
  await expect(choosing).toBeDisabled()
  await resolvePick(page, '/srv/picked')
  await expect(path).toHaveValue('/srv/picked')
  await expect(page.getByTestId('picker-calls')).toHaveText('1')
  await expect(page.getByTestId('authorize-calls')).toHaveText('0')
})

test('a pick that completes after the form closed does not fill a reopened form', async ({
  page,
}) => {
  await setMode(page, 'hang')
  const dialog = await openDialog(page)
  await dialog.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(page.getByTestId('picker-calls')).toHaveText('1')
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('dialog', { name: 'Add a repository to Fixture project' })
  ).toHaveCount(0)
  await resolvePick(page, '/srv/late')
  const reopened = await openDialog(page)
  await expect(reopened.getByRole('textbox', { name: 'Folder path to authorize' })).toHaveValue('')
  await expect(page.getByTestId('authorize-calls')).toHaveText('0')
})
