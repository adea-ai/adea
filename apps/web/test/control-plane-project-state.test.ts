import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  ensureControlPlaneProjectState,
  initializeControlPlaneProjectState,
  PROJECT_STATE_INITIALIZE_PATH,
  projectStateIdempotencyKey,
  resetInitializedProjectsForTests,
} from '../src/server/control-plane-project-state'
import { runAfterResponse, captureWaitUntil } from '../src/server/background-task'

const workspaceScope = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectScope = 'prj_01JABCDEF0123456789ABCDEFG'

type Sent = Readonly<{
  url: string
  body: Record<string, unknown>
  claims: Record<string, unknown>
}>
type LogEntry = Readonly<{ level: string; entry: Readonly<Record<string, unknown>> }>

async function signingEnvironment(): Promise<Record<string, string>> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  return {
    CONTROL_PLANE_ORIGIN: 'https://control-plane.example',
    CONTROL_PLANE_SIGNING_ISSUER: 'https://adea.example/control-plane',
    CONTROL_PLANE_SIGNING_KEY: JSON.stringify(
      await crypto.subtle.exportKey('jwk', pair.privateKey)
    ),
    CONTROL_PLANE_SIGNING_KEY_ID: 'adea-web-test',
  }
}

function fakeControlPlane(sent: Sent[], respond: () => Response | Promise<Response>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const token = String(new Headers(init?.headers).get('Authorization')).replace(/^Bearer /u, '')
    sent.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      claims: JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')),
      url: String(input),
    })
    return respond()
  }) as typeof fetch
}

const mapped = async () => ({ projectId: projectScope, workspaceId: workspaceScope })

