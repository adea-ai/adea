import { expect, test, type Locator, type Page } from '@playwright/test'

async function exerciseContextualSidebarToggle(page: Page) {
  // The toggle renames between its expand and collapse variants the moment
  // the store flips, so every locator uses the variant-agnostic anchored
  // name and reads the store's answer from aria-expanded — never from which
  // label happens to be live at retry time.
  const toggle = page.getByRole('button', { name: /^(Expand|Collapse) contextual sidebar$/ })
  const closeSheet = page.getByRole('button', { name: 'Close', exact: true })
  const openSheetDialog = page.locator('[role="dialog"][data-expanded]')
  const projectsSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })

  // Boot responses and the sheet's close/focus-restoration transition can
  // replace the toggle node between hit-testing and its handler running (the
  // same lost-click race the workspace-navigation spec documents for its
  // press), so the open interaction retries until aria-expanded answers.
  // Each click is bounded to the probe interval: a landed click renames the
  // toggle immediately, and an unbounded retry would wait the whole timeout
  // against the renamed-away label.
  // Failure diagnostics for the loaded-runner signature: when the button
  // probe exhausts, report whether the toggle is missing, present behind the
  // open sheet's aria-hidden modal, or present and reading a stale state —
  // this lands in the lane log and names the mechanism definitively.
  const logToggleState = async (phase: string) => {
    console.error(
      `[contextual-toggle-diag] ${phase}: ${JSON.stringify(
        await page.evaluate(() => {
          const node = document.querySelector('button[aria-label*="contextual sidebar"]')
          return {
            toggle: node ? node.outerHTML.slice(0, 140) : null,
            ariaExpanded: node?.getAttribute('aria-expanded') ?? null,
            behindModal: Boolean(node?.closest('[aria-hidden="true"], [inert]')),
            openSheetDialog: document.querySelector('[role="dialog"][data-expanded]') !== null,
          }
        })
      )}`
    )
  }

  const openSheet = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await toggle.click({ timeout: 2_000 }).catch(() => undefined)
      // The state signal: the open sheet's dialog. The toolbar behind the
      // modal can be aria-hidden on loaded runners, which makes every button
      // probe report the toggle gone exactly while the sheet is up — the
      // dialog attribute cannot churn with toolbar re-renders.
      try {
        await expect(openSheetDialog).toBeVisible({ timeout: 2_000 })
        return
      } catch {
        const observed = await page
          .evaluate(() => {
            const node = document.querySelector('button[aria-label*="contextual sidebar"]')
            return {
              toggle: node ? node.outerHTML.slice(0, 120) : null,
              ariaExpanded: node?.getAttribute('aria-expanded') ?? null,
              behindModal: Boolean(node?.closest('[aria-hidden="true"], [inert]')),
              openSheetDialog: document.querySelector('[role="dialog"][data-expanded]') !== null,
            }
          })
          .catch(() => 'evaluate-failed')
        console.error(`[contextual-toggle-diag] attempt ${attempt}: ${JSON.stringify(observed)}`)
      }
    }
    await logToggleState('open probe exhausted')
    await expect(openSheetDialog).toBeVisible()
  }

  if (await toggle.isVisible()) {
    // Branch on the store's answer, not the label: the collapsed contract
    // (modal sheet dance) applies whenever the store reports closed, at any
    // viewport; an already-expanded sidebar — inline at wide widths — only
    // owes the visibility assertion.
    if ((await toggle.getAttribute('aria-expanded')) !== 'false') {
      await expect(projectsSidebar).toBeVisible()
      return
    }
    await expect(projectsSidebar).toBeHidden()
    // Narrow widths present the contextual sidebar as the shared modal sheet:
    // the global toggle goes inert while the sheet is up, and the sheet's own
    // close returns focus to the opener.
    await openSheet()
    await expect(projectsSidebar).toBeVisible()
    // The close chrome unmounts with the sheet; bound it like the open click
    // and let the hidden assertion decide. Focus and aria-expanded assertions
    // wait until after the sheet is down: behind the open modal the toolbar
    // probe is the one that lies.
    await closeSheet.click({ timeout: 2_000 }).catch(() => undefined)
    await expect(openSheetDialog).toBeHidden()
    await expect(projectsSidebar).toBeHidden()
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await openSheet()
    await expect(projectsSidebar).toBeVisible()
    await closeSheet.click({ timeout: 2_000 }).catch(() => undefined)
    await expect(openSheetDialog).toBeHidden()
    await expect(projectsSidebar).toBeHidden()
    await expect(toggle).toBeFocused()
  } else {
    await expect(projectsSidebar).toBeVisible()
  }
}

/** A Dev sidebar leaf (checkout or worktree) by the branch it shows. */
function devLeaf(scope: Page | Locator, branch: string) {
  return scope.getByRole('treeitem', { name: new RegExp(branch.replaceAll('/', '\\/')) })
}

/** A Dev sidebar project row by its name. */
function devProjectRow(scope: Page | Locator, name: string) {
  return scope.locator('[role="treeitem"][data-project-id]').filter({ hasText: name })
}

function devToolbarControl(page: Page, name: string) {
  return page.locator('.workspace-topbar__view-actions').getByRole('button', { name, exact: true })
}

function devLeftUtilityToggle(page: Page) {
  return devToolbarControl(page, 'Collapse left utility sidebar').or(
    devToolbarControl(page, 'Expand left utility sidebar')
  )
}

async function toggleDevLeftUtility(page: Page) {
  await devLeftUtilityToggle(page).click()
}

/** The bundled utility sidebar's toggle rides the top bar's trailing mount. */
function devSidebarControl(page: Page, name: string) {
  return page.locator('.workspace-topbar__sidebar').getByRole('button', { name, exact: true })
}

