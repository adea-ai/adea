import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const section = {
  limit: 1000,
  records: [
    {
      family: 'nativeSessions',
      accountId: '00000000-0000-4000-8000-000000000001',
      activeHarnessRunId: null,
      agentProfileId: null,
      agentProfileVersion: null,
      archived: false,
      generation: 1,
      harnessInstallationId: null,
      lifecycle: 'ready',
      projectId: '00000000-0000-4000-8000-000000000020',
      runtimeNodeId: '00000000-0000-4000-8000-000000000003',
      sessionRef: '00000000-0000-4000-8000-000000000040',
      version: 1,
      workspaceId: '00000000-0000-4000-8000-000000000002',
      worktreeId: '00000000-0000-4000-8000-000000000050',
    },
  ],
  truncated: false,
}

test('the local inventory action cancels, invalidates on identity change, and downloads its bounded section', async ({
  page,
}) => {
  await page.goto('/test/native-session-inventory-interaction.tsx')
  await page.setContent('<main id="root"></main>')
  await page.addScriptTag({
    type: 'module',
    url: '/test/native-session-inventory-interaction.tsx',
  })

  const capture = page.getByRole('button', { name: 'Capture local inventory' })
  await expect(capture).toBeVisible()
  await capture.click()
  await expect(page.getByText(/Reading the signed desktop runtime/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel capture' }).click()
  await expect(page.getByText(/Capture was cancelled/)).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { nativeSessionInventoryTest: { abortSignal: AbortSignal } })
          .nativeSessionInventoryTest.abortSignal.aborted
    )
  ).toBe(true)

  await capture.click()
  await page.evaluate(
    (result) => {
      const state = (
        window as typeof window & {
          nativeSessionInventoryTest: { finish(value: unknown): void }
        }
      ).nativeSessionInventoryTest
      state.finish(result)
    },
    { status: 'captured', section }
  )
  await expect(page.getByText(/Captured 1 session identities/)).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download redacted inventory' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('adea-native-session-inventory.json')
  const path = await download.path()
  expect(path).toBeTruthy()
  const downloaded = JSON.parse(await readFile(path!, 'utf8')) as typeof section
  expect(downloaded.records).toEqual(section.records)
  expect(JSON.stringify(downloaded)).not.toContain('credential')
  expect(JSON.stringify(downloaded)).not.toContain('transcript')

  const setBindingIdentity = async (identity: string) =>
    page.evaluate((nextIdentity) => {
      const state = (
        window as typeof window & {
          nativeSessionInventoryTest: { setBindingIdentity(value: string): void }
        }
      ).nativeSessionInventoryTest
      state.setBindingIdentity(nextIdentity)
    }, identity)
  await setBindingIdentity('rotated-session')
  await expect(page.getByText(/No inventory has been captured/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download redacted inventory' })).toHaveCount(0)

  await capture.click()
  await expect(page.getByText(/Reading the signed desktop runtime/)).toBeVisible()
  await setBindingIdentity('new-principal')
  await expect(page.getByText(/No inventory has been captured/)).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { nativeSessionInventoryTest: { abortSignal: AbortSignal } })
          .nativeSessionInventoryTest.abortSignal.aborted
    )
  ).toBe(true)
  await page.evaluate(
    (result) => {
      const state = (
        window as typeof window & {
          nativeSessionInventoryTest: { finish(value: unknown): void }
        }
      ).nativeSessionInventoryTest
      state.finish(result)
    },
    { status: 'captured', section }
  )
  await expect(page.getByText(/Captured 1 session identities/)).toHaveCount(0)
})
