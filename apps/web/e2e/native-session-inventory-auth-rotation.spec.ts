import { expect, test, type Page } from '@playwright/test'
import type { rotationControls } from '../test/desktop-entry-auth-rotation-state'

async function mount(page: Page, query = '') {
  const intercepted = new Set<string>()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const replacements = new Map([
    ['/src/lib/desktop-runtime.ts', '/test/desktop-entry-auth-rotation-runtime.ts'],
    [
      '/src/components/workspace-navigation.tsx',
      '/test/desktop-entry-auth-rotation-navigation.tsx',
    ],
  ])
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const replacement = replacements.get(pathname)
    if (!replacement) return route.continue()
    intercepted.add(pathname)
    return route.fulfill({
      contentType: 'application/javascript',
      body: `export * from ${JSON.stringify(replacement)};`,
    })
  })
  await page.goto(`/test/desktop-entry-auth-rotation.html${query}`)
  const report = () =>
    page.evaluate(() =>
      (
        window as Window & { desktopEntryAuthRotation: typeof rotationControls }
      ).desktopEntryAuthRotation.report()
    )
  await expect.poll(async () => (await report()).bootstrapCount).toBe(1)
  await expect.poll(async () => (await report()).bindingAvailable).toBe(true)
  const before = await report()
  expect(before.entryMounts).toBe(1)
  expect(before.providerSerial).toBeGreaterThan(0)
  expect(before.selectedSessionIds).toEqual(['fixture-session-a'])
  expect(before.scopeSelections).toBe(1)
  expect([...intercepted].toSorted()).toEqual([...replacements.keys()].toSorted())
  return { before, errors, report }
}

