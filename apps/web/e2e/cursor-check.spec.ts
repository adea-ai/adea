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
