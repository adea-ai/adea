import { describe, expect, test } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  createWorkspacePermissionDatabase,
  runBuiltWorkerWorkspacePermissions,
  type WorkspacePermissionDatabase,
  type WorkspaceIdentityReadback,
} from './built-worker-workspace-permissions'
import {
  DESKTOP_CALLBACK_URI,
  DESKTOP_TRUSTED_ORIGIN,
  type BuiltWorkerRequest,
  type BuiltWorkerResponse,
} from './built-worker-desktop-auth'

const baseUrl = 'https://127.0.0.1:8790'
const digest = (value: string) => createHash('sha256').update(value).digest('base64url')
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { 'cache-control': 'private, no-store', ...headers } as Record<string, string>,
  body: JSON.stringify(body),
})

type Account = {
  email: string
  password: string
  providerId: string
  providerSessionId: string
  userId: string
  cookie: string
  token: string
  sessionId: string
  credential: string
  revoked: boolean
  signedOut: boolean
}
type Fault =
  | 'outsider'
  | 'owner'
  | 'list-leak'
  | 'add'
  | 'remove'
  | 'digest'
  | 'join'
  | 'duplicate'
  | 'plain'
  | 'revoke'
  | 'logout'
  | 'origin'
  | 'leak-body'
  | 'leak-header'
  | 'personal'
  | 'cache'
  | 'cors'
  | 'create-uncertain'
  | 'caller-credential'
  | 'password-credential'
  | 'provider-session'
  | 'cookie-deny'

