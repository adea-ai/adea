// WCAG 2.2 AA automated accessibility audit for the Dev View and workspace
// surfaces (#426 / #541 acceptance: "Accessibility audit meets WCAG 2.2 AA").
//
// The lane drives the real served app with Playwright, injects axe-core, and
// scans the guest-reachable surfaces the M12 owner journey crosses: the chat
// workspace, the Dev View (including the integrated terminal pane, in the
// deterministic `devE2e=preserved` fixture mode), the narrow-viewport Dev View
// layout, and the Settings dialog with every tab (including Permissions).
//
// Scope note: this is automated axe coverage only — the accepted v1 evidence
// for the M12 gate. Manual screen-reader/keyboard certification stays a
// recorded gap; violations are recorded with impact and repro selectors and
// each class is tracked as its own GitHub issue.
//
// Boot the dev server exactly like the E2E lane does, then run this lane:
//   cd apps/web && DATABASE_URL=… PORT=3123 bun run dev
//   bun scripts/audit-a11y-dev-view.mjs \
//     --base-url http://127.0.0.1:3123 \
//     --artifact artifacts/a11y/axe-dev-view.json
//
// Exit codes: 0 = audit completed (findings are evidence, not lane failure);
// 1 = lane/infrastructure failure; 2 = completed with `--strict` and at least
// one serious/critical violation remains.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
// `@playwright/test` is the workspace's pinned Playwright entry point; its
// chromium re-export keeps the audit on the same browser build as the E2E lane.
const { chromium } = require('@playwright/test')

/** WCAG 2.x levels A through AA, including the 2.2 additions axe tags. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/** Highest number of failing-node selectors recorded per violation. */
const MAX_NODES_PER_VIOLATION = 5

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor', null]

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function runAxe(page, label, options = {}) {
  const result = await page.evaluate(
    ({ tags, scopeSelector }) => {
      const context = scopeSelector ? document.querySelector(scopeSelector) : document
      if (!context) return { error: `scope not found: ${scopeSelector}` }
      return window.axe.run(context, {
        runOnly: { type: 'tag', values: tags },
        resultTypes: ['violations'],
      })
    },
    { tags: WCAG_TAGS, scopeSelector: options.scopeSelector ?? null }
  )
  if (result.error) throw new Error(`${label}: ${result.error}`)

  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? null,
    help: violation.help,
    wcag: violation.tags.filter((tag) => tag.startsWith('wcag')),
    nodes: violation.nodes.slice(0, MAX_NODES_PER_VIOLATION).map((node) => ({
      target: node.target,
      html: node.html.slice(0, 300),
    })),
    nodeCount: violation.nodes.length,
  }))

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  for (const violation of violations) {
    if (violation.impact && counts[violation.impact] !== undefined)
      counts[violation.impact] += violation.nodeCount
  }
  return { surface: label, url: page.url(), violationCount: violations.length, counts, violations }
}

/** axe injects per document: every `goto` needs a fresh injection. */
async function injectAxe(page, axeBundle) {
  if (!existsSync(axeBundle)) throw new Error(`axe-core bundle not found at ${axeBundle}`)
  await page.addScriptTag({ path: axeBundle })
  await page.evaluate(() => window.axe)
}

async function gotoAndWait(page, path, readySelector, axeBundle) {
  await page.goto(path)
  await page.locator(readySelector).first().waitFor({ state: 'visible', timeout: 60_000 })
  // Give lazy panes a moment to mount so axe sees the settled surface; the
  // wait is bounded so a chatty HMR socket cannot stall the lane.
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {})
  await injectAxe(page, axeBundle)
}