async function expectPointerHitsButton(page: Page, button: Locator, name: string) {
  const buttonBounds = await button.boundingBox()
  expect(buttonBounds).not.toBeNull()
  const hitTest = await page.evaluate(
    ({ x, y }) => {
      const describe = (element: Element | null) => {
        if (!(element instanceof HTMLElement)) return null
        const elementBounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const buttonName =
          element.getAttribute('aria-label') ??
          (element instanceof HTMLButtonElement ? element.textContent?.trim() : null)
        return {
          tag: element.tagName.toLowerCase(),
          name: buttonName?.slice(0, 80) ?? null,
          className: element.className,
          rect: {
            x: elementBounds.x,
            y: elementBounds.y,
            width: elementBounds.width,
            height: elementBounds.height,
          },
          containsProbePoint:
            x >= elementBounds.left &&
            x <= elementBounds.right &&
            y >= elementBounds.top &&
            y <= elementBounds.bottom,
          position: style.position,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
          display: style.display,
          gridTemplateColumns: style.gridTemplateColumns,
          alignItems: style.alignItems,
          justifyItems: style.justifyItems,
        }
      }
      const hitButton = document.elementFromPoint(x, y)?.closest('button') ?? null
      return {
        hitName: hitButton?.getAttribute('aria-label') ?? hitButton?.textContent?.trim() ?? null,
        point: { x, y },
        viewport: { width: innerWidth, height: innerHeight },
        frame: describe(document.querySelector('.workspace-frame')),
        topbar: describe(document.querySelector('[data-workspace-topbar]')),
        surface: describe(document.querySelector('.workspace-frame__surface')),
        workspace: describe(document.querySelector('.dev-workspace')),
        devToolbar: describe(document.querySelector('.dev-toolbar')),
        devActions: describe(document.querySelector('.dev-toolbar__actions')),
        browserButton: describe(
          document.querySelector('button[aria-label="Expand utility sidebar"]')
        ),
        hitStack: document.elementsFromPoint(x, y).slice(0, 8).map(describe),
      }
    },
    {
      x: buttonBounds!.x + buttonBounds!.width / 2,
      y: buttonBounds!.y + buttonBounds!.height / 2,
    }
  )
  expect(hitTest.hitName, JSON.stringify(hitTest)).toBe(name)
}

async function requireBounds(locator: Locator, name: string) {
  const bounds = await locator.boundingBox()
  expect(bounds, `${name} should have a visible bounding box`).not.toBeNull()
  if (bounds === null) throw new Error(`${name} has no bounding box`)
  return bounds
}