for (const rotation of ['session', 'principal', 'same-session'] as const) {
  test(`same-workspace ${rotation} rotation replaces the invalidated native inventory provider`, async ({
    page,
  }, testInfo) => {
    const { before, errors, report } = await mount(page, `?rotation=${rotation}`)
    const capture = page.getByRole('button', { name: 'Capture local inventory', exact: true })
    await capture.click()
    await expect(page.getByText(/Captured 1 session identities/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download redacted inventory' })).toBeVisible()
    expect((await report()).inventoryReads).toBe(1)

    // Deliver the registered production auth callback. No fixture provider
    // replacement, Entry remount, null workspace or direct signal write occurs.
    await page.evaluate(() => window.desktopEntryAuthRotation.rotateSession())
    await expect.poll(async () => (await report()).bootstrapCount).toBe(2)
    await expect.poll(async () => (await report()).scopeSelections).toBe(2)
    const rotated = await report()
    const originalProviderResult = await page.evaluate(() =>
      window.desktopEntryAuthRotation.captureOriginalProvider()
    )
    await testInfo.attach('auth-rotation-state', {
      body: JSON.stringify({
        before,
        rotated,
        originalProviderResult,
        after: await report(),
        errors,
      }),
      contentType: 'application/json',
    })
    const expectedSessions = [
      'fixture-session-a',
      `fixture-session-${rotation === 'session' ? 'b' : 'a'}`,
    ]
    expect(rotated.bootstrapSessionIds).toEqual(expectedSessions)
    expect(rotated.selectedSessionIds).toEqual(expectedSessions)
    expect(rotated.bootstrapPrincipalIds).toEqual([
      'fixture-user-a',
      `fixture-user-${rotation === 'principal' ? 'b' : 'a'}`,
    ])
    expect(rotated.workspaceIds).toEqual([before.workspaceIds[0], before.workspaceIds[0]])
    expect(rotated.entryMounts).toBe(1)
    expect(rotated.unexpectedOperations).toEqual([])
    expect(originalProviderResult).toEqual({ status: 'unknown', reason: 'ownership_mismatch' })
    expect((await report()).inventoryReads).toBe(1)
    await expect(page.getByRole('button', { name: 'Download redacted inventory' })).toHaveCount(0)

    // The old provider must stay invalidated. A newly admitted provider must be
    // composed so another capture can recover without switching workspaces.
    await expect.poll(async () => (await report()).providerSerial).not.toBe(before.providerSerial)
    await expect.poll(async () => (await report()).bindingAvailable).toBe(true)
    await capture.click()
    await expect(page.getByText(/Captured 1 session identities/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download redacted inventory' })).toBeVisible()
    expect((await report()).inventoryReads).toBe(2)
    expect((await report()).unexpectedOperations).toEqual([])
    expect(errors).toEqual([])
  })
}

test('held fresh scope admission blocks capture and discards a late old inventory reply', async ({
  page,
}) => {
  const { before, errors, report } = await mount(page, '?admission=held')
  const capture = page.getByRole('button', { name: 'Capture local inventory', exact: true })
  await page.evaluate(() => window.desktopEntryAuthRotation.holdNextInventoryRead())
  await capture.click()
  await expect.poll(async () => (await report()).heldInventoryRead).toBe(true)
  await expect(page.getByText(/Reading the signed desktop runtime/)).toBeVisible()
  await page.evaluate(() => window.desktopEntryAuthRotation.rotateSession())
  await expect.poll(async () => (await report()).heldWorkspaceSelection).toBe(true)
  const pending = await report()
  expect(pending.bootstrapCount).toBe(2)
  expect(pending.selectionRequests).toBe(2)
  expect(pending.scopeSelections).toBe(1)
  expect(pending.bindingAvailable).toBe(false)
  expect(pending.inventoryReads).toBe(1)
  await expect(capture).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Download redacted inventory' })).toHaveCount(0)
  await page.evaluate(() => window.desktopEntryAuthRotation.releaseInventoryRead())
  await expect.poll(async () => (await report()).inventoryReplies).toBe(1)
  await expect(page.getByText(/Captured 1 session identities/)).toHaveCount(0)
  expect((await report()).inventoryReads).toBe(1)
  await page.evaluate(() => window.desktopEntryAuthRotation.releaseWorkspaceSelection())
  await expect.poll(async () => (await report()).scopeSelections).toBe(2)
  await expect
    .poll(async () => (await report()).providerSerial)
    .toBeGreaterThan(before.providerSerial)
  await expect.poll(async () => (await report()).bindingAvailable).toBe(true)
  expect(
    await page.evaluate(() => window.desktopEntryAuthRotation.captureOriginalProvider())
  ).toEqual({
    status: 'unknown',
    reason: 'ownership_mismatch',
  })
  expect((await report()).inventoryReads).toBe(1)
  await capture.click()
  await expect(page.getByText(/Captured 1 session identities/)).toBeVisible()
  expect((await report()).inventoryReads).toBe(2)
  expect((await report()).unexpectedOperations).toEqual([])
  expect(errors).toEqual([])
})

test('refused fresh scope admission never dispatches a replacement inventory read', async ({
  page,
}) => {
  const { errors, report } = await mount(page, '?admission=refused')
  const capture = page.getByRole('button', { name: 'Capture local inventory', exact: true })
  await capture.click()
  await expect(page.getByText(/Captured 1 session identities/)).toBeVisible()
  await page.evaluate(() => window.desktopEntryAuthRotation.rotateSession())
  await expect.poll(async () => (await report()).selectionRequests).toBe(2)
  await expect(page.getByRole('button', { name: 'Download redacted inventory' })).toHaveCount(0)
  await capture.click()
  await expect(
    page.getByText(/No authenticated desktop inventory source is available/)
  ).toBeVisible()
  const refused = await report()
  expect(refused.bootstrapCount).toBe(2)
  expect(refused.scopeSelections).toBe(1)
  expect(refused.bindingAvailable).toBe(false)
  expect(refused.inventoryReads).toBe(1)
  expect(
    await page.evaluate(() => window.desktopEntryAuthRotation.captureOriginalProvider())
  ).toEqual({
    status: 'unknown',
    reason: 'ownership_mismatch',
  })
  expect((await report()).inventoryReads).toBe(1)
  expect(refused.unexpectedOperations).toEqual([])
  expect(errors).toEqual([])
})
