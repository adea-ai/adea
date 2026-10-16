import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

for (const registered of [false, true]) {
  test(`Workspace Details local inventory uses desktop authority with cloud registration=${registered}`, async ({
    page,
  }) => {
    const fixture = `/test/native-session-inventory-caller.html?registered=${registered}`
    await page.goto(fixture)
    if (!registered) {
      await expect(
        page.getByText('No execution hosts are registered in this workspace.')
      ).toBeVisible()
    } else {
      await expect(page.getByText('Registered desktop', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'View runtimes on Registered desktop' }).click()
    }
    const capture = page.getByRole('button', { name: 'Capture local inventory', exact: true })
    await expect(capture).toBeVisible({ timeout: 5000 })
    await capture.click()
    await expect(page.getByText(/Captured 1 session identities/)).toBeVisible()
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download redacted inventory' }).click()
    const file = await (await downloadEvent).path()
    const section = JSON.parse(await readFile(file!, 'utf8'))
    expect(section.records[0].runtimeNodeId).toBe('00000000-0000-4000-8000-000000000003')
    expect(JSON.stringify(section)).not.toContain('00000000-0000-4000-8000-000000000099')
    expect(
      await page.evaluate(() => {
        const { commands } = (
          window as unknown as {
            nativeSessionCallerTest: { commands: { operation: string; scope: unknown }[] }
          }
        ).nativeSessionCallerTest
        return commands.map(({ operation, scope }) => ({ operation, scope }))
      })
    ).toEqual([
      {
        operation: 'dev.session.list',
        scope: {
          accountId: '00000000-0000-4000-8000-000000000001',
          workspaceId: '00000000-0000-4000-8000-000000000002',
          runtimeNodeId: '00000000-0000-4000-8000-000000000003',
        },
      },
    ])
    await page.evaluate(() => {
      ;(
        window as unknown as { nativeSessionCallerTest: { replaceProvider(): void } }
      ).nativeSessionCallerTest.replaceProvider()
    })
    await expect(page.getByRole('button', { name: 'Download redacted inventory' })).toHaveCount(0)
    await capture.click()
    await expect(page.getByText(/Captured 1 session identities/)).toBeVisible()
    await page.evaluate(() => {
      ;(
        window as unknown as { nativeSessionCallerTest: { setWorkspaceId(value: string): void } }
      ).nativeSessionCallerTest.setWorkspaceId('another-workspace')
    })
    await expect(page.getByRole('button', { name: 'Download redacted inventory' })).toHaveCount(0)
    await capture.click()
    await expect(page.getByText(/no longer matches the signed desktop scope/)).toBeVisible()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { nativeSessionCallerTest: { commands: unknown[] } })
            .nativeSessionCallerTest.commands.length
      )
    ).toBe(2)
  })
}
