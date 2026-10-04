import { expect, test } from '@playwright/test'

// Pointer-cursor parity is a product-polish gate that regressed more than once,
// so it is asserted for every interactive control on the workspace surface and
// for the menu items inside a dropdown, which the button sweep cannot see.
test('interactive controls show the pointer cursor', async ({ page }) => {
  await page.goto('/?view=chat')
  const railSwitch = page.getByRole('button', { name: /Switch workspace/i })
  await expect(railSwitch).toBeVisible({ timeout: 60_000 })

  const result = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button:not(:disabled)')]
    const offenders: string[] = []
    for (const element of buttons) {
      if (getComputedStyle(element).cursor !== 'pointer') {
        offenders.push(
          `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 40)}" aria=${element.getAttribute('aria-label') ?? '-'}`
        )
      }
    }
    return { total: buttons.length, offenders }
  })

  expect(result.total).toBeGreaterThan(0)
  expect(result.offenders).toEqual([])

  await railSwitch.click()
  const menuItems = page.locator('[data-slot="dropdown-menu-item"], [role="menuitemradio"]')
  await expect(menuItems.first()).toBeVisible()
  const menuCursors = await menuItems.evaluateAll((items) =>
    items.map((item) => getComputedStyle(item).cursor)
  )
  expect(menuCursors.length).toBeGreaterThan(0)
  expect(new Set(menuCursors)).toEqual(new Set(['pointer']))
})

// Resize separators are focusable drag controls, not buttons, so the button
// sweep above cannot see them; the Dev utility splitter regressed to the
// default arrow while every sidebar ruler showed the pointer.
test('resize separators show the pointer cursor on chat and dev surfaces', async ({ page }) => {
  const separatorCursors = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[role="separator"]')]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          label: element.getAttribute('aria-label') ?? '-',
          cursor: getComputedStyle(element).cursor,
        }))
    )

  await page.goto('/?view=chat')
  const chatHandle = page.getByRole('separator', { name: 'Resize workspace navigation' })
  await expect(chatHandle).toBeVisible({ timeout: 60_000 })
  const chatSeparators = await separatorCursors()
  expect(chatSeparators.length).toBeGreaterThan(0)
  expect(chatSeparators.every(({ cursor }) => cursor === 'pointer')).toBe(true)

  await page.goto('/?view=dev')
  const devHandle = page.getByRole('separator', { name: 'Resize projects and sessions sidebar' })
  await expect(devHandle).toBeVisible({ timeout: 60_000 })
  const devSeparators = await separatorCursors()
  expect(devSeparators.length).toBeGreaterThan(0)
  expect(devSeparators.every(({ cursor }) => cursor === 'pointer')).toBe(true)
})
