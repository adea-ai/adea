import { expect, test, type Page } from '@playwright/test'

/**
 * The real shell against the running app and a disposable database: no route mocks. An optional
 * workspace is archived from General settings, the shell settles on a remaining workspace, a reload
 * finds the workspace in the owner's archived list, and reopen restores the same ID and history
 * (M11.04, #1175). Permanent deletion stays disabled throughout.
 */
const workspaceName = 'Lifecycle archive target'

type ApiResult = { status: number; body: unknown }

/** A same-origin call from the page itself, the way the shell makes its own requests. */
async function callApi(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<ApiResult> {
  return page.evaluate(
    async ({ verb, url, payload }) => {
      const headers: Record<string, string> = {}
      if (payload !== undefined) {
        headers['content-type'] = 'application/json'
        headers['idempotency-key'] = `lifecycle-${crypto.randomUUID()}`
        headers['x-request-id'] = crypto.randomUUID()
      }
      const response = await fetch(url, {
        method: verb,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    },
    { verb: method, url: path, payload: body }
  )
}

/** GET /api/workspaces answers with the bare list of the caller's live workspaces. */
function workspaceIds(result: ApiResult): string[] {
  return (result.body as { id: string }[]).map(({ id }) => id)
}

/** Opens a workspace the way a person does: from the sidebar, then its General settings. */
async function openWorkspaceSettings(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible({ timeout: 60_000 })
  await page.evaluate(() => {
    window.location.hash = 'workspace-settings/general'
  })
}

test('an optional workspace archives from the real shell, is found after a reload, and reopens with its ID and history', async ({
  page,
}) => {
  // The first load runs the guest bootstrap, which creates Home and the temporary session cookie.
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({ timeout: 30_000 })
  // The navigation can paint before the guest session cookie exists, so the bootstrap call that
  // issues it is awaited before any request that needs it.
  const bootstrapped = await callApi(page, 'POST', '/api/workspaces/bootstrap', {})
  expect(bootstrapped.status, JSON.stringify(bootstrapped.body)).toBe(200)

  // The optional workspace is created through the production create route, as the other real-shell
  // specs do, and gets one task so the history can be checked after reopen.
  const created = await callApi(page, 'POST', '/api/workspaces', {
    name: workspaceName,
    scene: 'work',
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const workspaceId = (created.body as { workspace: { id: string } }).workspace.id
  const task = await callApi(page, 'POST', `/api/v1/workspaces/${workspaceId}/tasks`, {
    title: 'Lifecycle history',
    objective: 'Kept across archive and reopen',
  })
  expect(task.status, JSON.stringify(task.body)).toBe(201)
  const taskId = (task.body as { task: { id: string } }).task.id

  // The shell reads its workspace list at load, so a reload includes the new workspace. The
  // workspace becomes the active one from the sidebar, and its General settings open.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible({
    timeout: 60_000,
  })
  await openWorkspaceSettings(page, workspaceName)
  const archiveRow = page.getByRole('button', { name: 'Archive workspace', exact: true })
  await expect(archiveRow).toBeVisible({ timeout: 30_000 })
  await archiveRow.click()
  await expect(page.getByText(`Archive ${workspaceName}?`)).toBeVisible()
  await archiveRow.click()

  // The shell settles on the personal Home. The archived workspace's own panel unmounts with it, so
  // the success toast, which the shell mounts above the panels, is what confirms the archive here.
  // The durable archived list below is the recovery check.
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText(`${workspaceName} is archived`, { exact: true })).toBeVisible()
  expect(workspaceIds(await callApi(page, 'GET', '/api/workspaces'))).not.toContain(workspaceId)
  const bootstrap = await callApi(page, 'POST', '/api/workspaces/bootstrap', {})
  expect(
    (bootstrap.body as { activeWorkspace: { isPersonal: boolean } }).activeWorkspace.isPersonal
  ).toBe(true)

  // A reload finds the archived workspace in the owner's durable list from Home's settings.
  await page.reload()
  await page.evaluate(() => {
    window.location.hash = 'workspace-settings/general'
  })
  const reopenRow = page.getByRole('button', { name: `Reopen ${workspaceName}`, exact: true })
  await expect(reopenRow).toBeVisible({ timeout: 60_000 })
  await reopenRow.click()
  await expect(page.getByRole('status', { name: 'Archived workspaces status' })).toContainText(
    `${workspaceName} is reopened`
  )

  // The same workspace ID and the same task come back after reopen.
  expect(workspaceIds(await callApi(page, 'GET', '/api/workspaces'))).toContain(workspaceId)
  const tasks = await callApi(page, 'GET', `/api/v1/workspaces/${workspaceId}/tasks`)
  expect((tasks.body as { id: string }[]).map(({ id }) => id)).toContain(taskId)

  // Permanent deletion remains blocked on the reopened workspace.
  await page.reload()
  await openWorkspaceSettings(page, workspaceName)
  await expect(page.getByRole('button', { name: 'Delete workspace', exact: true })).toBeDisabled({
    timeout: 30_000,
  })
})

// The overlay is global to the workspace frame, so an archive from the Virtual or Dev view raises
// its toast there too, in the frame's one default stack.
for (const view of ['Virtual view', 'Dev view'] as const) {
  test(`an archive from the ${view.toLowerCase()} shows its toast, in one notification stack`, async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({
      timeout: 30_000,
    })
    const bootstrapped = await callApi(page, 'POST', '/api/workspaces/bootstrap', {})
    expect(bootstrapped.status, JSON.stringify(bootstrapped.body)).toBe(200)
    const created = await callApi(page, 'POST', '/api/workspaces', {
      name: workspaceName,
      scene: 'work',
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible({
      timeout: 60_000,
    })
    await page.getByRole('button', { name: workspaceName, exact: true }).click()
    await expect(page.getByRole('heading', { name: workspaceName, level: 1 })).toBeVisible({
      timeout: 60_000,
    })
    await page.getByRole('button', { name: view, exact: true }).click()
    await page.evaluate(() => {
      window.location.hash = 'workspace-settings/general'
    })

    const archiveRow = page.getByRole('button', { name: 'Archive workspace', exact: true })
    await expect(archiveRow).toBeVisible({ timeout: 30_000 })
    await archiveRow.click()
    await archiveRow.click()
    await expect(page.getByText(`${workspaceName} is archived`, { exact: true })).toBeVisible()
    // One default stack: an embedded SourceControlApp sends its notices here rather than mounting its own.
    await expect(page.getByRole('region', { name: /^Notifications/ })).toHaveCount(1)
  })
}
