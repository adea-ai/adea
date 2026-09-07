import { expect, test } from '@playwright/test'

test('workspace sidebar is resizable and persists its width', async ({ page }) => {
  await page.goto('/?view=chat')
  const sidebar = page.locator('.conventional-sidebar')
  await expect(sidebar).toBeVisible({ timeout: 30_000 })
  const handle = page.getByRole('separator', { name: 'Resize workspace navigation' })
  await expect(handle).toBeAttached()

  const widthBefore = await sidebar.evaluate((element) => element.getBoundingClientRect().width)

  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 300, { steps: 6 })
  await page.mouse.up()

  const widthAfterDrag = await sidebar.evaluate((element) => element.getBoundingClientRect().width)
  expect(widthAfterDrag).toBeGreaterThan(widthBefore + 60)

  await page.reload()
  await expect(sidebar).toBeVisible({ timeout: 30_000 })
  const widthAfterReload = await sidebar.evaluate(
    (element) => element.getBoundingClientRect().width
  )
  expect(Math.abs(widthAfterReload - widthAfterDrag)).toBeLessThanOrEqual(1)

  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  const widthAfterKeyboard = await sidebar.evaluate(
    (element) => element.getBoundingClientRect().width
  )
  expect(widthAfterKeyboard).toBeLessThan(widthAfterDrag)
})