async function main() {
  const baseUrl = argValue('--base-url', 'http://127.0.0.1:3123').replace(/\/$/, '')
  const artifactPath = argValue('--artifact', 'artifacts/a11y/axe-dev-view.json')
  const strict = process.argv.includes('--strict')
  const headless = process.env.PLAYWRIGHT_HEADLESS !== '0'

  const axeBundle = resolve(dirname(require.resolve('axe-core')), 'axe.min.js')
  const axeVersion = require('axe-core/package.json').version

  const results = []
  const startedAt = new Date().toISOString()
  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  try {
    // Surface 1 — chat workspace (the default view, guest mode).
    await gotoAndWait(page, `${baseUrl}/?view=chat`, 'main', axeBundle)
    results.push(await runAxe(page, 'chat'))

    // Surface 2 — Dev View with the integrated terminal pane (fixture mode).
    await gotoAndWait(page, `${baseUrl}/?view=dev&devE2e=preserved`, 'main', axeBundle)
    await page
      .getByRole('region', { name: 'Developer workspace panes' })
      .waitFor({ state: 'visible', timeout: 60_000 })
    await page
      .getByRole('region', { name: /Integrated terminal/ })
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
    results.push(await runAxe(page, 'dev-view-terminal'))

    // Surface 3 — Dev View at the narrow end of the viewport matrix, sidebar
    // visible. The narrow layout may start with the sidebar collapsed.
    await page.setViewportSize({ width: 320, height: 900 })
    const sidebar = page.getByRole('complementary', { name: 'Projects and sessions' })
    if (!(await sidebar.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Toggle projects sidebar' }).click()
    }
    await sidebar.waitFor({ state: 'visible', timeout: 15_000 })
    results.push(await runAxe(page, 'dev-view-narrow-320'))

    // Surface 4 — Settings dialog, every rendered tab, including Permissions.
    // Scoped to the dialog so findings name the settings surface, not the page
    // behind it (already covered above).
    //
    // Interaction defect observed while automating this (#filed): clicking the
    // already-selected "Account & app" tab trigger dismisses the whole dialog,
    // so the lane audits the selected tab as rendered and only clicks the
    // other tab triggers. The dialog can also dismiss mid-scan, so each step
    // re-opens it when needed instead of failing the lane.
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoAndWait(page, `${baseUrl}/?view=chat`, 'main', axeBundle)
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const openSettings = async () => {
      await page.getByRole('button', { name: 'User settings' }).click()
      await page.getByRole('menuitem', { name: 'Settings' }).click()
      await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    }
    await openSettings()
    const auditSettingsTab = async (name) => {
      const tab = dialog.getByRole('tab', { name })
      const selected = (await tab.getAttribute('aria-selected')) === 'true'
      if (!selected) await tab.click()
      await page.waitForTimeout(400)
      if (!(await dialog.isVisible().catch(() => false))) {
        await openSettings()
        if (!selected) await dialog.getByRole('tab', { name }).click()
        await page.waitForTimeout(400)
      }
      results.push(
        await runAxe(page, `settings/${slug(name)}`, { scopeSelector: '[role="dialog"]' })
      )
    }
    const tabLocators = await dialog.getByRole('tab').all()
    const renderedTabs = []
    for (const tab of tabLocators) renderedTabs.push((await tab.textContent())?.trim() ?? '')
    for (const name of renderedTabs.filter(Boolean)) await auditSettingsTab(name)
  } finally {
    await browser.close()
  }

  const completedAt = new Date().toISOString()
  const totals = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  const ruleClasses = new Map()
  for (const entry of results) {
    for (const impact of IMPACT_ORDER) {
      if (impact && entry.counts[impact]) totals[impact] += entry.counts[impact]
    }
    for (const violation of entry.violations) {
      const existing = ruleClasses.get(violation.id)
      if (!existing) {
        ruleClasses.set(violation.id, {
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          wcag: violation.wcag,
          nodeCount: violation.nodeCount,
          surfaces: [entry.surface],
        })
      } else {
        existing.nodeCount += violation.nodeCount
        if (!existing.surfaces.includes(entry.surface)) existing.surfaces.push(entry.surface)
      }
    }
  }
  const ruleList = [...ruleClasses.values()].toSorted(
    (a, b) =>
      IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) || a.id.localeCompare(b.id)
  )
  const blocking = totals.critical + totals.serious

  const artifact = {
    schemaVersion: 1,
    lane: 'audit-a11y-dev-view',
    issue: '#426/#541',
    standard:
      'WCAG 2.2 AA (automated axe-core coverage; manual assistive-technology audit out of scope)',
    tags: WCAG_TAGS,
    axeVersion,
    baseUrl,
    startedAt,
    completedAt,
    surfaces: results.map((entry) => ({
      surface: entry.surface,
      url: entry.url,
      counts: entry.counts,
      violations: entry.violations,
    })),
    totals,
    violationClasses: ruleList,
    strict,
    blockingViolations: blocking,
  }

  mkdirSync(resolve(artifactPath, '..'), { recursive: true })
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)

  console.log(`A11Y-AXE ${blocking > 0 ? 'FINDINGS' : 'CLEAN'}`)
  console.log(`artifact: ${artifactPath}`)
  for (const entry of results) {
    const summary = IMPACT_ORDER.filter((impact) => impact && entry.counts[impact])
      .map((impact) => `${entry.counts[impact]} ${impact}`)
      .join(', ')
    console.log(
      `${entry.surface}: ${entry.violationCount} violation rule(s)${summary ? ` — ${summary}` : ''}`
    )
  }
  console.log(`totals: ${JSON.stringify(totals)}`)
  for (const rule of ruleList)
    console.log(
      `class: [${rule.impact ?? 'unknown'}] ${rule.id} — ${rule.help} (${rule.nodeCount} node(s) across ${rule.surfaces.join(', ')})`
    )

  if (strict && blocking > 0) return 2
  return 0
}

process.exit(await main())
