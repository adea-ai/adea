// Route → PostgreSQL flows for the portable workspace export and import
// (M18.02.2, #1226).
//
// Lane: a normal part of `bun run test:integration`, invoked with the react-server
// export condition like the other route-flow files. The principal is injected as a
// `WorkspacePrincipalResolution` (the account-directory convention): real session
// resolution is covered by the auth boundary tests, while these tests prove what the
// handlers decide once a principal is known: membership and revocation at export,
// the creation permission and the byte bound at import, and the typed refusals.
//
// The clean-destination restore into a separate, disposable database lives beside the
// other package integration proofs (packages/db/tests/integration/portable-restore-clean).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  addWorkspaceMembership,
  channels,
  createDatabase,
  createGroupChannel,
  createMessage,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  type DatabaseConnection,
  exportPortableWorkspace,
  getChannelForUser,
  messages,
  portableContentDigest,
  removeWorkspaceMembership,
  setChannelParticipants,
  users,
  workspaceMemberships,
  workspaces,
} from '@adea-ai/db'
import { type PortableWorkspaceExport, validatePortableWorkspaceExport } from '@adea-ai/types'

import {
  PORTABLE_API_MAX_BYTES,
  portableImportResponse,
  portableWorkspaceExportResponse,
} from '../../src/server/portable-workspace-request'
import type { WorkspacePrincipalResolution } from '../../src/server/workspace-principal'

const connectionUrl = process.env.DATABASE_URL
if (!connectionUrl)
  throw new Error('DATABASE_URL is required for the portable workspace route flows')

const future = () => new Date(Date.now() + 60 * 60 * 1000)
const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const visibleText = `Visible route text ${run}`
const allowAll = async () => true
const denyAll = async () => false

function resolutionFor(
  principal: WorkspacePrincipalResolution['principal']
): WorkspacePrincipalResolution {
  return { clearTemporaryCredential: false, principal, sessionRotated: false, temporary: true }
}