async function expectDevToolbarHost(page: Page, width: number) {
  const host = page.locator('.workspace-topbar__view-actions')
  await expect(host).toBeVisible()
  await expect(devLeftUtilityToggle(page)).toBeVisible()
  await expect(devToolbarControl(page, 'Split pane')).toBeVisible()
  await expect(devToolbarControl(page, 'Reopen closed pane')).toBeVisible()
  // Close-all is a wide-shell convenience: below the shared 48rem breakpoint
  // the top bar has no room for a fourth pane action, and the per-pane close
  // carries the work.
  await expect(devToolbarControl(page, 'Close all panes')).toHaveCount(width > 768 ? 1 : 0)
  // Runtime resources lives in the top bar on every view; the Dev entry no
  // longer carries its own copy, and the expand control is per panel. The
  // sidebar toggle's label tracks the restored slot state, so either name is
  // a mounted toggle.
  await expect(page.getByRole('button', { name: 'Runtime resources', exact: true })).toHaveCount(1)
  await expect(
    devSidebarControl(page, 'Expand utility sidebar').or(
      devSidebarControl(page, 'Collapse utility sidebar')
    )
  ).toBeVisible()
  await expect(page.locator('.dev-toolbar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toHaveCount(0)
}

for (const width of [320, 768, 1280, 1920]) {
  test(`Dev View shell remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?view=dev&devE2e=preserved')
    await expect(page.getByRole('button', { name: 'Dev view', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 20_000 }
    )
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible()
    await expectDevToolbarHost(page, width)
    await expect(page).toHaveURL(/devE2e=preserved/)

    if (width <= 768) {
      await exerciseContextualSidebarToggle(page)
      const utilitiesToggle = devSidebarControl(page, 'Expand utility sidebar')
      await utilitiesToggle.click()
      await expect(
        page.getByRole('complementary', { name: 'Shared developer utilities' })
      ).toBeVisible()
    } else {
      await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
    }
  })
}

test('Dev mobile sidebar closes after leaf selection and restores the global opener', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?view=dev&devE2e=preserved&devProject=fixture-adea&devSession=fixture-shell')
  await expect(page.getByRole('button', { name: 'Dev view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 20_000 }
  )

  const rail = page.locator('[data-global-rail]')
  const opener = page
    .getByLabel('Workspace toolbar')
    .getByRole('button', { name: 'Expand contextual sidebar', exact: true })
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })

  await expect(rail).toHaveCount(1)
  await expect(rail).toBeVisible()
  await opener.press('Enter')

  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  await expect(sidebar).toBeVisible()
  await expect(rail).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1)

  // Selecting another project's checkout opens its session, closes the
  // mobile sheet and returns focus to the global opener.
  await devLeaf(sidebar, 'feature/runtime').click()
  await expect(sidebar).not.toBeVisible()
  await expect(rail).toBeVisible()
  await expect(opener).toBeFocused()

  // Collapsing and expanding a project is disclosure only: the sheet stays.
  await opener.press('Enter')
  await expect(sidebar).toBeVisible()
  const project = devProjectRow(sidebar, 'Runtime tools')
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await project.click()
  await expect(project).toHaveAttribute('aria-expanded', 'false')
  await project.click()
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebar).toBeVisible()
  await expect(devLeaf(sidebar, 'feature/runtime')).toHaveAttribute('aria-selected', 'true')

  await devLeaf(sidebar, 'feature/example').click()
  await expect(sidebar).not.toBeVisible()
  await expect(rail).toBeVisible()
  await expect(opener).toBeFocused()
})

test('the global shell owns exactly one right utility host across Dev, Chat, and Virtual', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const host = page.getByRole('complementary', { name: 'Shared developer utilities' })
  const toolbar = page.getByLabel('Workspace toolbar')
  for (const view of ['Dev', 'Chat', 'Virtual', 'Dev']) {
    await rail.getByRole('button', { name: `${view} view`, exact: true }).click()
    await expect(rail).toBeVisible()
    const expand = toolbar.getByRole('button', { name: 'Expand utility sidebar', exact: true })
    if (await expand.isVisible()) await expand.click()
    await expect(host).toHaveCount(1)
    await expect(host).toBeVisible()
    await expect(host.getByRole('heading', { name: 'Browser', exact: true })).toBeVisible()
    await expect(
      toolbar.getByRole('button', { name: 'Collapse utility sidebar', exact: true })
    ).toHaveCount(1)
    // Every main view mounts the same slot beside its view, rather than nesting
    // a second utility host inside the Dev center.
    await expect(page.locator('.dev-workspace .dev-utility--right')).toHaveCount(0)
    await expect(
      page.locator('.workspace-contextual-utility-frame > .dev-utility--right')
    ).toHaveCount(1)
  }
})

async function expectDevTopbarBoundary(page: Page, width: number) {
  const navigation = page.locator('[data-topbar-navigation]')
  const divider = navigation.locator('[data-topbar-view-divider]')
  const actionGroup = devToolbarControl(page, 'Split pane').locator('..').locator('..')
  const rightUtilityToggle = devSidebarControl(page, 'Expand utility sidebar')
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const rail = page.locator('[data-global-rail]')

  const assertBoundary = async (boundary: Locator) => {
    const leadingControls = [
      navigation.getByRole('button', { name: 'Back', exact: true }),
      navigation.getByRole('button', { name: 'Forward', exact: true }),
      navigation.getByRole('button', { name: /^(Collapse|Expand) contextual sidebar$/ }),
    ]
    const [dividerBounds, boundaryBounds, actionBounds, rightBounds, ...controlBounds] =
      await Promise.all([
        requireBounds(divider, 'Dev action divider'),
        requireBounds(boundary, 'Sidebar boundary'),
        requireBounds(actionGroup, 'Dev action group'),
        requireBounds(rightUtilityToggle, 'Trailing utility toggle'),
        ...leadingControls.map((control, index) =>
          requireBounds(control, `Leading navigation control ${index + 1}`)
        ),
      ])
    const leadingControlsEnd = Math.max(...controlBounds.map((bounds) => bounds.x + bounds.width))
    const sidebarEdge = boundaryBounds.x + boundaryBounds.width

    if (width > 768 && (await sidebar.isVisible())) {
      expect(Math.abs(dividerBounds.x - sidebarEdge)).toBeLessThanOrEqual(1)
    } else {
      // With the contextual sidebar collapsed or presented as a phone drawer,
      // Dev actions stay in flow after the leading controls and outer rail.
      expect(dividerBounds.x).toBeGreaterThanOrEqual(Math.max(sidebarEdge, leadingControlsEnd))
    }

    const titleBounds = await title.boundingBox()
    if (titleBounds) {
      expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(titleBounds.x)
      expect(rightBounds.x).toBeGreaterThanOrEqual(titleBounds.x + titleBounds.width)
    } else {
      expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(rightBounds.x)
    }
  }

  const title = page.locator('[data-topbar-title]')
  await title.evaluate((element) => {
    // The slot shows Workspace › Project › branch breadcrumbs when Dev has a
    // selection; lengthen the current crumb so clipping is exercised inside
    // the breadcrumb row, or the plain title when there is none.
    const target = element.querySelector('[aria-current="page"]') ?? element
    target.textContent =
      'A workspace name long enough to test title clipping without hiding toolbar actions'
  })
  if (width > 768) {
    // Wide widths keep the inline sidebar: its edge owns the boundary until
    // the collapse toggle hides it.
    await expect(sidebar).toBeVisible()
    await assertBoundary(sidebar)
    await page.getByRole('button', { name: 'Collapse contextual sidebar', exact: true }).click()
  }
  // Collapsed (or drawer-presented) sidebars leave the outer rail as the
  // boundary; Dev actions stay in flow after it.
  await assertBoundary(rail)
  await expect(sidebar).toBeHidden()
}

for (const width of [768, 1024, 1440]) {
  test(`Dev top-bar actions avoid title and utility overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?view=dev&devE2e=preserved')
    await expectDevToolbarHost(page, width)
    await exerciseContextualSidebarToggle(page)
    await expectDevTopbarBoundary(page, width)
  })
}

test('Dev title slot shows Workspace › Project › branch with the branch in mono', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  await expectDevToolbarHost(page, 1280)
  const crumbs = page.locator('[data-topbar-title]').getByRole('navigation', { name: 'Breadcrumb' })
  await expect(crumbs.getByRole('listitem')).toHaveCount(3)
  await expect(crumbs.getByRole('listitem').nth(1)).toHaveText('Project: Example project')
  const branch = crumbs.locator('[aria-current="page"]')
  await expect(branch).toHaveText('Worktree: feature/example')
  await expect(branch.locator('code')).toHaveText('feature/example')
  // Dev crumbs are a readout of the selected leaf's project and branch.
  await expect(crumbs.getByRole('link')).toHaveCount(0)

  await devLeaf(
    page.getByRole('complementary', { name: 'Workspace navigation' }),
    'feature/runtime'
  ).click()
  await expect(branch).toHaveText('Worktree: feature/runtime')
  await expect(crumbs.getByRole('listitem').nth(1)).toHaveText('Project: Runtime tools')
})

test('Dev top-bar actions preserve clear boundaries with 200% text sizing', async ({ page }) => {
  const width = 1280
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  await expectDevToolbarHost(page, width)
  await exerciseContextualSidebarToggle(page)
  await page.addStyleTag({ content: 'html { font-size: 200%; }' })
  await expectDevTopbarBoundary(page, width)
})

test('Dev shell stays usable while its central layout loads', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(/\/layout\/layout-view\.tsx(?:\?|$)/, async (route) => {
    await pending
    await route.continue()
  })
  try {
    await page.goto('/?view=dev&devE2e=preserved')
    await expect(page.getByText('Loading workspace panes…', { exact: true })).toBeVisible()
    // The harness viewport is Playwright's 1280×720 default, so close-all shows.
    await expectDevToolbarHost(page, 1280)
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const originalSidebar = await sidebar.elementHandle()
    const leaf = devLeaf(sidebar, 'feature/runtime')
    await leaf.click()
    await expect(leaf).toHaveAttribute('aria-selected', 'true')
    release()
    await expect(page.getByRole('region', { name: 'terminal pane' })).toBeVisible()
    await expect(page.getByText('Loading workspace panes…', { exact: true })).toBeHidden()
    await expect(leaf).toHaveAttribute('aria-selected', 'true')
    expect(
      await sidebar.evaluate((element, original) => element === original, originalSidebar)
    ).toBe(true)
    await originalSidebar?.dispose()
  } finally {
    release()
  }
})

