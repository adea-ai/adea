// Local acceptance over the actual built Worker's HTTP routes. Database writes
// are limited to one newly created ordinary workspace's exact test membership.
// They prove authorization reacts to authoritative membership changes, not that
// the product membership-management HTTP workflow works.
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  DESKTOP_TRUSTED_ORIGIN,
  HOSTILE_ORIGIN,
  desktopAuthorizePath,
  desktopExchangeRequest,
  desktopNonceAndState,
  desktopPkcePair,
  freshAccountSignUpRequest,
  readDesktopSession,
  sessionCookieFrom,
  sessionCookieValues,
  signupTokenFrom,
  validateIssuedAuthorization,
  type BuiltWorkerRequest,
  type BuiltWorkerResponse,
  type BuiltWorkerTransport,
  type DesktopEndpointAssertion,
  type ValidatedDesktopSession,
} from './built-worker-desktop-auth'
import {
  jsonAllMemberValues,
  jsonMemberValues,
  rawCredentialValues,
  withoutTopLevelValue,
  withoutProviderSessionToken,
} from './built-worker-failures'

export type WorkspaceIdentityReadback = {
  providerSubject: string
  providerSessionId: string
  userId: string
  sessionId: string
  credentialDigest: string
  revoked: boolean
  profileAddressPresent: boolean
  profileAddressCompatible: boolean
}
export type WorkspaceReadback = {
  readonly isPersonal: boolean
  readonly ownerUserId: string
  readonly members: readonly { readonly userId: string; readonly role: string }[]
}
export type WorkspacePermissionDatabase = {
  identity(input: {
    email: string
    sessionId: string
  }): Promise<readonly WorkspaceIdentityReadback[]>
  workspace(workspaceId: string): Promise<WorkspaceReadback | null>
  addMember(input: {
    workspaceId: string
    ownerUserId: string
    userId: string
  }): Promise<string | null>
  removeMember(input: {
    workspaceId: string
    userId: string
    membershipId: string
  }): Promise<boolean>
}
export type WorkspacePermissionReceipt = {
  readonly proofKind: 'built-worker-workspace-permissions'
  readonly status: 'passed' | 'failed'
  readonly assertions: readonly DesktopEndpointAssertion[]
  readonly passed: number
  readonly failed: number
  readonly limitations: readonly string[]
  readonly diagnostics: readonly WorkspacePermissionDiagnostic[]
}

type Phase =
  | 'permission-assertion'
  | 'account-signup'
  | 'provider-session-read'
  | 'desktop-authorize'
  | 'desktop-exchange'
  | 'identity-readback'
  | 'identity-join-check'
  | 'account-distinctness'
type AccountOrdinal = 'first' | 'second' | 'none'
type Predicate =
  | 'httpAccepted'
  | 'sessionPresent'
  | 'cookiePresent'
  | 'notCacheable'
  | 'subjectMatches'
  | 'addressMatches'
  | 'materialShapeValid'
  | 'materialCountValid'
  | 'authorizationValid'
  | 'corsTrusted'
  | 'rowCountOne'
  | 'providerSessionMatches'
  | 'applicationUserValid'
  | 'desktopSessionMatches'
  | 'digestMatches'
  | 'notPlain'
  | 'revocationMatches'
  | 'addressPresent'
  | 'addressCompatible'
  | 'addressShapeValid'
  | 'subjectsDistinct'
  | 'usersDistinct'
  | 'sessionsDistinct'
  | 'materialDistinct'
