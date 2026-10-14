// Route → PostgreSQL flows for previewing a workspace invitation (#1175).
//
// The preview handler runs against the real database with a caller that is injected. It must show
// the invitee the workspace, owner, audience and role under exactly the acceptance gates, answer
// every other refusal with the same 404, and change nothing.
//
// Lane: discovered by `bun run test:integration` (react-server condition, DATABASE_URL trio). Without
// DATABASE_URL the suite is skipped here, and the lane fails rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  acceptWorkspaceInvitation,
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceInvitation,
  createWorkspaceWithOwner,
  removeWorkspaceMembership,
  workspaceInvitations,
  type DatabaseConnection,
} from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'

import { workspaceInvitationPreviewPost } from '../../src/server/workspace-invitation-preview-handler'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

const connectionUrl = process.env.DATABASE_URL

function previewRequest(body: unknown): Request {
  return new Request('https://adea.test/api/workspace-invitations/preview', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

describe.skipIf(!connectionUrl)('workspace invitation preview route flow (#1175)', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `preview-route-${label}-${crypto.randomUUID()}`,
        displayName: label,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
  }

  function dependencies(
    caller: UserPrincipalRef,
    account: { email: string | null; temporary: boolean }
  ) {
    return {
      database: () => connection.db,
      resolvePrincipal: async (): Promise<WorkspacePrincipalResolution> => ({
        clearTemporaryCredential: false,
        email: account.email,
        principal: caller,
        sessionRotated: false,
        temporary: account.temporary,
      }),
    }
  }

  async function invitation() {
    const owner = await user('owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `preview-route-${crypto.randomUUID()}`,
      name: 'Preview route workspace',
      owner,
    })
    const email = `invitee-${crypto.randomUUID()}@example.com`
    const created = await createWorkspaceInvitation(connection.db, workspace.id, owner, {
      email,
      role: 'member',
    })
    return { created, email, workspace }
  }

  test('a signed-in account with the invited email sees the workspace, owner, audience and role', async () => {
    const { created, email } = await invitation()
    const invitee = await user('invitee')

    const response = await workspaceInvitationPreviewPost(
      previewRequest({ token: created.token }),
      dependencies(invitee, { email, temporary: false })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toEqual({
      alreadyMember: false,
      expiresAt: created.invitation.expiresAt,
      memberCount: 1,
      ownerName: 'owner',
      role: 'member',
      workspaceName: 'Preview route workspace',
    })
    expect(JSON.stringify(body)).not.toContain(created.token)
  })

  test('previewing settles nothing: the invitation stays pending and acceptable', async () => {
    const { created, email } = await invitation()
    const invitee = await user('invitee-pending')
    await workspaceInvitationPreviewPost(
      previewRequest({ token: created.token }),
      dependencies(invitee, { email, temporary: false })
    )
    const [row] = await connection.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, created.invitation.id))
    expect(row!.acceptedAt).toBeNull()
    expect(row!.revokedAt).toBeNull()
  })

  test('a guest is sent to sign in and is shown nothing', async () => {
    const { created } = await invitation()
    const guest = await user('guest')
    const response = await workspaceInvitationPreviewPost(
      previewRequest({ token: created.token }),
      dependencies(guest, { email: null, temporary: true })
    )
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('Preview route workspace')
  })

  test('another email, a missing email and an unknown token all answer the same 404', async () => {
    const { created, email } = await invitation()
    const stranger = await user('stranger')
    const attempts: Array<[unknown, { email: string | null; temporary: boolean }]> = [
      [{ token: created.token }, { email: 'someone-else@example.com', temporary: false }],
      [{ token: created.token }, { email: null, temporary: false }],
      [{ token: 'A'.repeat(43) }, { email, temporary: false }],
    ]
    const bodies = new Set<string>()
    for (const [body, account] of attempts) {
      const response = await workspaceInvitationPreviewPost(
        previewRequest(body),
        dependencies(stranger, account)
      )
      expect(response.status).toBe(404)
      bodies.add(await response.text())
    }
    expect(bodies.size).toBe(1)
  })

  test('a used link answers its member with the role they hold, and a removed one with the same 404', async () => {
    const { created, email, workspace } = await invitation()
    const invitee = await user('invitee-replay')
    const account = { email, temporary: false }
    await acceptWorkspaceInvitation(connection.db, invitee, { email, token: created.token })

    const replay = await workspaceInvitationPreviewPost(
      previewRequest({ token: created.token }),
      dependencies(invitee, account)
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ alreadyMember: true, role: 'member' })

    await removeWorkspaceMembership(connection.db, workspace.id, invitee)
    const removed = await workspaceInvitationPreviewPost(
      previewRequest({ token: created.token }),
      dependencies(invitee, account)
    )
    const unknown = await workspaceInvitationPreviewPost(
      previewRequest({ token: 'A'.repeat(43) }),
      dependencies(invitee, account)
    )
    expect(removed.status).toBe(404)
    expect(await removed.text()).toBe(await unknown.text())
  })

  test('a malformed body is refused before any read', async () => {
    const invitee = await user('malformed')
    for (const body of [{}, { token: 'short' }, { token: 'A'.repeat(43), extra: true }, []]) {
      const response = await workspaceInvitationPreviewPost(
        previewRequest(body),
        dependencies(invitee, { email: 'x@example.com', temporary: false })
      )
      expect(response.status).toBe(400)
    }
  })
})