test('production unavailable state does not fabricate projects or sessions', async ({ page }) => {
  await page.goto('/?view=dev')
  await expect(page.getByText('No runtime projects available.')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Example project')).toHaveCount(0)
})

test('Dev rail history, hierarchy, separator, focus, and utility controls are deterministic', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved&sentinel=keep')
  await expectDevToolbarHost(page, 1280)

  const navigationSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const runtimeCheckout = devLeaf(navigationSidebar, 'feature/runtime')
  await runtimeCheckout.click()
  await expect(runtimeCheckout).toHaveAttribute('aria-selected', 'true')
  await expect(devLeaf(navigationSidebar, 'feature/example')).toHaveAttribute(
    'aria-selected',
    'false'
  )

  // Workspace › project › checkout/worktrees: the checkout leads its project.
  const runtimeProject = devProjectRow(navigationSidebar, 'Runtime tools')
  await expect(runtimeProject).toHaveAttribute('aria-level', '1')
  await expect(runtimeCheckout).toHaveAttribute('aria-level', '2')
  await expect(runtimeCheckout).toHaveAttribute('data-leaf-kind', 'checkout')
  await expect(devLeaf(navigationSidebar, 'docs/runtime-notes')).toHaveAttribute(
    'data-leaf-kind',
    'worktree'
  )
  await runtimeProject.click()
  await expect(runtimeProject).toHaveAttribute('aria-expanded', 'false')
  await runtimeProject.click()
  await expect(runtimeProject).toHaveAttribute('aria-expanded', 'true')
  await expect(runtimeCheckout).toHaveAttribute('aria-selected', 'true')

  // Projects are a flat list (no groups); the collapsed project survives the
  // view switch below.
  await runtimeProject.click()
  await expect(runtimeProject).toHaveAttribute('aria-expanded', 'false')

  await expect(page.locator('[data-pane-id]')).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'editor pane' })).toHaveCount(0)
  const splitPane = page.getByRole('button', { name: 'Split pane', exact: true })
  await expectPointerHitsButton(page, splitPane, 'Split pane')
  await splitPane.click()
  // Splitting retains the focused pane's kind (docs/specs/dev-runtime.md), so
  // splitting the lone terminal yields a second terminal, not an editor.
  await expect(page.getByRole('region', { name: 'terminal pane' })).toHaveCount(2)
  await expect(page.getByRole('region', { name: 'editor pane' })).toHaveCount(0)
  const separator = page.getByRole('separator', { name: 'Resize workspace panes' })
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '55')

  await page.getByRole('button', { name: 'Split pane' }).click()
  await expect(page.getByRole('separator', { name: 'Resize workspace panes' })).toHaveCount(2)
  // The balanced automatic split recomputes ratios (docs/specs/dev-runtime.md),
  // so the parked 55% row gives way to equal shares; the resize below proves a
  // user ratio survives a view switch after the last structural change.
  await page.getByRole('button', { name: 'Close terminal pane' }).last().click()
  await expect(page.locator('[data-pane-id]')).toHaveCount(2)
  // Closing the trailing pane returns focus to the surviving neighbour.
  await expect(page.locator('[data-pane-id="dev-pane-1"]')).toBeFocused()
  await expect(page.getByRole('button', { name: 'Reopen closed pane' })).toBeEnabled()
  await page.getByRole('button', { name: 'Reopen closed pane' }).click()
  await expect(page.getByRole('separator', { name: 'Resize workspace panes' })).toHaveCount(2)
  const centerSeparators = page.getByRole('separator', { name: 'Resize workspace panes' })
  // The balanced grid stacks a column root over the row branch; horizontal
  // handles are the row's ArrowLeft/ArrowRight surface.
  const rowSeparator = centerSeparators.and(page.locator('[data-orientation="horizontal"]'))
  await rowSeparator.focus()
  await page.keyboard.press('ArrowRight')
  await expect(rowSeparator).toHaveAttribute('aria-valuenow', '55')

  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  const projectsSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const leftUtilities = page.getByRole('complementary', { name: 'Developer utilities (left)' })
  await expect(globalNavigation).toBeVisible()
  await expect(projectsSidebar).toBeVisible()
  await expect(leftUtilities).toBeVisible()

  // Focus mode has no top-bar control — expanding is a per-panel concern —
  // so the keyboard chord is the surface under test here.
  await page.keyboard.press('ControlOrMeta+Shift+F')
  await expect(globalNavigation).toBeVisible()
  await expect(projectsSidebar).toBeHidden()
  await expect(leftUtilities).toBeHidden()
  await page.keyboard.press('ControlOrMeta+Shift+F')
  await expect(globalNavigation).toBeVisible()
  await expect(projectsSidebar).toBeVisible()
  await expect(leftUtilities).toBeVisible()

  const rightUtilities = page.getByRole('complementary', { name: 'Shared developer utilities' })
  await devSidebarControl(page, 'Expand utility sidebar').click()
  await expect(rightUtilities.getByRole('heading', { name: 'Browser' })).toBeVisible()
  const agentsUtility = rightUtilities.getByRole('button', { name: 'Agents' })
  await agentsUtility.focus()
  await expect(agentsUtility).toBeFocused()
  await agentsUtility.click()
  const historyUtility = rightUtilities.getByRole('button', { name: 'History' })
  await historyUtility.click()
  await expect(historyUtility).toHaveAttribute('aria-current', 'page')
  await expect(rightUtilities.getByRole('heading', { name: 'History' })).toBeVisible()

  // Both slots stay independent: collapsing the left side never hides the
  // right side and the reverse holds after reopening.
  const leftUtilityToggle = devToolbarControl(page, 'Collapse left utility sidebar').or(
    devToolbarControl(page, 'Expand left utility sidebar')
  )
  const collapseLeftUtility = devToolbarControl(page, 'Collapse left utility sidebar')
  await expect(collapseLeftUtility).toHaveAttribute('aria-expanded', 'true')
  await collapseLeftUtility.click()
  expect(pageErrors).toEqual([])
  await expect(leftUtilities).toBeHidden()
  const expandLeftUtility = devToolbarControl(page, 'Expand left utility sidebar')
  await expect(expandLeftUtility).toHaveAttribute('aria-expanded', 'false')
  await expect(leftUtilityToggle).toBeFocused()
  await expect(rightUtilities).toBeVisible()
  await expect(historyUtility).toHaveAttribute('aria-current', 'page')
  await expandLeftUtility.click()
  await expect(leftUtilities).toBeVisible()
  const reopenedLeftUtility = devToolbarControl(page, 'Collapse left utility sidebar')
  await expect(reopenedLeftUtility).toHaveAttribute('aria-expanded', 'true')
  await expect(leftUtilityToggle).toBeFocused()
  await expect(leftUtilities.getByRole('heading', { name: 'Files' })).toBeVisible()

  const rightUtilityToggle = devSidebarControl(page, 'Collapse utility sidebar').or(
    devSidebarControl(page, 'Expand utility sidebar')
  )
  const originalRightUtilityToggle = await rightUtilityToggle.elementHandle()
  if (!originalRightUtilityToggle) throw new Error('Right utility toggle did not mount')
  await rightUtilityToggle.focus()
  await expect(rightUtilityToggle).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Enter')
  await expect(rightUtilityToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(rightUtilities).toBeHidden()
  expect(
    await originalRightUtilityToggle.evaluate((element) => element === document.activeElement)
  ).toBe(true)
  await page.keyboard.press('Space')
  await expect(rightUtilityToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(rightUtilities).toBeVisible()
  expect(
    await originalRightUtilityToggle.evaluate((element) => element === document.activeElement)
  ).toBe(true)
  expect(pageErrors).toEqual([])

  await rightUtilities.getByRole('button', { name: 'Expand utility pane' }).click()
  await expect(rightUtilities.getByRole('button', { name: 'Restore utility pane' })).toBeVisible()
  await expect(devSidebarControl(page, 'Collapse utility sidebar')).toBeVisible()
  await devSidebarControl(page, 'Collapse utility sidebar').click()
  await expect(rightUtilities).toBeHidden()
  await devSidebarControl(page, 'Expand utility sidebar').click()
  await expect(rightUtilities.getByRole('button', { name: 'Restore utility pane' })).toBeVisible()

  await page.getByRole('button', { name: 'Chat view' }).click()
  await expect(page).toHaveURL(/view=chat/)
  await expect(page).toHaveURL(/sentinel=keep/)
  await expect(page.getByRole('button', { name: 'Split pane', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Collapse left utility sidebar' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Dev view' }).click()
  await expect(page).toHaveURL(/view=dev/)
  await expect(historyUtility).toHaveAttribute('aria-current', 'page')
  await expect(rightUtilities.getByRole('button', { name: 'Restore utility pane' })).toBeVisible()
  await rightUtilities.getByRole('button', { name: 'Restore utility pane' }).click()
  await expect(runtimeProject).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page
      .getByRole('separator', { name: 'Resize workspace panes' })
      .and(page.locator('[aria-valuenow="55"]'))
  ).toHaveCount(1)
})

