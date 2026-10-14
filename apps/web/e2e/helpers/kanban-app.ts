import type { Page } from '@playwright/test'

/**
 * Kanban is an optional app: only Virtual, Chat and Dev are enabled by
 * default. Specs that open `app=kanban` seed the preference the person writes
 * when they enable it from the App Library. Register this after the spec's
 * own storage reset so the seed survives it, and before the first navigation;
 * a preference the spec already wrote (a reload after reordering) is kept.
 */
export async function enableKanbanApp(page: Page) {
  await page.addInitScript(() => {
    const key = 'adea:rail-preferences:v1'
    try {
      if (localStorage.getItem(key) !== null) return
      localStorage.setItem(
        key,
        JSON.stringify({ version: 1, order: ['virtual', 'chat', 'dev', 'kanban'], hidden: [] })
      )
    } catch {
      // Storage is unavailable; the spec fails on the missing app instead.
    }
  })
}
