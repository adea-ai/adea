// Deterministic pixel-capture helpers for the visual lanes.
//
// `expect(...).toHaveScreenshot(..., { animations: 'disabled' })` fast-forwards
// the animations Playwright finds when a capture starts, but a CSS transition
// that begins after that scan — a Solid effect flipping the global-rail
// buttons' `transition-all` classes right after load, for example — is caught
// mid-interpolation. Merged PRs #504/#514/#516/#518 failed the Workspace
// visual lane with 74–591 px diffs on exactly those sidebar icons while the
// identical code passed locally. Waiting for `transitionend` cannot close that
// race, because a transition can always begin after the last observed end
// event, so the visual lane forbids transitions outright instead of racing
// them. A transition never changes a resting frame, so committed baselines
// stay valid: every capture simply shows the final state.
import { test as base, expect, type Page } from '@playwright/test'

const TRANSITION_SUPPRESSION = '*, *::before, *::after { transition-property: none !important; }'

/**
 * Renders every document this page loads — including reloads and client-side
 * navigations — without CSS transitions. Must be installed before the first
 * navigation so no document can animate.
 */
export async function disableTransitions(page: Page): Promise<void> {
  await page.addInitScript((css: string) => {
    // Init scripts run before the document element exists, so retry once the
    // document can host a style element.
    let installed = false
    const install = () => {
      if (installed) return
      const root = document.head ?? document.documentElement
      if (!root) return
      installed = true
      const style = document.createElement('style')
      style.textContent = css
      root.append(style)
    }
    install()
    document.addEventListener('DOMContentLoaded', install, { once: true })
  }, TRANSITION_SUPPRESSION)
}

// Visual-lane `test`: pixel captures never race a transition because none can
// start. Flow-only specs keep the plain `@playwright/test` entry points.
export const test = base.extend({
  page: async ({ page }, use) => {
    await disableTransitions(page)
    await use(page)
  },
})

export { expect }
export type { Page }
