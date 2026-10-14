import { expect, test, type Page } from '@playwright/test'

/**
 * The invitation page previews the workspace before it accepts (#1175). The preview and accept
 * routes are answered here so each case stages one server outcome; the route and the database
 * behind them are covered by the preview route-flow integration test.
 */
const TOKEN = 'A'.repeat(43)

const preview = {
  alreadyMember: false,
  expiresAt: '2026-10-20T00:00:00.000Z',
  memberCount: 4,
  ownerName: 'Acme Ops',
  role: 'admin',
  workspaceName: 'Acme',
}

async function openInvitation(
  page: Page,
  outcome: {
    preview?: typeof preview
    previewStatus?: number
    acceptStatus?: number
  } = {}
) {
  const calls: string[] = []
  await page.route('**/api/workspace-invitations/preview', async (route) => {
    calls.push('preview')
    const status = outcome.previewStatus ?? 200
    await route.fulfill(
      status === 200
        ? { json: outcome.preview ?? preview, status }
        : { json: { code: 'workspace_unavailable', message: 'Unavailable' }, status }
    )
  })
  await page.route('**/api/workspace-invitations/accept', async (route) => {
    calls.push('accept')
    await route.fulfill(
      (outcome.acceptStatus ?? 200) === 200
        ? { json: { joined: true, workspaceId: 'workspace-acme' }, status: 200 }
        : { json: { code: 'workspace_unavailable', message: 'Unavailable' }, status: 404 }
    )
  })
  await page.goto(`/invite#token=${TOKEN}`)
  return calls
}

test('the invitee sees the workspace, owner, audience and role before accepting anything', async ({
  page,
}) => {
  const calls = await openInvitation(page)
  await expect(
    page.getByRole('heading', { name: 'You’ve been invited to Acme', exact: true })
  ).toBeVisible()
  await expect(page.getByTestId('invitation-context')).toHaveText(
    'Owned by Acme Ops · 4 members now · You would join as an admin · Location unknown'
  )
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeEnabled()
  // Looking is not joining: only the preview ran, and the token is gone from the address bar.
  expect(calls).toEqual(['preview'])
  expect(page.url()).not.toContain(TOKEN)
})

test('a guest is sent to sign in and is shown nothing about the workspace', async ({ page }) => {
  await openInvitation(page, { previewStatus: 401 })
  await expect(page.getByRole('heading', { name: 'Sign in to join' })).toBeVisible()
  await expect(page.getByText('Acme')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
})

test('an invitation that cannot be used says so without revealing why', async ({ page }) => {
  await openInvitation(page, { previewStatus: 404 })
  await expect(
    page.getByRole('heading', { name: 'This invitation can’t be used', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
})

test('a failed preview offers a retry and joins nothing', async ({ page }) => {
  const calls = await openInvitation(page, { previewStatus: 503 })
  await expect(
    page.getByRole('heading', { name: 'This invitation could not be checked' })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
  expect(calls).toEqual(['preview'])
  await page.unroute('**/api/workspace-invitations/preview')
  await page.route('**/api/workspace-invitations/preview', (route) =>
    route.fulfill({ json: preview, status: 200 })
  )
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('invitation-context')).toBeVisible()
})

test('accepting happens only on the explicit button, after the preview', async ({ page }) => {
  const calls = await openInvitation(page)
  await expect(page.getByTestId('invitation-context')).toBeVisible()
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page).toHaveURL(/\/\?workspace=workspace-acme/)
  expect(calls).toEqual(['preview', 'accept'])
})

test('an existing member sees the role they hold and that accepting changes nothing', async ({
  page,
}) => {
  const calls = await openInvitation(page, {
    preview: { ...preview, alreadyMember: true, role: 'member' },
  })
  await expect(page.getByTestId('invitation-context')).toHaveText(
    'Owned by Acme Ops · 4 members now · You are already a member · Location unknown'
  )
  await expect(page.getByTestId('invitation-effect')).toContainText('doesn’t change your role')
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open workspace' }).click()
  await expect(page).toHaveURL(/\/\?workspace=workspace-acme/)
  expect(calls).toEqual(['preview', 'accept'])
})