function fixture(fault?: Fault) {
  const accounts: Account[] = []
  const codes = new Map<string, Account>()
  const requests: BuiltWorkerRequest[] = []
  const workspaceId = randomUUID()
  const members = new Set<string>()
  let created = false
  let createCalls = 0
  let addCalls = 0
  let removeCalls = 0
  const transport = async (request: BuiltWorkerRequest): Promise<BuiltWorkerResponse> => {
    requests.push(request)
    const origin = request.headers?.origin
    const cors: Record<string, string> =
      origin === DESKTOP_TRUSTED_ORIGIN && fault !== 'cors'
        ? { 'access-control-allow-origin': origin }
        : {}
    const respond = (status: number, value: unknown, extra: Record<string, string> = {}) => {
      const response = json(status, value, { ...cors, ...extra })
      if (fault === 'cache' && request.path.startsWith('/api/workspaces'))
        delete response.headers['cache-control']
      if (fault === 'leak-header' && request.path.startsWith('/api/workspaces'))
        response.headers['x-debug'] = accounts[0]!.credential
      if (fault === 'leak-body' && request.path.startsWith('/api/workspaces'))
        response.body = JSON.stringify({ debug: accounts[0]!.credential })
      return response
    }
    if (request.path === '/api/auth/sign-up/email') {
      const body = JSON.parse(request.body!)
      const token = randomBytes(24).toString('base64url')
      const account: Account = {
        email: body.email,
        password: body.password,
        providerId: randomUUID(),
        providerSessionId: randomUUID(),
        userId: randomUUID(),
        cookie: `__Secure-better-auth.session_token=${token}.signature`,
        token,
        sessionId: randomUUID(),
        credential:
          fault === 'caller-credential'
            ? 'caller-owned-auth-secret-123456789012345678'
            : fault === 'password-credential'
              ? body.password
              : randomBytes(32).toString('base64url'),
        revoked: false,
        signedOut: false,
      }
      accounts.push(account)
      return respond(
        200,
        { token, user: { id: account.providerId, email: body.email } },
        { 'set-cookie': `${account.cookie}; Secure; HttpOnly; SameSite=Lax` }
      )
    }
    if (request.path === '/api/auth/get-session?disableCookieCache=true') {
      const account = accounts.find(
        (item) => item.cookie === request.headers?.cookie && !item.signedOut
      )
      return respond(
        200,
        account
          ? {
              user: { id: account.providerId, email: account.email },
              session: { id: account.providerSessionId, token: account.token },
            }
          : null
      )
    }
    if (request.path.startsWith('/api/auth/desktop/authorize?')) {
      const account = accounts.find(
        (item) => item.cookie === request.headers?.cookie && !item.signedOut
      )
      if (!account) return respond(303, null, { location: '/sign-in' })
      const url = new URL(request.path, baseUrl)
      const code = randomBytes(24).toString('base64url')
      codes.set(code, account)
      const callback = new URL(DESKTOP_CALLBACK_URI)
      callback.searchParams.set('code', code)
      callback.searchParams.set('nonce', url.searchParams.get('nonce')!)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      return respond(303, null, {
        location: `/auth/desktop/complete#callback=${encodeURIComponent(callback.toString())}`,
      })
    }
    if (request.path === '/api/auth/desktop/exchange') {
      const account = codes.get(JSON.parse(request.body!).code)!
      return respond(200, {
        credential: account.credential,
        sessionId: account.sessionId,
        expiresAt: '2027-01-01T00:00:00.000Z',
      })
    }
    const account = accounts.find(
      (item) =>
        `Desktop ${item.credential}` === request.headers?.authorization &&
        item.sessionId === request.headers?.['x-adea-desktop-session'] &&
        !item.revoked
    )
    if (request.path === '/api/auth/desktop/revoke') {
      if (account && fault !== 'revoke') account.revoked = true
      return { status: 204, headers: { 'cache-control': 'no-store', ...cors }, body: '' }
    }
    if (request.path === '/api/auth/sign-out') {
      const provider = accounts.find((item) => item.cookie === request.headers?.cookie)!
      if (fault !== 'logout') provider.signedOut = true
      return respond(
        200,
        { success: true },
        { 'set-cookie': '__Secure-better-auth.session_token=; Max-Age=0; HttpOnly; Secure' }
      )
    }
    if (request.path.startsWith('/api/workspaces')) {
      if (
        request.headers?.['x-adea-client'] === 'desktop' &&
        origin !== DESKTOP_TRUSTED_ORIGIN &&
        fault !== 'origin'
      )
        return respond(403, { code: 'workspace_unavailable', message: 'Workspace unavailable' })
      const cookieAccount = accounts.find(
        (item) => item.cookie === request.headers?.cookie && !item.signedOut
      )
      const principal = account ?? (fault === 'cookie-deny' ? undefined : cookieAccount)
      if (!principal)
        return respond(401, { code: 'workspace_unavailable', message: 'Workspace unavailable' })
      if (request.method === 'POST') {
        createCalls += 1
        created = true
        members.add(principal.userId)
        if (fault === 'create-uncertain') throw new Error('transport lost after committed mutation')
        return respond(201, {
          created: true,
          workspace: {
            id: workspaceId,
            name: 'Permission proof',
            isPersonal: fault === 'personal',
          },
        })
      }
      const allowed = members.has(principal.userId) || fault === 'outsider'
      if (request.path === '/api/workspaces')
        return respond(
          200,
          created && (allowed || fault === 'list-leak') ? [{ id: workspaceId }] : []
        )
      if (!allowed || (fault === 'owner' && principal === accounts[0]))
        return respond(404, { code: 'workspace_unavailable', message: 'Workspace unavailable' })
      return respond(200, {
        workspace: { id: workspaceId, isPersonal: false },
        agents: [],
        tasks: [],
      })
    }
    return respond(404, {})
  }
  const database: WorkspacePermissionDatabase = {
    async identity({ email, sessionId }) {
      const account = accounts.find((item) => item.email === email && item.sessionId === sessionId)!
      const row: WorkspaceIdentityReadback = {
        providerSubject: account.providerId,
        providerSessionId: account.providerSessionId,
        userId: account.userId,
        sessionId: account.sessionId,
        credentialDigest: digest(account.credential),
        revoked: account.revoked,
      }
      if (fault === 'digest') row.credentialDigest = 'wrong'
      if (fault === 'plain') row.credentialDigest = account.credential
      if (fault === 'join') row.providerSubject = 'another-provider'
      if (fault === 'provider-session') row.providerSessionId = 'another-provider-session'
      return fault === 'duplicate' ? [row, row] : [row]
    },
    async workspace() {
      return {
        isPersonal: fault === 'personal',
        ownerUserId: accounts[0]!.userId,
        members: [...members].map((userId) => ({
          userId,
          role: userId === accounts[0]!.userId ? 'owner' : 'member',
        })),
      }
    },
    async addMember({ userId }) {
      addCalls += 1
      if (fault !== 'add') members.add(userId)
      return randomUUID()
    },
    async removeMember({ userId }) {
      removeCalls += 1
      if (fault !== 'remove') members.delete(userId)
      return true
    },
  }
  return {
    transport,
    database,
    requests,
    accounts,
    counts: () => ({ createCalls, addCalls, removeCalls }),
  }
}

const run = async (fault?: Fault) => {
  const setup = fixture(fault)
  const receipt = await runBuiltWorkerWorkspacePermissions({
    transport: setup.transport,
    database: setup.database,
    baseUrl,
    secrets: ['caller-owned-auth-secret-123456789012345678'],
  })
  return { setup, receipt }
}

