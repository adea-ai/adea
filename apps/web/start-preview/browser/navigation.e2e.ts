import { expect, test } from '@playwright/test'

test('view switches, query preservation and browser history keep the workspace usable', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/?view=chat&roomDesigner=0&characterDesigner=0&unknown=retained&x=a%26b&x=c%2Bd')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({ timeout: 20_000 })
  const length = await page.evaluate(() => history.length)
  await page.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(page.locator('.workspace-frame--virtual')).toBeVisible()
  await expect(page.getByRole('status', { name: 'Virtual view unavailable' })).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('virtual')
  await page.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(page.locator('.workspace-frame--chat')).toBeVisible()
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('chat')
  expect(await page.evaluate(() => history.length)).toBe(length)
  expect(new URL(page.url()).searchParams.getAll('x')).toEqual(['a&b', 'c+d'])
  expect(new URL(page.url()).searchParams.get('unknown')).toBe('retained')
  const previous = page.url()
  await page.goto('/?scene=work&view=virtual&roomDesigner=0')
  await expect(page.locator('.workspace-frame--virtual')).toBeVisible()
  await page.goBack()
  await expect(page.locator('.workspace-frame--chat')).toBeVisible()
  await expect(page).toHaveURL(previous)
  await page.goForward()
  await expect(page.locator('.workspace-frame--virtual')).toBeVisible()
  expect(errors).toEqual([])
})