describe('Control Plane project-state initialization (ADR 0013)', () => {
  let logs: LogEntry[]
  const log = (level: 'debug' | 'warn', entry: Readonly<Record<string, unknown>>) => {
    logs.push({ entry, level })
  }

  beforeEach(() => {
    logs = []
    resetInitializedProjectsForTests()
  })

  test('initializes with exact claims and a project-fixed idempotency key', async () => {
    const environment = await signingEnvironment()
    const sent: Sent[] = []
    const outcome = await initializeControlPlaneProjectState(mapped, {
      environment,
      fetch: fakeControlPlane(sent, () => Response.json({ data: { projectState: {} } })),
      log,
    })

    expect(outcome).toBe('initialized')
    expect(sent).toHaveLength(1)
    const [hop] = sent
    expect(hop?.url).toBe(`https://control-plane.example${PROJECT_STATE_INITIALIZE_PATH}`)
    expect(hop?.claims).toMatchObject({
      projectIds: [projectScope],
      scopes: ['project-state:initialize'],
      workspaceIds: [workspaceScope],
    })
    expect(hop?.body).toMatchObject({
      caller: { servicePrincipalId: 'svc_agent-hq' },
      idempotencyKey: `project-state-init:${projectScope}`,
      operation: 'project-state.initialize',
      payload: {},
      payloadHash: createHash('sha256').update('{}').digest('hex'),
      projectId: projectScope,
      workspaceId: workspaceScope,
    })
    expect(hop?.body.commandId).toMatch(/^cmd_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(projectStateIdempotencyKey(projectScope)).toBe(`project-state-init:${projectScope}`)
    expect(logs).toEqual([])
  })

  test('treats PROJECT_STATE_ALREADY_INITIALIZED as success', async () => {
    const environment = await signingEnvironment()
    const sent: Sent[] = []
    const outcome = await initializeControlPlaneProjectState(mapped, {
      environment,
      fetch: fakeControlPlane(sent, () =>
        Response.json(
          { error: { code: 'PROJECT_STATE_ALREADY_INITIALIZED', message: 'exists' } },
          { status: 409 }
        )
      ),
      log,
    })
    expect(outcome).toBe('already-initialized')
    expect(logs).toEqual([])
  })

  test('a 5xx is swallowed and logged without the credential', async () => {
    const environment = await signingEnvironment()
    const sent: Sent[] = []
    const outcome = await initializeControlPlaneProjectState(mapped, {
      environment,
      fetch: fakeControlPlane(sent, () =>
        Response.json({ error: { code: 'INTERNAL' } }, { status: 503 })
      ),
      log,
    })
    expect(outcome).toBe('failed')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      entry: {
        event: 'control_plane.project_state.initialize_failed',
        projectId: projectScope,
        status: 503,
      },
      level: 'warn',
    })
    const logged = JSON.stringify(logs)
    expect(logged).not.toContain('Bearer')
    expect(logged).not.toContain(environment.CONTROL_PLANE_SIGNING_KEY ?? '')
  })

  test('a different idempotency conflict is a logged failure, not success', async () => {
    const environment = await signingEnvironment()
    const outcome = await initializeControlPlaneProjectState(mapped, {
      environment,
      fetch: fakeControlPlane([], () =>
        Response.json({ error: { code: 'PROJECT_STATE_IDEMPOTENCY_CONFLICT' } }, { status: 409 })
      ),
      log,
    })
    expect(outcome).toBe('failed')
    expect(logs[0]?.entry).toMatchObject({
      code: 'PROJECT_STATE_IDEMPOTENCY_CONFLICT',
      status: 409,
    })
  })

  test('a network failure or timeout is swallowed and logged', async () => {
    const environment = await signingEnvironment()
    const outcome = await initializeControlPlaneProjectState(mapped, {
      environment,
      fetch: (async (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })) as typeof fetch,
      log,
      timeoutMs: 10,
    })
    expect(outcome).toBe('failed')
    expect(logs[0]?.entry).toMatchObject({ reason: 'timeout' })
  })

  test('the static fallback skips with a debug line and never resolves the scope', async () => {
    let resolved = false
    const sent: Sent[] = []
    const outcome = await initializeControlPlaneProjectState(
      async () => {
        resolved = true
        return { projectId: projectScope, workspaceId: workspaceScope }
      },
      {
        environment: {
          CONTROL_PLANE_ORIGIN: 'https://control-plane.example',
          CONTROL_PLANE_SCOPE_WORKSPACE_ID: workspaceScope,
          CONTROL_PLANE_SERVICE_TOKEN: 'test-token',
        },
        fetch: fakeControlPlane(sent, () => Response.json({})),
        log,
      }
    )
    expect(outcome).toBe('skipped')
    expect(resolved).toBeFalse()
    expect(sent).toHaveLength(0)
    expect(logs).toEqual([
      {
        entry: { event: 'control_plane.project_state.initialize_skipped', reason: 'unscoped' },
        level: 'debug',
      },
    ])
  })

  test('an unmapped project fails closed without a Control Plane call', async () => {
    const environment = await signingEnvironment()
    const sent: Sent[] = []
    const outcome = await initializeControlPlaneProjectState(
      async () => ({ workspaceId: workspaceScope }),
      { environment, fetch: fakeControlPlane(sent, () => Response.json({})), log }
    )
    expect(outcome).toBe('failed')
    expect(sent).toHaveLength(0)
  })

  test('the ensure path calls once per project per isolate', async () => {
    const environment = await signingEnvironment()
    const sent: Sent[] = []
    const dependencies = {
      environment,
      fetch: fakeControlPlane(sent, () => Response.json({ data: {} })),
      log,
    }
    expect(await ensureControlPlaneProjectState(mapped, dependencies)).toBe('initialized')
    expect(await ensureControlPlaneProjectState(mapped, dependencies)).toBe('already-initialized')
    expect(sent).toHaveLength(1)
  })
})

describe('post-response work', () => {
  test('hands the task to the captured waitUntil and never rejects', async () => {
    const held: Promise<unknown>[] = []
    captureWaitUntil((promise) => held.push(promise))
    try {
      let ran = false
      runAfterResponse(async () => {
        ran = true
        throw new Error('swallowed')
      })
      expect(held).toHaveLength(1)
      await expect(held[0]).resolves.toBeUndefined()
      expect(ran).toBeTrue()
    } finally {
      captureWaitUntil(undefined)
    }
  })

  test('runs detached when no waitUntil is captured', async () => {
    let ran = false
    runAfterResponse(async () => {
      ran = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ran).toBeTrue()
  })
})
