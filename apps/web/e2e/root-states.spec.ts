import { expect, test } from '@playwright/test'

// The router's root not-found and error fallbacks used to render bare
// document flow — unstyled at the top-left. They now share the entry
// surfaces' centred auth-shell panel, so both states read like the app.
test('the root not-found state renders the standard centred page surface', async ({ page }) => {
  await page.goto('/this/path/opens/nothing')

  const notFoundHeading = page.getByRole('heading', { name: 'Page not found' })
  await expect(notFoundHeading).toBeVisible()
  await expect(page.getByText("This address doesn't match a workspace page.")).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open Adea' })).toHaveAttribute('href', '/')

  const surface = await page.evaluate(() => {
    const main = document.querySelector('main.auth-shell')
    const heading = document.querySelector('#root-state-title')
    if (!main || !heading) throw new Error('root state surface missing')
    const mainBox = main.getBoundingClientRect()
    const panelBox = main.querySelector('.auth-panel')!.getBoundingClientRect()
    const headingStyle = getComputedStyle(heading)
    const panel = main.querySelector('.auth-panel')!
    const panelStyle = getComputedStyle(panel)
    return {
      mainDisplay: getComputedStyle(main).display,
      centered: Math.abs(panelBox.left + panelBox.width / 2 - mainBox.width / 2) < 8,
      headingSize: parseFloat(headingStyle.fontSize),
      headingColor: headingStyle.color,
      panelBackground: panelStyle.backgroundColor,
      panelBorder: panelStyle.borderTopWidth,
    }
  })

  // The shell centres the token-surfaced panel and the headline reads at the
  // entry display scale — not bare document flow at the top-left.
  expect(surface.mainDisplay).toBe('grid')
  expect(surface.centered).toBe(true)
  expect(surface.headingSize).toBeGreaterThanOrEqual(32)
  expect(surface.panelBackground).not.toBe('rgba(0, 0, 0, 0)')
  expect(surface.panelBorder).not.toBe('0px')
})