test('leaves show their harness status and the checkout keeps its house row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const working = devLeaf(sidebar, 'feature/example')
  await expect(working).toBeVisible({ timeout: 30_000 })
  // Status is words as well as a glyph: colour is never the only signal.
  await expect(working).toContainText('Running')
  await expect(working).toHaveAttribute('data-leaf-kind', 'worktree')
  const checkout = devLeaf(sidebar, 'feature/runtime')
  await expect(checkout).toHaveAttribute('data-leaf-kind', 'checkout')
  await expect(checkout).toContainText('Needs you')
  await expect(devLeaf(sidebar, 'docs/runtime-notes')).toContainText('Idle')
  // The checkout row never offers archive or delete.
  await checkout.hover()
  await checkout.getByRole('button', { name: 'Worktree options for feature/runtime' }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Copy path' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Open in Finder' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Archive' })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /Switch branch/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // A worktree row renames, links, reveals, archives and deletes.
  await working.hover()
  await working.getByRole('button', { name: 'Worktree options for feature/example' }).click()
  await expect(
    page
      .getByRole('menu')
      .getByRole('menuitem')
      .filter({ hasText: /^(Rename|Copy link|Open in Finder|Archive|Delete)$/ })
  ).toHaveCount(5)
  await page.keyboard.press('Escape')
})

