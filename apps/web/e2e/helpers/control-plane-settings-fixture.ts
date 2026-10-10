import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import { runtimeInventoryFixtureResponse } from './runtime-inventory-fixture'

function record(method: string, path: string, body: unknown) {
  const root = document.querySelector('#harness-root')
  const requests = JSON.parse(root?.getAttribute('data-requests') ?? '[]') as unknown[]
  requests.push({ body, method, path })
  root?.setAttribute('data-requests', JSON.stringify(requests))
}

/**
 * An in-memory stand-in for Adea's workspace Skills and Cloud connections
 * routes, for the settings harness. `scoped` serves a workspace skill, a
 * read-only system skill and the cloud connections it holds; `unavailable`
 * answers every route the way a deployment without a signing key does
 * (`503 CONTROL_PLANE_UNAVAILABLE`). Each request's
 * method, path and body are appended to `data-requests` on the harness root
 * so the spec can assert what left the page.
 */
export function controlPlaneSettingsClient(mode: 'scoped' | 'unavailable'): AgentHqApiClient {
  let revision = 1
  let skillLifecycle = 'published'
  const connections: Record<string, unknown>[] = [
    {
      connectorRef: 'connector:github',
      createdAt: '2026-10-06T12:00:00.000Z',
      credentialId: 'crd_01JABCDEF0123456789ABCDEFG',
      provider: 'github',
      revision,
      status: 'active',
    },
  ]
  const skills = () => ({
    canManage: true,
    items: [
      {
        createdAt: '2026-10-06T12:00:00.000Z',
        displayName: 'Release notes',
        id: 'skl_01JABCDEF0123456789ABCDEFG',
        kind: 'skill',
        latestVersion: {
          contentDigest: `sha256:${'c'.repeat(64)}`,
          createdAt: '2026-10-06T12:00:00.000Z',
          lifecycle: skillLifecycle,
          revision: skillLifecycle === 'published' ? 2 : 3,
          version: '1.0.0',
          versionId: 'skv_01JABCDEF0123456789ABCDEFG',
        },
        owner: 'workspace',
        readOnly: false,
      },
      {
        createdAt: '2026-10-06T12:00:00.000Z',
        displayName: 'Code review',
        id: 'skl_01JABCDEF0123456789ABCDEFH',
        kind: 'skill',
        latestVersion: {
          contentDigest: `sha256:${'d'.repeat(64)}`,
          createdAt: '2026-10-06T12:00:00.000Z',
          lifecycle: 'published',
          revision: 1,
          version: '2.1.0',
          versionId: 'skv_01JABCDEF0123456789ABCDEFH',
        },
        owner: 'system',
        readOnly: true,
      },
    ],
  })
  return createApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input), window.location.origin)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      // Record the secret's length only: the harness page must never hold it.
      record(
        method,
        url.pathname,
        typeof body?.secret === 'string'
          ? { ...body, secret: `<${body.secret.length} characters>` }
          : body
      )
      if (mode === 'unavailable')
        return Response.json(
          { code: 'CONTROL_PLANE_UNAVAILABLE', message: 'Control Plane is not configured' },
          { status: 503 }
        )
      // General reads the owner's archived workspaces (#1175). The harness keeps none, so the list is
      // empty; the request above is recorded like every other, and specs assert it by method and path.
      if (url.pathname === '/api/workspaces/archived' && method === 'GET')
        return Response.json({ workspaces: [] })
      const runtimeInventory = await runtimeInventoryFixtureResponse(url, init?.signal ?? undefined)
      if (runtimeInventory) return runtimeInventory
      const path = url.pathname.replace(/^\/api\/workspaces\/[^/]+\//u, '')
      if (path === 'skills' && method === 'GET') return Response.json(skills())
      if (path === 'skills/profiles') return Response.json({ canManage: true, items: [] })
      if (path.endsWith('/deprecate')) {
        skillLifecycle = 'deprecated'
        return Response.json({ changed: [], item: skills().items[0] })
      }
      if (path === 'cloud-connections' && method === 'GET')
        return Response.json({ canManage: true, connections })
      if (path === 'cloud-connections' && method === 'POST') {
        const connection = {
          connectorRef: String(body?.connectorRef),
          createdAt: '2026-10-06T13:00:00.000Z',
          credentialId: 'crd_01JABCDEF0123456789ABCDEFH',
          provider: String(body?.provider),
          revision: 1,
          status: 'active',
        }
        connections.push(connection)
        return Response.json({ connection }, { status: 201 })
      }
      if (path.endsWith('/rotate')) {
        revision += 1
        connections[0] = {
          ...connections[0],
          revision,
          rotatedAt: '2026-10-07T00:00:00.000Z',
        }
        return Response.json({ connection: connections[0] })
      }
      if (path.endsWith('/revoke')) {
        connections[0] = { ...connections[0], status: 'revoked' }
        return Response.json({ connection: connections[0] })
      }
      return Response.json({ code: 'NOT_FOUND' }, { status: 404 })
    },
  })
}
