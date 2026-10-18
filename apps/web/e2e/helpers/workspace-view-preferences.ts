import type { Page } from '@playwright/test'

/** Returning-user fixture: optional-view suites explicitly retain their views.
 * Fresh-install coverage must not install this fixture. Existing records win. */
export async function retainOptionalWorkspaceViews(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const key = 'adea:rail-preferences:v1'
    if (localStorage.getItem(key) !== null) return
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, order: ['virtual', 'chat', 'dev', 'kanban'], hidden: [] })
    )
  })
}
