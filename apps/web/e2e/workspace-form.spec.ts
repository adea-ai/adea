import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test.beforeEach(async ({ page }) => {
  const path = '/__workspace-form'
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  await page.evaluate(() => {
    const prior = document.createElement('div')
    prior.id = 'preexisting-inert'
    prior.setAttribute('inert', '')
    document.body.append(prior)
  })
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-form-harness-app.tsx')
  )
})

test('creation fields retain the published control appearance across themes and text sizes', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create Project', exact: true })
  const field = dialog.getByLabel('Project name', { exact: true })
  const reference = page.getByRole('textbox', {
    name: 'Shared input reference',
    includeHidden: true,
  })
  const properties = [
    'height',
    'padding-inline-start',
    'padding-inline-end',
    'padding-block-start',
    'padding-block-end',
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-top-left-radius',
    'background-color',
    'font-size',
    'font-weight',
  ]

  for (const mode of ['light', 'dark']) {
    await page.evaluate((nextMode) => {
      document.documentElement.classList.remove('light', 'dark')
      document.documentElement.classList.add(nextMode)
    }, mode)
    for (const fontSize of ['100%', '200%']) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = size
      }, fontSize)
      const appearance = async (control: typeof field) =>
        control.evaluate(
          (element, names) => names.map((name) => getComputedStyle(element).getPropertyValue(name)),
          properties
        )
      await expect
        .poll(async () => {
          const actual = await appearance(field)
          const expected = await appearance(reference)
          return actual.every((value, index) => value === expected[index])
        })
        .toBe(true)
    }
  }
})

test('project form keeps native validation, submitted data, retry and async close cleanup', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create Project', exact: true })
  await expect(page.locator('#harness-root')).not.toHaveAttribute('aria-hidden', 'true')
  await dialog.getByRole('button', { name: 'Create Project', exact: true }).click()
  await expect(page.getByLabel('Requests')).toHaveText('[]')
  await dialog.getByLabel('Project name', { exact: true }).fill('New project')
  await dialog.getByLabel('Icon key', { exact: true }).fill('study')
  await dialog.getByRole('button', { name: 'Create Project', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Project could not be created. Check the fields and retry.'
  )
  await expect(page.getByLabel('Requests')).toHaveText('[{"iconKey":"study","name":"New project"}]')
  await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue('New project')
  // Change the scripted service result without interacting with inert background UI.
  await page.evaluate(() => (document.querySelector('#allow-success') as HTMLButtonElement).click())
  await dialog.getByRole('button', { name: 'Create Project', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#harness-root')).not.toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('#preexisting-inert')).toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: 'Open edit', exact: true })).toBeEnabled()
})

test('shared project modal dismisses and reopens without stale background containment', async ({
  page,
}) => {
  const opener = page.getByRole('button', { name: 'Open project', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Create Project', exact: true })
  await expect(dialog).toBeVisible()
  await expect(page.locator('#harness-root')).toHaveAttribute('inert', '')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#preexisting-inert')).toHaveAttribute('inert', '')
  await expect(opener).toBeFocused()
  await opener.click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#harness-root')).not.toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('#preexisting-inert')).toHaveAttribute('inert', '')
  await expect(opener).toBeFocused()
})

test('shared project modal keeps its content and close action contained in a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create Project', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS('overflow', 'auto')
  const positioner = dialog.locator('xpath=..')
  await expect(positioner).toHaveCSS('position', 'fixed')
  await expect(positioner).toHaveCSS('display', 'grid')
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(Math.abs(bounds!.x + bounds!.width / 2 - 160)).toBeLessThanOrEqual(1)
  const geometry = await dialog.evaluate((element) => {
    const positionerElement = element.parentElement!
    const dialogStyle = getComputedStyle(element)
    const positionerStyle = getComputedStyle(positionerElement)
    const positionerBounds = positionerElement.getBoundingClientRect()
    const visualViewport = window.visualViewport
    return {
      dialog: {
        x: element.getBoundingClientRect().x,
        y: element.getBoundingClientRect().y,
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        placeSelf: dialogStyle.placeSelf,
        transform: dialogStyle.transform,
        transformOrigin: dialogStyle.transformOrigin,
        maxHeight: dialogStyle.maxHeight,
        minHeight: dialogStyle.minHeight,
        position: dialogStyle.position,
        inset: dialogStyle.inset,
      },
      positioner: {
        x: positionerBounds.x,
        y: positionerBounds.y,
        width: positionerBounds.width,
        height: positionerBounds.height,
        position: positionerStyle.position,
        placeItems: positionerStyle.placeItems,
        padding: positionerStyle.padding,
        transform: positionerStyle.transform,
        inset: positionerStyle.inset,
      },
      viewport: {
        width: innerWidth,
        height: innerHeight,
        documentHeight: document.documentElement.clientHeight,
        scrollY,
        visualWidth: visualViewport?.width,
        visualHeight: visualViewport?.height,
        visualOffsetTop: visualViewport?.offsetTop,
      },
      body: {
        x: document.body.getBoundingClientRect().x,
        y: document.body.getBoundingClientRect().y,
        width: document.body.getBoundingClientRect().width,
        height: document.body.getBoundingClientRect().height,
        transform: getComputedStyle(document.body).transform,
      },
    }
  })
  expect(
    Math.abs(bounds!.y + bounds!.height / 2 - 284),
    JSON.stringify(geometry)
  ).toBeLessThanOrEqual(1)
  expect(bounds!.x).toBeGreaterThanOrEqual(16)
  expect(bounds!.y).toBeGreaterThanOrEqual(16)
  expect(bounds!.width).toBeLessThanOrEqual(288)
  expect(bounds!.height).toBeLessThanOrEqual(536)
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toBeInViewport()
  await close.click()
  await expect(dialog).toHaveCount(0)
})

test('edit, rename and group forms retain initial values and native label associations', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Allow success', exact: true }).click()
  await page.getByRole('button', { name: 'Open edit', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Edit Study', exact: true })
  await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue('Study')
  await dialog.getByLabel('Project name', { exact: true }).fill('Renamed project')
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Open rename', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Rename conversation', exact: true })
  await expect(dialog.getByLabel('Conversation name')).toHaveValue('Original')
  await dialog.getByLabel('Conversation name').fill('New title')
  await dialog.getByRole('button', { name: 'Save title', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Open group', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'New group conversation', exact: true })
  await dialog.getByLabel('Conversation name').fill('Team')
  await dialog.getByRole('button', { name: 'Create conversation', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByLabel('Requests')).toHaveText(
    '[{"iconKey":"study","name":"Renamed project"},"New title","Team"]'
  )
})

test('about dialog keeps its accessible name and product identity on the shared composite', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Open about', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'About Adea', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Adea', exact: true })).toBeVisible()
  await expect(dialog.locator('img[src="/icon.svg"]')).toBeAttached()
  await expect(dialog.getByText('Version 0.61.7', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Copyright © 2026 0xPlayerOne')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy version info' })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'View source' })).toHaveAttribute(
    'href',
    'https://github.com/adea-ai/adea'
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#harness-root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#preexisting-inert')).toHaveAttribute('inert', '')
})
