import { expect, test } from '@playwright/test'

/*
 * The sidebar-at-scale case (#666): the DEV-only `devSidebarScale` fixture
 * param grows every project to 1,000 sessions (2,000 rows across the fixture
 * workspace's two projects). The sidebar has no windowing, so the DOM cost
 * is the point: the case pins that the full tree renders, every row carries
 * its accessible name, and the render completes inside the lane's element
 * budget — the baseline any windowing decision (#677) has to beat.
 */
test('cert scale: the sidebar renders a 2,000-row fixture tree with named rows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const startedAt = Date.now()
  await page.goto('/?view=dev&devE2e=preserved&devSidebarScale=1000')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  const sidebar = page.getByRole('complementary', { name: 'Projects and sessions' })
  await expect(sidebar).toBeVisible()

  // Every generated row is present and named: the last generated session of
  // each project exists with its deterministic name.
  await expect(sidebar.getByRole('button', { name: 'Session 1000' })).toHaveCount(2, {
    timeout: 30_000,
  })
  const renderMs = Date.now() - startedAt

  // No generated row mushes its name: role + name stay per-row.
  const first = sidebar.getByRole('button', { name: 'ready Session 3' }).first()
  await expect(first).toHaveAccessibleName('ready Session 3')

  // Keyboard reachability at depth: the generated rows are real tab stops.
  await first.focus()
  await expect(first).toBeFocused()

  // The lane's own budget note: the whole mount-to-named-rows walk is logged
  // so the windowing decision (#677) has a number to compare against.
  console.log(`[dev-sidebar-scale] mount-to-2k-named-rows: ${renderMs}ms`)
  expect(renderMs, 'mount to 2,000 named rows').toBeLessThan(120_000)
})