export type WorkspacePermissionDiagnostic = {
  readonly step: string
  readonly phase: Phase
  readonly account: AccountOrdinal
  readonly status?: number
  readonly rowCount?: number
  readonly predicates: Readonly<Partial<Record<Predicate, boolean>>>
  readonly passed: boolean
  readonly errorCategory?:
    | 'assertion'
    | 'sql'
    | 'database'
    | 'transport'
    | 'tls-certificate'
    | 'tls-hostname'
    | 'tls-protocol'
    | 'connection'
  readonly sqlState?: string
}
const approvedSqlStates = new Set([
  '42501',
  '42P01',
  '42703',
  '3F000',
  '28P01',
  '28000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '53300',
  '40001',
  '40P01',
  '23505',
  '23503',
  '22023',
  '22P02',
])
function classifyFailure(
  error: unknown,
  boundary: 'assertion' | 'database' | 'http'
): Pick<WorkspacePermissionDiagnostic, 'errorCategory' | 'sqlState'> {
  // Never read message/query/parameters or stringify an unknown exception. Only
  // exact source-owned allowlists can disclose a SQLSTATE or TLS category.
  let code: unknown
  try {
    code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  } catch {
    code = undefined
  }
  if (typeof code === 'string') {
    if (approvedSqlStates.has(code)) return { errorCategory: 'sql', sqlState: code }
    if (
      [
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'CERT_HAS_EXPIRED',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      ].includes(code)
    )
      return { errorCategory: 'tls-certificate' }
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return { errorCategory: 'tls-hostname' }
    if (['ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', 'ERR_SSL_WRONG_VERSION_NUMBER'].includes(code))
      return { errorCategory: 'tls-protocol' }
    if (['CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code))
      return { errorCategory: 'connection' }
  }
  return {
    errorCategory:
      boundary === 'database' ? 'database' : boundary === 'http' ? 'transport' : 'assertion',
  }
}

type SqlReadback = {
  unsafe(query: string, parameters?: readonly string[]): Promise<readonly Record<string, unknown>[]>
}

/** This client is supplied only by the CLI that owns the disposable database. */
export function createWorkspacePermissionDatabase(
  sql: SqlReadback,
  providerSchema: string
): WorkspacePermissionDatabase {
  if (!/^[a-z_][a-z0-9_]*$/u.test(providerSchema)) throw new Error('Invalid proof provider schema')
  return {
    async identity({ email, sessionId }) {
      // Joining both provider tables independently prevents an application row
      // that merely repeats an email from masquerading as an authenticated user.
      const rows = await sql.unsafe(
        `
        select pu.id as "providerSubject", ps.id as "providerSessionId",
          u.id as "userId", ds.session_id as "sessionId",
          ds.credential_digest as "credentialDigest", (ds.revoked_at is not null) as revoked,
          (ds.email is not null) as "profileAddressPresent", (ds.email is null or ds.email = pu.email) as "profileAddressCompatible"
        from app.desktop_sessions ds
        join app.users u on u.id = ds.user_id and u.disabled_at is null
        join app.auth_identities ai on ai.user_id = u.id and ai.provider = 'better-auth' and ai.revoked_at is null
        join "${providerSchema}"."user" pu on pu.id = ai.subject and (ds.email is null or ds.email = pu.email)
        join "${providerSchema}"."account" pa on pa."userId" = pu.id and pa."providerId" = 'credential'
        join "${providerSchema}"."session" ps on ps.id = ds.provider_session_id and ps."userId" = pu.id
        where ds.session_id = $1::uuid and pu.email = $2`,
        [sessionId, email]
      )
      return rows.map((row) => {
        requireProof(
          ['providerSubject', 'providerSessionId', 'userId', 'sessionId', 'credentialDigest'].every(
            (field) => typeof row[field] === 'string'
          ) &&
            typeof row.revoked === 'boolean' &&
            typeof row.profileAddressPresent === 'boolean' &&
            typeof row.profileAddressCompatible === 'boolean'
        )
        return {
          providerSubject: row.providerSubject as string,
          providerSessionId: row.providerSessionId as string,
          userId: row.userId as string,
          sessionId: row.sessionId as string,
          credentialDigest: row.credentialDigest as string,
          revoked: row.revoked,
          profileAddressPresent: row.profileAddressPresent as boolean,
          profileAddressCompatible: row.profileAddressCompatible as boolean,
        }
      })
    },
    async workspace(workspaceId) {
      const rows = await sql.unsafe(
        `
        select w.is_personal as "isPersonal", w.owner_user_id as "ownerUserId", m.user_id as "userId", m.role
        from app.workspaces w join app.workspace_memberships m on m.workspace_id = w.id
        where w.id = $1::uuid and w.deleted_at is null order by m.user_id`,
        [workspaceId]
      )
      if (!rows.length) return null
      requireProof(
        rows.every(
          (row) =>
            typeof row.isPersonal === 'boolean' &&
            typeof row.ownerUserId === 'string' &&
            typeof row.userId === 'string' &&
            typeof row.role === 'string'
        )
      )
      return {
        isPersonal: rows[0]!.isPersonal === true,
        ownerUserId: String(rows[0]!.ownerUserId),
        members: rows.map((row) => ({ userId: String(row.userId), role: String(row.role) })),
      }
    },
    async addMember({ workspaceId, ownerUserId, userId }) {
      const rows = await sql.unsafe(
        `
        insert into app.workspace_memberships (workspace_id, user_id, role, sort_order)
        select w.id, $3::uuid, 'member', 0 from app.workspaces w
        join app.workspace_memberships owner on owner.workspace_id = w.id and owner.user_id = $2::uuid and owner.role = 'owner'
        where w.id = $1::uuid and w.owner_user_id = $2::uuid and not w.is_personal and w.deleted_at is null
        returning id`,
        [workspaceId, ownerUserId, userId]
      )
      return rows.length === 1 && typeof rows[0]!.id === 'string' ? rows[0]!.id : null
    },
    async removeMember({ workspaceId, userId, membershipId }) {
      const rows = await sql.unsafe(
        `
        delete from app.workspace_memberships m using app.workspaces w
        where m.id = $3::uuid and m.workspace_id = $1::uuid and m.user_id = $2::uuid and m.role = 'member'
          and w.id = m.workspace_id and not w.is_personal and w.deleted_at is null
        returning m.id`,
        [workspaceId, userId, membershipId]
      )
      return rows.length === 1 && rows[0]!.id === membershipId
    },
  }
}

type Account = {
  ordinal: 'first' | 'second'
  email: string
  providerId: string
  providerSessionId: string
  cookie: string
  session: ValidatedDesktopSession
  identity: WorkspaceIdentityReadback
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')
const record = (body: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(body)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Expected object')
  return parsed as Record<string, unknown>
}
function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error('Acceptance assertion failed')
}
const noStore = (response: BuiltWorkerResponse) =>
  response.headers['cache-control']
    ?.split(',')
    .some((value) => value.trim().toLowerCase() === 'no-store') === true

const trustedResponse = (response: BuiltWorkerResponse) =>
  requireProof(response.headers['access-control-allow-origin'] === DESKTOP_TRUSTED_ORIGIN)

const denied = (response: BuiltWorkerResponse, status: number) => {
  requireProof(response.status === status && noStore(response))
  const body = record(response.body)
  requireProof(
    body.code === 'workspace_unavailable' &&
      body.message === 'Workspace unavailable' &&
      !('workspace' in body)
  )
}

/** All HTTP mutations and SQL fixture writes are single-attempt, even if their
 * response is lost after committing. No raw responses/errors enter a receipt. */
export async function runBuiltWorkerWorkspacePermissions(input: {
  readonly transport: BuiltWorkerTransport
  readonly database: WorkspacePermissionDatabase
  readonly baseUrl: string
  readonly secrets?: readonly string[]
}): Promise<WorkspacePermissionReceipt> {
  const assertions: DesktopEndpointAssertion[] = []
  const diagnostics: WorkspacePermissionDiagnostic[] = []
  let boundary: 'assertion' | 'database' | 'http' = 'assertion'
  let diagnostic: Omit<WorkspacePermissionDiagnostic, 'step' | 'passed'> = {
    phase: 'permission-assertion',
    account: 'none',
    predicates: {},
  }
  const phase = (name: Phase, account: AccountOrdinal = 'none') => {
    diagnostic = { phase: name, account, predicates: {} }
    boundary = 'assertion'
  }
  const predicates = (values: Partial<Record<Predicate, boolean>>) => {
    diagnostic = { ...diagnostic, predicates: { ...diagnostic.predicates, ...values } }
  }
  const databaseCall = async <T>(read: () => Promise<T>): Promise<T> => {
    boundary = 'database'
    const value = await read()
    boundary = 'assertion'
    return value
  }

  const responses: BuiltWorkerResponse[] = []
  const callerSecrets = new Set(input.secrets ?? [])
  const secrets = [...callerSecrets]
  // Secrets are tracked with their own allowed occurrence, never a blanket
  // response exemption. A duplicate in an issuing response still fails.
  const allowed = new Map<
    string,
    {
      index: number
      header?: string
      bodyField?: string
      fragment?: boolean
      providerSession?: boolean
    }[]
  >()
  const observe = (
    value: string,
    index: number,
    exemption: {
      header?: string
      bodyField?: string
      fragment?: boolean
      providerSession?: boolean
    }
  ) => {
    if (!value) return
    secrets.push(value)
    if (callerSecrets.has(value)) return
    allowed.set(value, [...(allowed.get(value) ?? []), { index, ...exemption }])
  }
  const send = async (request: BuiltWorkerRequest) => {
    boundary = 'http'
    const response = await input.transport(request)
    boundary = 'assertion'
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599)
      diagnostic = { ...diagnostic, status: response.status }
    const index = responses.length
    responses.push(response)
    for (const value of rawCredentialValues(response.body)) secrets.push(value)
    for (const value of jsonMemberValues(response.body, 'token')) if (value) secrets.push(value)
    for (const value of sessionCookieValues(response)) secrets.push(value)
    return { response, index }
  }
  let active = true
  const step = async (name: string, run: () => Promise<void>) => {
    if (!active) return
    let passed = false
    phase('permission-assertion')
    try {
      await run()
      passed = true
    } catch (error) {
      diagnostic = { ...diagnostic, ...classifyFailure(error, boundary) }
      active = false
    }
    diagnostics.push({ ...diagnostic, step: name, passed })
    assertions.push({
      name,
      passed,
      detail: passed
        ? 'the local HTTP and database assertion passed'
        : 'the local HTTP or authoritative database assertion failed',
      attempts: 1,
      outcomes: [passed ? 'passed' : 'assertion-failed'],
    })
  }
  const desktopHeaders = (account: Account, origin = DESKTOP_TRUSTED_ORIGIN) => ({
    authorization: `Desktop ${account.session.credential}`,
    'x-adea-desktop-session': account.session.sessionId,
    'x-adea-client': 'desktop',
    origin,
  })
  const identity = async (account: Account, revoked: boolean) => {
    phase('identity-readback', account.ordinal)
    const rows = await databaseCall(() =>
      input.database.identity({ email: account.email, sessionId: account.session.sessionId })
    )
    diagnostic = { ...diagnostic, rowCount: Math.min(rows.length, 1000) }
    predicates({ rowCountOne: rows.length === 1 })
    requireProof(rows.length === 1)
    const row = rows[0]!
    diagnostic = { ...diagnostic, phase: 'identity-join-check' }
    predicates({
      subjectMatches: row.providerSubject === account.providerId,
      providerSessionMatches: row.providerSessionId === account.providerSessionId,
      applicationUserValid: uuid.test(row.userId),
      desktopSessionMatches: row.sessionId === account.session.sessionId,
      digestMatches: row.credentialDigest === hash(account.session.credential),
      notPlain: row.credentialDigest !== account.session.credential,
      revocationMatches: row.revoked === revoked,
      addressPresent: row.profileAddressPresent === true,
      addressCompatible: row.profileAddressCompatible === true,
      addressShapeValid:
        typeof row.profileAddressPresent === 'boolean' &&
        typeof row.profileAddressCompatible === 'boolean',
    })
    requireProof(
      row.providerSubject === account.providerId &&
        row.providerSessionId === account.providerSessionId &&
        uuid.test(row.userId) &&
        row.sessionId === account.session.sessionId &&
        row.credentialDigest === hash(account.session.credential) &&
        row.credentialDigest !== account.session.credential &&
        row.revoked === revoked &&
        row.profileAddressCompatible === true &&
        typeof row.profileAddressPresent === 'boolean'
    )
    diagnostics.push({
      ...diagnostic,
      step: revoked ? 'revoked-identity-readback' : 'fresh-identity-readback',
      passed: true,
    })
    return row
  }
  const createAccount = async (ordinal: 'first' | 'second'): Promise<Account> => {
    phase('account-signup', ordinal)
    const email = `permission-${randomUUID()}@example.test`
    const password = randomBytes(24).toString('base64url')
    callerSecrets.add(password)
    secrets.push(password)
    const signup = await send(
      freshAccountSignUpRequest({ baseUrl: input.baseUrl, email, password })
    )
    const cookie = sessionCookieFrom(signup.response)
    predicates({
      httpAccepted: signup.response.status === 200,
      cookiePresent: Boolean(cookie),
      notCacheable: noStore(signup.response),
    })
    requireProof(signup.response.status === 200 && cookie && noStore(signup.response))
    for (const value of sessionCookieValues(signup.response))
      observe(value, signup.index, { header: 'set-cookie' })
    const token = signupTokenFrom(signup.response)
    if (token) {
      observe(token, signup.index, { bodyField: 'token' })
      observe(token, signup.index, { header: 'set-cookie' })
    }
    const user = record(signup.response.body).user
    requireProof(user && typeof user === 'object' && !Array.isArray(user))
    const providerId = (user as Record<string, unknown>).id
    requireProof(typeof providerId === 'string' && providerId.length > 0)
    phase('provider-session-read', ordinal)
    const readback = await send({
      method: 'GET',
      path: '/api/auth/get-session?disableCookieCache=true',
      headers: { cookie, origin: input.baseUrl },
    })
    requireProof(readback.response.status === 200 && noStore(readback.response))
    const providerPayload = record(readback.response.body)
    const providerUser = providerPayload.user as Record<string, unknown> | undefined
    const providerSession = providerPayload.session as Record<string, unknown> | undefined
    predicates({
      subjectMatches: providerUser?.id === providerId,
      addressMatches: providerUser?.email === email,
      sessionPresent: typeof providerSession?.id === 'string' && providerSession.id.length > 0,
    })
    requireProof(
      providerUser?.id === providerId &&
        providerUser?.email === email &&
        providerSession &&
        typeof providerSession.id === 'string' &&
        providerSession.id.length > 0
    )
    requireProof(
      providerSession.token === undefined ||
        (typeof providerSession.token === 'string' && providerSession.token.length > 0)
    )
    const providerTokens = jsonMemberValues(readback.response.body, 'token')
    predicates({
      materialCountValid: providerSession.token
        ? providerTokens.length === 1 && providerTokens[0] === providerSession.token
        : providerTokens.length === 0,
    })
    requireProof(
      providerSession.token
        ? providerTokens.length === 1 && providerTokens[0] === providerSession.token
        : providerTokens.length === 0
    )
    if (typeof providerSession.token === 'string')
      observe(providerSession.token, readback.index, { providerSession: true })
    const pkce = desktopPkcePair()
    const { nonce, state } = desktopNonceAndState()
    phase('desktop-authorize', ordinal)
    const authorization = await send({
      method: 'GET',
      path: desktopAuthorizePath({ challenge: pkce.challenge, nonce, state }),
      headers: { cookie },
    })
    const validation = validateIssuedAuthorization({
      status: authorization.response.status,
      location: authorization.response.headers.location ?? '',
      expectedOrigin: new URL(input.baseUrl).origin,
      expectedNonce: nonce,
      expectedState: state,
    })
    predicates({ authorizationValid: validation.ok })
    requireProof(validation.ok)
    observe(validation.authorization.code, authorization.index, {
      header: 'location',
      fragment: true,
    })
    phase('desktop-exchange', ordinal)
    const exchange = await send(
      desktopExchangeRequest({
        code: validation.authorization.code,
        verifier: pkce.verifier,
        nonce,
        origin: DESKTOP_TRUSTED_ORIGIN,
      })
    )
    const session = readDesktopSession(exchange.response.body)
    predicates({
      httpAccepted: exchange.response.status === 200,
      sessionPresent: Boolean(session),
      notCacheable: noStore(exchange.response),
      corsTrusted:
        exchange.response.headers['access-control-allow-origin'] === DESKTOP_TRUSTED_ORIGIN,
    })
    requireProof(exchange.response.status === 200 && session && noStore(exchange.response))
    trustedResponse(exchange.response)
    observe(session.credential, exchange.index, { bodyField: 'credential' })
    const account = {
      ordinal,
      email,
      providerId,
      providerSessionId: providerSession.id,
      cookie,
      session,
      identity: undefined as unknown as WorkspaceIdentityReadback,
    }
    account.identity = await identity(account, false)
    return account
  }
  let a: Account
  let b: Account
  let workspaceId = ''
  let membershipId = ''
  await step('two-fresh-http-accounts-map-to-distinct-persisted-desktop-principals', async () => {
    a = await createAccount('first')
    b = await createAccount('second')
    phase('account-distinctness')
    requireProof(
      a.providerId !== b.providerId &&
        a.identity.userId !== b.identity.userId &&
        a.session.sessionId !== b.session.sessionId &&
        a.session.credential !== b.session.credential
    )
  })
  const workspaceRequest = async (account: Account, path: string) => {
    const { response } = await send({ method: 'GET', path, headers: desktopHeaders(account) })
    trustedResponse(response)
    return response
  }
  const visible = (response: BuiltWorkerResponse, expected: boolean) => {
    requireProof(response.status === 200 && noStore(response))
    const list: unknown = JSON.parse(response.body)
    requireProof(Array.isArray(list))
    requireProof(
      list.some(
        (item: unknown) =>
          item && typeof item === 'object' && (item as Record<string, unknown>).id === workspaceId
      ) === expected
    )
  }
  const readable = async (account: Account) => {
    const response = await workspaceRequest(account, `/api/workspaces/${workspaceId}`)
    requireProof(response.status === 200 && noStore(response))
    const workspace = record(response.body).workspace
    requireProof(
      workspace &&
        typeof workspace === 'object' &&
        (workspace as Record<string, unknown>).id === workspaceId
    )
  }
  const membership = async (member: boolean) => {
    const measured = await databaseCall(() => input.database.workspace(workspaceId))
    requireProof(measured && !measured.isPersonal && measured.ownerUserId === a.identity.userId)
    requireProof(measured.members.length === (member ? 2 : 1))
    requireProof(
      measured.members.filter((row) => row.userId === a.identity.userId && row.role === 'owner')
        .length === 1
    )
    requireProof(
      measured.members.filter((row) => row.userId === b.identity.userId && row.role === 'member')
        .length === (member ? 1 : 0)
    )
  }
  await step('owner-creates-one-ordinary-http-workspace', async () => {
    const { response } = await send({
      method: 'POST',
      path: '/api/workspaces',
      headers: {
        ...desktopHeaders(a),
        'content-type': 'application/json',
        'idempotency-key': `permission-${randomUUID()}`,
      },
      body: JSON.stringify({ name: 'Permission proof', scene: 'work' }),
    })
    trustedResponse(response)
    requireProof(response.status === 201)
    const payload = record(response.body)
    const workspace = payload.workspace as Record<string, unknown> | undefined
    requireProof(
      payload.created === true &&
        workspace &&
        typeof workspace.id === 'string' &&
        uuid.test(workspace.id) &&
        workspace.isPersonal === false
    )
    workspaceId = workspace.id
    await membership(false)
  })
  await step('owner-can-list-the-created-workspace', async () =>
    visible(await workspaceRequest(a, '/api/workspaces'), true)
  )
  await step('owner-can-read-the-created-workspace', async () => readable(a))
  await step('outsider-cannot-list-the-created-workspace', async () =>
    visible(await workspaceRequest(b, '/api/workspaces'), false)
  )
  await step('outsider-cannot-read-the-created-workspace', async () =>
    denied(await workspaceRequest(b, `/api/workspaces/${workspaceId}`), 404)
  )
  await step('unsigned-request-cannot-read-the-workspace', async () => {
    const { response } = await send({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}`,
      headers: { origin: DESKTOP_TRUSTED_ORIGIN, 'x-adea-client': 'desktop' },
    })
    trustedResponse(response)
    denied(response, 401)
  })
  await step('hostile-desktop-origin-cannot-read-the-workspace', async () => {
    const { response } = await send({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}`,
      headers: desktopHeaders(a, HOSTILE_ORIGIN),
    })
    denied(response, 403)
    requireProof(noStore(response) && !response.headers['access-control-allow-origin'])
  })
  await step('owned-fixture-adds-exact-member-with-authoritative-readback', async () => {
    const id = await databaseCall(() =>
      input.database.addMember({
        workspaceId,
        ownerUserId: a.identity.userId,
        userId: b.identity.userId,
      })
    )
    requireProof(id && uuid.test(id))
    membershipId = id
    await membership(true)
  })
  await step('new-member-can-list-the-workspace', async () =>
    visible(await workspaceRequest(b, '/api/workspaces'), true)
  )
  await step('new-member-can-read-the-workspace', async () => readable(b))
  await step('owned-fixture-removes-only-exact-member-with-authoritative-readback', async () => {
    requireProof(
      await databaseCall(() =>
        input.database.removeMember({ workspaceId, userId: b.identity.userId, membershipId })
      )
    )
    await membership(false)
  })
  await step('removed-member-cannot-list-the-workspace', async () =>
    visible(await workspaceRequest(b, '/api/workspaces'), false)
  )
  await step('removed-member-cannot-read-the-workspace', async () =>
    denied(await workspaceRequest(b, `/api/workspaces/${workspaceId}`), 404)
  )
  await step('owner-retains-access-after-other-member-removal', async () => readable(a))
  await step('desktop-revocation-is-authoritatively-persisted', async () => {
    const { response } = await send({
      method: 'POST',
      path: '/api/auth/desktop/revoke',
      headers: desktopHeaders(b),
    })
    requireProof(response.status === 204 && response.body === '' && noStore(response))
    trustedResponse(response)
    await identity(b, true)
  })
  await step('revoked-desktop-credential-cannot-read-the-workspace', async () =>
    denied(await workspaceRequest(b, `/api/workspaces/${workspaceId}`), 401)
  )
  // Prove this route accepts provider-cookie authentication before relying on
  // its post-signout refusal. Otherwise a Desktop-only route would pass both.
  await step('provider-cookie-can-read-the-same-workspace-before-signout', async () => {
    const { response } = await send({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}`,
      headers: { cookie: a.cookie, origin: input.baseUrl },
    })
    requireProof(response.status === 200 && noStore(response))
    const workspace = record(response.body).workspace
    requireProof(
      workspace &&
        typeof workspace === 'object' &&
        (workspace as Record<string, unknown>).id === workspaceId
    )
  })
  await step('provider-signout-invalidates-cookie-workspace-access', async () => {
    const { response } = await send({
      method: 'POST',
      path: '/api/auth/sign-out',
      headers: { 'content-type': 'application/json', origin: input.baseUrl, cookie: a.cookie },
      body: '{}',
    })
    requireProof(
      response.status === 200 && record(response.body).success === true && noStore(response)
    )
    const after = await send({
      method: 'GET',
      path: `/api/workspaces/${workspaceId}`,
      headers: { cookie: a.cookie, origin: input.baseUrl },
    })
    denied(after.response, 401)
  })
  // Run the leak check even after a failing step; raw exception text, SQL rows,
  // account IDs, email addresses and HTTP responses never enter the receipt.
  const leaks = secrets.some(
    (secret) =>
      secret &&
      responses.some((response, index) => {
        const exceptions = (allowed.get(secret) ?? []).filter((item) => item.index === index)
        const headers = Object.entries(response.headers)
          .map(([key, value]) => {
            const header = exceptions.find((item) => item.header === key)
            if (!header) return value
            return header.fragment ? value.split('#')[0]! : ''
          })
          .join(' ')
        const body = exceptions
          .filter((item) => item.bodyField || item.providerSession)
          .reduce(
            (text, item) =>
              item.providerSession
                ? withoutProviderSessionToken(text)
                : withoutTopLevelValue(text, item.bodyField!),
            response.body
          )
        return (
          `${headers}\n${body}`.includes(secret) ||
          jsonAllMemberValues(body).some((value) => value.includes(secret))
        )
      })
  )
  assertions.push({
    name: 'workspace-proof-responses-never-leak-credentials',
    passed: !leaks,
    detail: leaks
      ? 'a response carried private credential material'
      : 'responses contained only permitted issuance fields',
    attempts: 1,
    outcomes: [leaks ? 'assertion-failed' : 'passed'],
  })
  const notCacheable = responses.length > 0 && responses.every(noStore)
  assertions.push({
    name: 'all-workspace-proof-responses-are-not-cacheable',
    passed: notCacheable,
    detail: notCacheable
      ? 'all observed auth and permission responses prohibit caching'
      : 'an observed response did not prohibit caching',
    attempts: 1,
    outcomes: [notCacheable ? 'passed' : 'assertion-failed'],
  })
  const failed = assertions.filter((assertion) => !assertion.passed).length
  return {
    proofKind: 'built-worker-workspace-permissions',
    status: failed ? 'failed' : 'passed',
    assertions,
    passed: assertions.length - failed,
    failed,
    diagnostics,
    limitations: [
      'local disposable built Worker; email verification remains disabled',
      'membership changes use the disposable database fixture, not the membership-management HTTP workflow',
      'does not establish outbound email, installed-native or deployed Railway acceptance',
    ],
  }
}

/** The common top-level verdict counts every original and new assertion. */
export function composeWorkspacePermissionReceipt<
  T extends {
    readonly worker: { readonly routes: readonly string[] }
    readonly assertions: readonly DesktopEndpointAssertion[]
    readonly status: 'passed' | 'failed'
  },
>(
  auth: T,
  workspace: WorkspacePermissionReceipt
): Omit<T, 'status' | 'worker' | 'assertions'> & {
  worker: T['worker'] & { routes: string[] }
  assertions: DesktopEndpointAssertion[]
  passed: number
  failed: number
  status: 'passed' | 'failed'
  workspacePermissions: WorkspacePermissionReceipt
} {
  const assertions = [...auth.assertions, ...workspace.assertions]
  const failed = assertions.filter((assertion) => !assertion.passed).length
  return {
    ...auth,
    worker: {
      ...auth.worker,
      routes: [...auth.worker.routes, '/api/workspaces', '/api/workspaces/$workspaceId'],
    },
    assertions,
    passed: assertions.length - failed,
    failed,
    status:
      auth.status === 'passed' && workspace.status === 'passed' && failed === 0
        ? ('passed' as const)
        : ('failed' as const),
    workspacePermissions: workspace,
  }
}