test('the Dev sidebar carries the global Agents, Conversations and archive sections', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(devLeaf(sidebar, 'feature/example')).toBeVisible({ timeout: 30_000 })
  // ADR 0011: one shared nav in every view, not only Chat and Virtual.
  await expect(sidebar.getByRole('button', { name: 'Agents', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Mark all read' })).toBeVisible()
  await expect(sidebar.getByRole('region', { name: 'Conversations' })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Create group conversation' })).toBeVisible()
  // Agents opens the Chat Agents surface.
  await sidebar.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page).toHaveURL(/view=chat/)
})

test('the project + names a new branch for a new worktree', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const project = devProjectRow(sidebar, 'Example project')
  await expect(project).toBeVisible({ timeout: 30_000 })
  await project.hover()
  await project.getByRole('button', { name: 'New worktree in Example project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New worktree in Example project' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Creates a branch from main')
  const branch = dialog.getByRole('textbox', { name: 'Branch name' })
  await expect(branch).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Create worktree' })).toBeDisabled()
  await branch.fill('feature/sidebar')
  await dialog.getByRole('button', { name: 'Create worktree' }).click()
  // The E2E fixture has no runtime authority: the refusal stays in the dialog
  // beside the typed name instead of pretending to create a worktree.
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(branch).toHaveValue('feature/sidebar')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('center panes move by keyboard while keeping one primary session', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')

  const panes = page.locator('[data-pane-id]')
  await expect(panes).toHaveCount(1, { timeout: 30_000 })
  const splitPane = page.getByRole('button', { name: 'Split pane', exact: true })
  await expectPointerHitsButton(page, splitPane, 'Split pane')
  await splitPane.click()
  await expect(panes).toHaveCount(2)
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-terminal')

  await page.locator('[data-pane-id="dev-terminal"]').click()
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight')
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-pane-1')
  // The moved pane keeps DOM focus as it crosses its sibling.
  await expect(page.locator('[data-pane-id="dev-terminal"]')).toBeFocused()

  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft')
  await expect(panes.first()).toHaveAttribute('data-pane-id', 'dev-terminal')

  await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0)
})

test('the Dev shell restores the session layout document after a reload', async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  await expect(page.locator('[data-pane-id]')).toHaveCount(1)
  const splitPane = page.getByRole('button', { name: 'Split pane', exact: true })
  await expectPointerHitsButton(page, splitPane, 'Split pane')
  await splitPane.click()
  const separator = page.getByRole('separator', { name: 'Resize workspace panes' })
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '55')

  await devSidebarControl(page, 'Expand utility sidebar').click()
  const rightUtilities = page.getByRole('complementary', { name: 'Shared developer utilities' })
  await expect(rightUtilities).toBeVisible()

  // The layout document is written debounced (250 ms); the reload is the
  // persistence round trip a restart performs, on the same session URL.
  await expect(page).toHaveURL(/devSession=/)
  await page.waitForTimeout(600)
  await page.reload()

  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  await expectDevToolbarHost(page, 1280)
  await expect(
    page
      .getByRole('separator', { name: 'Resize workspace panes' })
      .and(page.locator('[aria-valuenow="55"]'))
  ).toHaveCount(1)
  await expect(
    page.getByRole('complementary', { name: 'Shared developer utilities' })
  ).toBeVisible()
})

test('the utility selector reveals its pane and the sidebar fills the workspace height', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  const leftUtilities = page.getByRole('complementary', { name: 'Developer utilities (left)' })
  const rightUtilities = page.getByRole('complementary', { name: 'Shared developer utilities' })

  await expect(leftUtilities.getByRole('heading', { name: 'Files' })).toBeVisible()
  await devToolbarControl(page, 'Collapse left utility sidebar').click()
  await expect(leftUtilities).toBeHidden()
  await devToolbarControl(page, 'Expand left utility sidebar').click()
  const sourceControlButton = leftUtilities
    .getByRole('group', { name: 'Files and Source Control' })
    .getByRole('button', { name: 'Source control' })
  await expect(sourceControlButton).toBeVisible()
  await sourceControlButton.click()
  await expect(sourceControlButton).toHaveAttribute('aria-pressed', 'true')
  await expect(leftUtilities.getByRole('heading', { name: 'Source Control' })).toBeVisible()

  await devSidebarControl(page, 'Expand utility sidebar').click()
  await expect(rightUtilities).toBeVisible()
  await expect(rightUtilities.getByRole('button', { name: 'Browser' })).toBeVisible()
  await expect(rightUtilities.getByRole('button', { name: 'Devices' })).toBeVisible()

  // The bundled sidebar keeps one pane at a time; switching to Agents and
  // collapsing reopens Agents, not the slot's default pane.
  await rightUtilities.getByRole('button', { name: 'Agents' }).click()
  await expect(rightUtilities.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await devSidebarControl(page, 'Collapse utility sidebar').click()
  await expect(rightUtilities).toBeHidden()
  await devSidebarControl(page, 'Expand utility sidebar').click()
  await expect(rightUtilities.getByRole('heading', { name: 'Agents' })).toBeVisible()

  // The contextual sidebar is a sibling of the center panes and owns the full
  // vertical space of the workspace body rather than its content height.
  const sidebarBox = await page
    .getByRole('complementary', { name: 'Workspace navigation' })
    .boundingBox()
  const panesBox = await page
    .getByRole('region', { name: 'Developer workspace panes' })
    .boundingBox()
  expect(sidebarBox).not.toBeNull()
  expect(panesBox).not.toBeNull()
  expect(Math.abs(sidebarBox!.height - panesBox!.height)).toBeLessThanOrEqual(2)
})

test('Dev shell reports when the E2E fixture has no browser read capability', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')
  await devSidebarControl(page, 'Expand utility sidebar').click()

  const rightUtilities = page.getByRole('complementary', { name: 'Shared developer utilities' })
  await rightUtilities.getByRole('button', { name: 'Browser' }).click()
  await expect(rightUtilities).toContainText(
    'Browser is unavailable because the runtime is not connected.'
  )
  await expect(rightUtilities.getByRole('button', { name: 'Float preview' })).toHaveCount(0)
})

/**
 * Opens the Dev surface and waits for the lazy workspace chunk to mount. On a
 * cold dev server the chunk transform can outrun default expect timeouts, so
 * the first mount wait is generous.
 */
async function openDevView(page: import('@playwright/test').Page, url: string) {
  await page.goto(url)
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  await expectDevToolbarHost(page, 1280)
}

test('a deep link with a missing session recovers visibly and the URL converges', async ({
  page,
}) => {
  // Cold dev-server transforms of the lazy Dev chunk can be slow on a busy
  // machine; give the whole journey double headroom.
  test.slow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(
    page,
    '/?view=dev&devE2e=preserved&sentinel=keep&devProject=fixture-tools&devSession=ghost-session'
  )
  const banner = page.locator('.dev-recovery-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('no longer available')
  // The corrected selection is written back deterministically; the unknown
  // sentinel key survives every patch.
  await expect(page).toHaveURL(/devProject=fixture-tools/)
  await expect(page).toHaveURL(/devSession=fixture-tools-session/)
  await expect(page).toHaveURL(/sentinel=keep/)
})

test('an archived deep link recovers to a live session without hiding the shelf', async ({
  page,
}) => {
  test.slow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(
    page,
    '/?view=dev&devE2e=preserved&devProject=fixture-tools&devSession=fixture-archived'
  )
  await expect(page.locator('.dev-recovery-banner')).toContainText('archived')
  await expect(page).toHaveURL(/devSession=fixture-tools-session/)
})

test('projects render as one flat list in projection order without reorder affordances', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  const projectsSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const projectRows = projectsSidebar.locator('[role="treeitem"][data-project-id]')
  await expect(projectRows).toHaveCount(2)
  await expect(projectRows.first()).toContainText('Example project')
  await expect(projectRows.nth(1)).toContainText('Runtime tools')
  // Order and grouping belong to the cloud: no group headings, no drag.
  await expect(projectsSidebar.getByRole('button', { name: 'PRODUCT' })).toHaveCount(0)
  for (const row of await projectRows.all()) {
    await expect(row).not.toHaveAttribute('draggable', 'true')
    await expect(row).not.toHaveAttribute('aria-description', /Alt/)
  }
})