function exportRequest() {
  return new Request('http://localhost/api/v1/workspaces/x/portable-export')
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

describe('portable workspace routes', () => {
  let connection: DatabaseConnection
  const created: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  async function removeWorkspace(workspaceId: string) {
    // Messages are restricted by channel, so they go first; memberships are
    // restricted by workspace. The workspace row cascades the rest.
    await connection.db.delete(messages).where(eq(messages.workspaceId, workspaceId))
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspaceId))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
  }

  afterAll(async () => {
    for (const workspaceId of created) await removeWorkspace(workspaceId)
    await connection.close()
  })

  async function seed(name: string) {
    const db = connection.db
    const owner = await createTemporaryUserSession(db, {
      credentialDigest: `route-owner-${name}-${run}`,
      displayName: 'Route Owner',
      expiresAt: future(),
    })
    const member = await createTemporaryUserSession(db, {
      credentialDigest: `route-member-${name}-${run}`,
      displayName: 'Route Member',
      expiresAt: future(),
    })
    const outsider = await createTemporaryUserSession(db, {
      credentialDigest: `route-outsider-${name}-${run}`,
      displayName: 'Route Outsider',
      expiresAt: future(),
    })
    const { workspace } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `portable-route-${name}-${run}`,
      name: `Route ${name}`,
      owner: owner.principal,
    })
    created.push(workspace.id)
    await addWorkspaceMembership(db, workspace.id, member.principal, 'member')
    const channel = await createGroupChannel(db, workspace.id, owner.principal, {
      idempotencyKey: `route-channel-${name}-${run}`,
      title: 'Route lane',
    })
    await setChannelParticipants(
      db,
      workspace.id,
      channel.id,
      owner.principal,
      [
        { kind: 'user', userId: owner.principal.userId },
        { kind: 'user', userId: member.principal.userId },
      ],
      channel.version
    )
    await createMessage(db, workspace.id, channel.id, owner.principal, {
      bodyText: visibleText,
      idempotencyKey: `route-message-${name}-${run}`,
      sender: owner.principal,
    })
    return { channel, member, outsider, owner, workspaceId: workspace.id }
  }

  test('a member receives a valid, no-store export; outsiders and removed members get the same unavailable answer', async () => {
    const fixture = await seed('export')
    const db = connection.db

    const granted = await portableWorkspaceExportResponse(
      new Request('http://localhost/api/v1/workspaces/x/portable-export'),
      db,
      resolutionFor(fixture.member.principal),
      fixture.workspaceId
    )
    expect(granted.status).toBe(200)
    expect(granted.headers.get('cache-control')).toBe('private, no-store')
    expect(granted.headers.get('content-disposition')).toContain('.portable.json')
    const document = (await granted.json()) as PortableWorkspaceExport
    expect(validatePortableWorkspaceExport(document).ok).toBe(true)
    expect(JSON.stringify(document)).toContain(visibleText)

    const unknown = await portableWorkspaceExportResponse(
      new Request('http://localhost/api/v1/workspaces/x/portable-export'),
      db,
      resolutionFor(fixture.outsider.principal),
      fixture.workspaceId
    )
    const absent = await portableWorkspaceExportResponse(
      new Request('http://localhost/api/v1/workspaces/x/portable-export'),
      db,
      resolutionFor(fixture.outsider.principal),
      crypto.randomUUID()
    )
    expect(unknown.status).toBe(404)
    expect(absent.status).toBe(404)
    expect(await unknown.text()).toBe(await absent.text())

    expect(await removeWorkspaceMembership(db, fixture.workspaceId, fixture.member.principal)).toBe(
      true
    )
    const revoked = await portableWorkspaceExportResponse(
      new Request('http://localhost/api/v1/workspaces/x/portable-export'),
      db,
      resolutionFor(fixture.member.principal),
      fixture.workspaceId
    )
    expect(revoked.status).toBe(404)
    expect(await revoked.text()).not.toContain(visibleText)
  })

  test('the export refuses a malformed workspace id before any read', async () => {
    const fixture = await seed('malformed')
    const response = await portableWorkspaceExportResponse(
      new Request('http://localhost/api/v1/workspaces/x/portable-export'),
      connection.db,
      resolutionFor(fixture.owner.principal),
      'not-a-workspace'
    )
    expect(response.status).toBe(400)
  })

  test('the export refuses to emit a bundle above the API bound instead of truncating it', async () => {
    const fixture = await seed('bound')
    const text = 'x'.repeat(100_000)
    const count = Math.ceil(PORTABLE_API_MAX_BYTES / text.length) + 1
    for (let index = 0; index < count; index += 1)
      await createMessage(
        connection.db,
        fixture.workspaceId,
        fixture.channel.id,
        fixture.owner.principal,
        {
          bodyText: text,
          idempotencyKey: `bound-${run}-${index}`,
          sender: fixture.owner.principal,
        }
      )
    const response = await portableWorkspaceExportResponse(
      new Request('http://localhost/api/v1/workspaces/x/portable-export'),
      connection.db,
      resolutionFor(fixture.owner.principal),
      fixture.workspaceId
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'too_large', maxBytes: PORTABLE_API_MAX_BYTES })
  }, 180_000)

  test('import is refused before any read when the caller may not create workspaces', async () => {
    const fixture = await seed('denied-create')
    const bundle = await exportPortableWorkspace(connection.db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    })
    const response = await portableImportResponse(
      jsonRequest('http://localhost/api/v1/portable-imports', bundle),
      connection.db,
      resolutionFor(fixture.outsider.principal),
      denyAll
    )
    expect(response.status).toBe(404)
  })

  test('import enforces the byte bound while reading, declared or not, and refuses malformed input', async () => {
    const fixture = await seed('bounds')
    const url = 'http://localhost/api/v1/portable-imports'

    const declared = await portableImportResponse(
      {
        body: null,
        headers: new Headers({ 'content-length': String(PORTABLE_API_MAX_BYTES + 1) }),
        url,
      } as unknown as Request,
      connection.db,
      resolutionFor(fixture.owner.principal),
      allowAll
    )
    expect(declared.status).toBe(413)

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('['))
        controller.enqueue(new TextEncoder().encode('0'.repeat(PORTABLE_API_MAX_BYTES)))
        controller.enqueue(new TextEncoder().encode(']'))
        controller.close()
      },
    })
    const undeclared = await portableImportResponse(
      new Request(url, { body: oversized, duplex: 'half', method: 'POST' }),
      connection.db,
      resolutionFor(fixture.owner.principal),
      allowAll
    )
    expect(undeclared.status).toBe(413)

    const notJson = await portableImportResponse(
      new Request(url, { body: '{not json', method: 'POST' }),
      connection.db,
      resolutionFor(fixture.owner.principal),
      allowAll
    )
    expect(notJson.status).toBe(400)
  })

  test('import refuses a bundle that fails the contract or its digest, with issues and no values', async () => {
    const fixture = await seed('defective')
    const bundle = await exportPortableWorkspace(connection.db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    })
    const url = 'http://localhost/api/v1/portable-imports'
    const importer = resolutionFor(fixture.outsider.principal)

    const malformed = await portableImportResponse(
      jsonRequest(url, { format: 'nope' }),
      connection.db,
      importer,
      allowAll
    )
    expect(malformed.status).toBe(422)
    const issues = (await malformed.json()) as { error: string; issues: unknown[] }
    expect(issues.error).toBe('invalid_document')
    expect(JSON.stringify(issues)).not.toContain('nope')

    const tampered = structuredClone(bundle) as PortableWorkspaceExport
    const text = tampered.content.messages.find((message) => message.body.kind === 'text')
    ;(text!.body as { text: string }).text = 'Edited in transit'
    const mismatch = await portableImportResponse(
      jsonRequest(url, tampered),
      connection.db,
      importer,
      allowAll
    )
    expect(mismatch.status).toBe(422)
    expect(((await mismatch.json()) as { error: string }).error).toBe('digest_mismatch')
  })

  test('a valid bundle restores as a new workspace owned by the importer, and a repeat is refused', async () => {
    const fixture = await seed('restore')
    const bundle = await exportPortableWorkspace(connection.db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    })
    await removeWorkspace(fixture.workspaceId)
    const importer = await createTemporaryUserSession(connection.db, {
      credentialDigest: `route-importer-${run}`,
      displayName: 'Route Importer',
      expiresAt: future(),
    })
    const url = 'http://localhost/api/v1/portable-imports'

    const created201 = await portableImportResponse(
      jsonRequest(url, bundle),
      connection.db,
      resolutionFor(importer.principal),
      allowAll
    )
    expect(created201.status).toBe(201)
    const body = (await created201.json()) as { contentDigest: string; workspaceId: string }
    expect(body.workspaceId).toBe(fixture.workspaceId)
    expect(body.contentDigest).toBe(bundle.contentDigest.value)
    created.push(body.workspaceId)

    const repeat = await portableImportResponse(
      jsonRequest(url, bundle),
      connection.db,
      resolutionFor(importer.principal),
      allowAll
    )
    expect(repeat.status).toBe(409)
  })

  test('import refuses a bundle naming a user the destination does not hold, and a disabled importer', async () => {
    const fixture = await seed('identities')
    const bundle = await exportPortableWorkspace(connection.db, {
      principal: fixture.owner.principal,
      workspaceId: fixture.workspaceId,
    })
    const phantomUser = crypto.randomUUID()
    const phantom = {
      ...bundle,
      content: {
        ...bundle.content,
        users: [...bundle.content.users, { displayName: null, userId: phantomUser }],
        workspace: { ...bundle.content.workspace, workspaceId: crypto.randomUUID() },
      },
    } as unknown as PortableWorkspaceExport
    const rebound = {
      ...phantom,
      contentDigest: {
        algorithm: 'sha256' as const,
        value: portableContentDigest(phantom.content),
      },
    }
    const url = 'http://localhost/api/v1/portable-imports'

    const unresolved = await portableImportResponse(
      jsonRequest(url, rebound),
      connection.db,
      resolutionFor(fixture.outsider.principal),
      allowAll
    )
    expect(unresolved.status).toBe(422)
    expect(((await unresolved.json()) as { error: string }).error).toBe('unresolved_users')

    await connection.db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, fixture.outsider.principal.userId))
    const disabled = await portableImportResponse(
      jsonRequest(url, bundle),
      connection.db,
      resolutionFor(fixture.outsider.principal),
      allowAll
    )
    expect(disabled.status).toBe(403)
    await connection.db
      .update(users)
      .set({ disabledAt: null })
      .where(eq(users.id, fixture.outsider.principal.userId))
  })
  test('a participant removed from a participants-only channel loses the channel and its messages at the next export', async () => {
    const fixture = await seed('participant-route')
    const db = connection.db
    const before = await portableWorkspaceExportResponse(
      exportRequest(),
      db,
      resolutionFor(fixture.member.principal),
      fixture.workspaceId
    )
    expect(before.status).toBe(200)
    expect(await before.text()).toContain(visibleText)

    const current = await getChannelForUser(
      db,
      fixture.workspaceId,
      fixture.channel.id,
      fixture.owner.principal
    )
    await setChannelParticipants(
      db,
      fixture.workspaceId,
      fixture.channel.id,
      fixture.owner.principal,
      [{ kind: 'user', userId: fixture.owner.principal.userId }],
      current.version
    )
    const after = await portableWorkspaceExportResponse(
      exportRequest(),
      db,
      resolutionFor(fixture.member.principal),
      fixture.workspaceId
    )
    expect(after.status).toBe(200)
    const text = await after.text()
    expect(text).not.toContain(visibleText)
    expect(text).not.toContain(fixture.channel.id)
  })
})