describe('built Worker workspace permission proof', () => {
  test('proves actual HTTP access against exact measured identities and membership changes', async () => {
    const { setup, receipt } = await run()
    expect(receipt.assertions.filter((assertion) => !assertion.passed)).toEqual([])
    expect(receipt.status).toBe('passed')
    expect(receipt.failed).toBe(0)
    expect(receipt.passed).toBe(receipt.assertions.length)
    expect(receipt.assertions.length).toBeGreaterThanOrEqual(18)
    expect(receipt.assertions.every((assertion) => assertion.attempts === 1)).toBe(true)
    expect(receipt.limitations).toContain(
      'membership changes use the disposable database fixture, not the membership-management HTTP workflow'
    )
    expect(setup.counts()).toEqual({ createCalls: 1, addCalls: 1, removeCalls: 1 })
    const serialized = JSON.stringify(receipt)
    for (const account of setup.accounts)
      for (const value of [
        account.cookie,
        account.token,
        account.credential,
        account.email,
        account.userId,
        account.providerId,
      ])
        expect(serialized).not.toContain(value)
  })

  for (const fault of [
    'outsider',
    'owner',
    'list-leak',
    'add',
    'remove',
    'digest',
    'join',
    'duplicate',
    'plain',
    'revoke',
    'logout',
    'origin',
    'leak-body',
    'leak-header',
    'personal',
    'cache',
    'cors',
    'caller-credential',
    'password-credential',
    'provider-session',
  ] as const) {
    test(`refuses a broken ${fault} boundary`, async () => {
      const { receipt } = await run(fault)
      expect(receipt.status).toBe('failed')
      expect(receipt.failed).toBeGreaterThan(0)
    })
  }

  test('cannot pass signout proof when the workspace route refuses every provider cookie', async () => {
    const { setup, receipt } = await run('cookie-deny')
    expect(receipt.status).toBe('failed')
    expect(
      receipt.assertions.find(
        (assertion) =>
          assertion.name === 'provider-cookie-can-read-the-same-workspace-before-signout'
      )?.passed
    ).toBe(false)
    const cookieRead = setup.requests.find(
      (request) => request.path.startsWith('/api/workspaces/') && request.headers?.cookie
    )
    expect(cookieRead?.headers?.authorization).toBeUndefined()
    expect(cookieRead?.headers?.['x-adea-client']).toBeUndefined()
    expect(cookieRead?.headers?.origin).toBe(baseUrl)
    expect(setup.requests.some((request) => request.path === '/api/auth/sign-out')).toBe(false)
  })

  test('does not replay a workspace creation after uncertain committed transport', async () => {
    const { setup, receipt } = await run('create-uncertain')
    expect(receipt.status).toBe('failed')
    expect(setup.counts().createCalls).toBe(1)
    expect(setup.counts().addCalls).toBe(0)
  })

  test('does not publish transport or SQL failure details containing secrets', async () => {
    for (const target of ['transport', 'database'] as const) {
      const setup = fixture()
      const secret = 'synthetic-private-material-never-publish'
      if (target === 'transport')
        setup.transport = async () => {
          throw new Error(secret)
        }
      else
        setup.database.identity = async () => {
          throw new Error(secret)
        }
      const receipt = await runBuiltWorkerWorkspacePermissions({
        ...setup,
        baseUrl,
        secrets: [secret],
      })
      expect(receipt.status).toBe('failed')
      expect(JSON.stringify(receipt)).not.toContain(secret)
    }
  })
})

describe('owned disposable SQL readback fixture', () => {
  test('rejects identifiers instead of interpolating arbitrary provider schemas', () => {
    expect(() =>
      createWorkspacePermissionDatabase({ unsafe: async () => [] }, 'auth; drop schema app')
    ).toThrow()
  })

  test('uses bound values for every account/session/workspace/member identity', async () => {
    const calls: { query: string; parameters: readonly unknown[] }[] = []
    const database = createWorkspacePermissionDatabase(
      {
        unsafe: async (query, parameters = []) => {
          calls.push({ query, parameters })
          return []
        },
      },
      'proof_auth'
    )
    const marker = "untrusted-value-'--"
    await database.identity({ email: marker, sessionId: marker })
    await database.workspace(marker)
    await database.addMember({ workspaceId: marker, ownerUserId: marker, userId: marker })
    await database.removeMember({ workspaceId: marker, userId: marker, membershipId: marker })
    expect(calls).toHaveLength(4)
    for (const call of calls) {
      expect(call.query).not.toContain(marker)
      expect(call.parameters).toContain(marker)
    }
    expect(calls[2]!.query).toContain('not w.is_personal')
    expect(calls[3]!.query).toContain("role = 'member'")
  })
})

// The CLI must include both proofs in its verdict, not attach a failing
// workspace section to an otherwise passed desktop-auth receipt.
describe('combined built Worker receipt', () => {
  test('preserves all auth assertions and fails when workspace proof fails', async () => {
    const { composeWorkspacePermissionReceipt } =
      await import('./built-worker-workspace-permissions')
    const auth = {
      status: 'passed' as const,
      worker: { routes: ['/api/auth/desktop/exchange'] },
      assertions: [
        {
          name: 'original-auth-proof',
          passed: true,
          detail: '',
          attempts: 1,
          outcomes: ['passed' as const],
        },
      ],
      passed: 1,
      failed: 0,
    }
    const { receipt: workspace } = await run('outsider')
    const combined = composeWorkspacePermissionReceipt(auth, workspace)
    expect(combined.status).toBe('failed')
    expect(combined.assertions[0]!.name).toBe('original-auth-proof')
    expect(combined.failed).toBe(workspace.failed)
    expect(combined.passed + combined.failed).toBe(combined.assertions.length)
    expect(combined.workspacePermissions).toBe(workspace)
    expect(combined.worker.routes).toContain('/api/workspaces/$workspaceId')
  })
})