test('the archive shelf restores losslessly and deletes only behind an explicit handoff', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  await page.getByRole('button', { name: /Archived sessions/ }).click()
  const archiveList = page.getByRole('list', { name: 'Archived sessions', exact: true })
  const item = archiveList.getByRole('listitem').filter({ hasText: 'Archived discovery' })
  await expect(item).toBeVisible()

  // The shared row wraps its controls rather than clipping the label at the
  // narrow viewport. Root-font enlargement is text reflow stress, not browser zoom.
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    if (width === 320) {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%'
      })
    }
    const expand = page.getByRole('button', { name: 'Expand contextual sidebar', exact: true })
    // The crossing can replace the toggle mid-click (the documented lost-click
    // race), so reopen with bounded retries until the sheet answers and the
    // row is back in view.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expand.click({ timeout: 2_000 }).catch(() => undefined)
      try {
        await expect(item).toBeVisible({ timeout: 4_000 })
        break
      } catch {
        // Retry on the live node.
      }
    }
    await expect(item).toBeVisible()
    // The mobile sheet slides in before it rests; measure only the settled
    // row so the slide never reads as a clipped label.
    await expect
      .poll(async () => (await item.boundingBox())?.x ?? Number.NEGATIVE_INFINITY)
      .toBeGreaterThanOrEqual(0)
    const bounds = await item.evaluate((element) => {
      const row = element.getBoundingClientRect()
      const controls = [...element.querySelectorAll('button')].map((button) => {
        const box = button.getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
      })
      const label = element.querySelector('[data-slot="list-row-label"]')!.getBoundingClientRect()
      return {
        left: row.left,
        right: row.right,
        width: window.innerWidth,
        labelWidth: label.width,
        controls,
      }
    })
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(bounds.width)
    expect(bounds.labelWidth).toBeGreaterThanOrEqual(80)
    for (const control of bounds.controls) {
      expect(control.left).toBeGreaterThanOrEqual(bounds.left)
      expect(control.right).toBeLessThanOrEqual(bounds.right)
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('font-size')
  })
  await page.setViewportSize({ width: 1280, height: 900 })

  // Delete is destructive: it stops at an explicit confirmation step.
  await item.getByRole('button', { name: 'Delete…' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete this archived session?' })
  await expect(confirm).toContainText('Delete this archived session?')
  await expect(confirm.getByRole('button', { name: 'Keep', exact: true })).toBeFocused()
  await confirm.getByRole('button', { name: 'Keep' }).click()
  await expect(item).toBeVisible()
  await expect(item.getByRole('button', { name: 'Delete…' })).toBeFocused()

  // Restore is lossless and needs no confirmation.
  await page.keyboard.press('Shift+Tab')
  await expect(item.getByRole('button', { name: 'Restore' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(archiveList.getByRole('listitem')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Archived sessions/ })).toBeFocused()

  // Re-archive by deep link, then delete: the commit reports the missing
  // dev.session.delete host contract instead of pretending to succeed.
  await page.goto('/?view=dev&devE2e=preserved&devSession=fixture-archived')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  await page.getByRole('button', { name: /Archived sessions/ }).click()
  const again = archiveList.getByRole('listitem').filter({ hasText: 'Archived discovery' })
  await again.getByRole('button', { name: 'Delete…' }).click()
  await page
    .getByRole('alertdialog', { name: 'Delete this archived session?' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(again.getByRole('button', { name: 'Delete…' })).toBeFocused()
  await expect(page.getByRole('note')).toContainText('dev.session.delete host contract')
})

test('the Dev shell stays keyboard-operable at 200% zoom with reduced motion', async ({ page }) => {
  // 1280x900 at 200% zoom ≈ a 640x450 viewport.
  await page.setViewportSize({ width: 640, height: 450 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?view=dev&devE2e=preserved')
  await expect(page.getByRole('button', { name: 'Dev view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 30_000 }
  )
  await exerciseContextualSidebarToggle(page)

  // Keyboard-only path: the skip link and utility rail buttons are focusable.
  await page.getByRole('link', { name: 'Skip to workspace' }).focus()
  await expect(page.getByRole('link', { name: 'Skip to workspace' })).toBeFocused()
  await devSidebarControl(page, 'Expand utility sidebar').click()
  const rightUtilities = page.getByRole('complementary', { name: 'Shared developer utilities' })
  await expect(rightUtilities.getByRole('heading', { name: 'Browser' })).toBeVisible()
  await rightUtilities.getByRole('button', { name: 'Agents' }).focus()
  await expect(rightUtilities.getByRole('button', { name: 'Agents' })).toBeFocused()
})

test('utility rails, footer selector, persisted widths, and full-height splitters stay operable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith('adea.dev-layout.v1:') || key.startsWith('adea.dev-layout.v2:'))
        localStorage.removeItem(key)
  })
  await openDevView(page, '/?view=dev&devE2e=preserved')

  const leftUtilities = page.getByRole('complementary', { name: 'Developer utilities (left)' })
  const rightUtilities = page.getByRole('complementary', { name: 'Shared developer utilities' })
  const selector = leftUtilities.getByRole('group', { name: 'Files and Source Control' })
  const filesButton = selector.getByRole('button', { name: 'Files' })
  const sourceControlButton = selector.getByRole('button', { name: 'Source control' })
  await expect(filesButton).toHaveAttribute('aria-pressed', 'true')
  await sourceControlButton.click()
  await expect(sourceControlButton).toHaveAttribute('aria-pressed', 'true')
  await expect(filesButton).toHaveAttribute('aria-pressed', 'false')
  await expect(leftUtilities.getByRole('heading', { name: 'Source Control' })).toBeVisible()
  await filesButton.click()
  await expect(leftUtilities.getByRole('heading', { name: 'Files' })).toBeVisible()

  await devSidebarControl(page, 'Expand utility sidebar').click()
  const browserRailItem = rightUtilities.getByRole('button', { name: 'Browser' })
  await expect(browserRailItem).toHaveAttribute('aria-current', 'page')
  await browserRailItem.hover()
  await expect(
    page.locator('[data-slot="side-rail-tip"]').filter({ hasText: 'Browser' })
  ).toBeVisible()
  // Right utility panes seed the 600px step; existing saved widths still win.
  await expect.poll(async () => (await rightUtilities.boundingBox())?.width ?? 0).toBe(600)
  const rightBorderHandle = page.getByRole('separator', { name: 'Resize right utility pane' })
  // The full-height resize hit target must sit on the border, not inside the content.
  await expect
    .poll(async () => {
      const pane = await rightUtilities.boundingBox()
      const handle = await rightBorderHandle.boundingBox()
      return pane && handle ? Math.abs(handle.x + handle.width / 2 - pane.x) : Infinity
    })
    .toBeLessThanOrEqual(2)

  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((item) => item.startsWith('adea.dev-layout.v2:'))
      )
    )
    .toBe(true)
  const savedLayout = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith('adea.dev-layout.v2:'))
    if (!key) throw new Error('Dev layout was not persisted')
    return { key, value: JSON.parse(localStorage.getItem(key) ?? '{}') }
  })
  expect(
    savedLayout.value.utility.find((item: { pane: string }) => item.pane === 'browser').size
  ).toBe(600)
  await page.evaluate((key) => {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    value.utility = value.utility.map((item: { pane: string }) =>
      item.pane === 'browser' ? { ...item, size: 288, lastNonzeroSize: 288 } : item
    )
    localStorage.setItem(key, JSON.stringify(value))
  }, savedLayout.key)
  await page.reload()
  await expect(rightUtilities).toBeVisible()
  await expect.poll(async () => (await rightUtilities.boundingBox())?.width ?? 0).toBe(288)

  const dragAt = async (
    separator: Locator,
    vertical: 'top' | 'bottom',
    horizontalDelta: number
  ) => {
    const bounds = await separator.boundingBox()
    expect(bounds).not.toBeNull()
    const before = Number(await separator.getAttribute('aria-valuenow'))
    const x = bounds!.x + bounds!.width / 2
    const y = vertical === 'top' ? bounds!.y + 3 : bounds!.y + bounds!.height - 3
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + horizontalDelta, y)
    await page.mouse.up()
    await expect
      .poll(async () => Number(await separator.getAttribute('aria-valuenow')))
      .not.toBe(before)
  }

  const leftSeparator = page.getByRole('separator', { name: 'Resize left utility pane' })
  const rightSeparator = page.getByRole('separator', { name: 'Resize right utility pane' })
  await expect(leftSeparator).toBeVisible()
  await expect(rightSeparator).toBeVisible()
  await expect(leftSeparator).toHaveAttribute('aria-valuemax', '384')
  await expect(rightSeparator).toHaveAttribute('aria-valuemax', '600')
  // The left pane opens at the shared 336 default, one 64px drag from the 384
  // cap: shrink first so both drags land on a movable step.
  await dragAt(leftSeparator, 'top', -64)
  await dragAt(leftSeparator, 'bottom', 64)
  await leftSeparator.focus()
  const leftBeforeKeyboard = Number(await leftSeparator.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => Number(await leftSeparator.getAttribute('aria-valuenow')))
    .toBeLessThan(leftBeforeKeyboard)

  await dragAt(rightSeparator, 'top', -64)
  await dragAt(rightSeparator, 'bottom', -64)
  await rightSeparator.focus()
  const rightBeforeKeyboard = Number(await rightSeparator.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => Number(await rightSeparator.getAttribute('aria-valuenow')))
    .toBeLessThan(rightBeforeKeyboard)

  await page.setViewportSize({ width: 320, height: 900 })
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  await expect(filesButton).toBeVisible()
  const narrowRightBounds = await rightUtilities.boundingBox()
  expect(narrowRightBounds).not.toBeNull()
  expect(narrowRightBounds!.width).toBeLessThanOrEqual(320 * 0.78 + 1)
  expect(narrowRightBounds!.x).toBeGreaterThanOrEqual(0)
  expect(narrowRightBounds!.x + narrowRightBounds!.width).toBeLessThanOrEqual(320)
  const narrowSelector = await selector.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return {
      left: bounds.left,
      right: bounds.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }
  })
  expect(narrowSelector.left).toBeGreaterThanOrEqual(0)
  expect(narrowSelector.right).toBeLessThanOrEqual(320)
  expect(narrowSelector.scrollWidth).toBeLessThanOrEqual(narrowSelector.clientWidth)
})

test('Dev surfaces expose an aria snapshot and run under an eval-blocking CSP', async ({
  page,
}) => {
  await page.route('**/*', async (route) => {
    const headers = await route.request().allHeaders()
    await route.continue({
      headers: {
        ...headers,
        // Blocks eval/Function without breaking the SSR bootstrap's inline
        // scripts: the Dev surface must be CSP-safe, not inline-free.
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      },
    })
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
  await expectDevToolbarHost(page, 1280)

  // The labelled pane-action host rides the global top bar, outside main, so
  // snapshot the whole workspace frame to cover both mount points.
  const snapshot = await page.locator('.workspace-frame').ariaSnapshot()
  expect(snapshot).toContain('Skip to workspace')
  expect(snapshot).toContain('Developer workspace actions')
  expect(snapshot).toContain('Workspace navigation')

  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await toggleDevLeftUtility(page)
  await toggleDevLeftUtility(page)
  expect(errors).toEqual([])
})
