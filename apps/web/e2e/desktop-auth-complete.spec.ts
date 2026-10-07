import { expect, test } from '@playwright/test'

// The desktop handoff page's early-access state links to the project on
// GitHub. Bare lucide SVGs render display:block at their intrinsic 24px
// (Tailwind preflight), which dropped the mark onto its own line below the
// label; the published inline link keeps them on one line at text size.
test('the early-access handoff link keeps its external-link icon inline at text size', async ({
  page,
}) => {
  await page.goto('/auth/desktop/complete#error=early_access')
  const link = page.getByRole('link', { name: 'Adea on GitHub' })
  await expect(link).toBeVisible()

  const layout = await link.evaluate((element) => {
    const icon = element.querySelector('svg')
    if (!icon) throw new Error('external-link icon missing')
    const labelRange = document.createRange()
    labelRange.selectNodeContents(element.childNodes[0])
    const labelBox = labelRange.getBoundingClientRect()
    const iconBox = icon.getBoundingClientRect()
    return {
      display: getComputedStyle(element).display,
      iconHeight: iconBox.height,
      labelRight: labelBox.right,
      iconLeft: iconBox.left,
      labelCenterY: (labelBox.top + labelBox.bottom) / 2,
      iconCenterY: (iconBox.top + iconBox.bottom) / 2,
    }
  })

  // The published inline link lays the label and the mark out on one line.
  expect(layout.display).toBe('inline-flex')
  expect(layout.iconHeight).toBe(16)
  expect(layout.iconLeft).toBeGreaterThanOrEqual(layout.labelRight - 1)
  expect(Math.abs(layout.iconCenterY - layout.labelCenterY)).toBeLessThanOrEqual(2)
})
