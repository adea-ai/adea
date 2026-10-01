import { chromium } from '@playwright/test'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 150)))
await page.goto('http://127.0.0.1:3115/?view=chat&scene=work', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForSelector('[aria-label="Appearance settings"]', { timeout: 60_000 })
await page.waitForTimeout(2000)
await page.click('[aria-label="Appearance settings"]')
await page.waitForTimeout(1500)
const probe = await page.evaluate(async () => {
  const light = document.querySelector('[role="radiogroup"] span')
  let mutations = 0
  const obs = new MutationObserver((m) => { mutations += m.length })
  const group = document.querySelector('[role="radiogroup"]')
  obs.observe(group ?? document.body, { childList: true, subtree: true })
  const before = light ? light.getBoundingClientRect().top : -1
  await new Promise((r) => setTimeout(r, 2000))
  const after = light ? light.getBoundingClientRect().top : -1
  return { mutations, stable: before === after, dialogs: document.querySelectorAll('[role="dialog"]').length }
})
console.log(JSON.stringify({ ...probe, errors: errors.slice(0, 4) }, null, 2))
await browser.close()
