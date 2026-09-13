import { test } from '@playwright/test'

test('probe draft retention', async ({ page }) => {
  const messages: string[] = []
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') messages.push(`console: ${message.text()}`)
  })
  await page.goto('/?view=chat')
  await page.waitForTimeout(4000)
  const before = await page.evaluate(() => ({
    stored: localStorage.getItem('adea:conventional-workspace:v2'),
    channel: document.querySelector('.conventional-conversation__identity h1')?.textContent,
    composer: document.querySelector('[id^="composer-"]')?.id,
  }))
  console.log('--- initial ---')
  console.log(JSON.stringify(before, null, 1))
  const textarea = page.getByRole('textbox', { name: 'Message' })
  await textarea.fill('keep me')
  await page.waitForTimeout(1500)
  const afterFill = await page.evaluate(() => localStorage.getItem('adea:conventional-workspace:v2'))
  console.log('--- after fill ---')
  console.log(afterFill)
  const people = await page.getByRole('button', { name: 'Research Agent', exact: true }).count()
  console.log('research agent buttons', people)
  console.log('--- errors ---')
  for (const message of messages.slice(0, 10)) console.log(message)
})
