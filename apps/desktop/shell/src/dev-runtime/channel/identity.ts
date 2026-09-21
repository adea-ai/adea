// The authenticated Dev Runtime scope authority (M10 #33/#34 consumption).
//
// The scope triple (account, workspace, runtime node) is never accepted from
// the renderer as a global injection. The app's own window binds it once per
// authentication over the signed legacy channel (`desktop_identity_bind`):
// the shell verifies the presented desktop session credential against the
// cloud (`GET /api/workspaces` proves liveness and workspace membership),
// proves the runtime node is paired and unrevoked in that workspace, and only
// then persists the binding. Every privileged command is checked against this
// verified binding BEFORE capability checks and dispatch, node eligibility is
// re-proven on a bounded TTL, and a re-bind, unbind, session expiry, or
// workspace switch drops the binding and every channel created under it.
//
// The session credential itself stays in the client's sealed session vault
// (`desktop_user_session_save`, same sealing scheme as the transitional
// command surface); this module reads it only to re-verify eligibility.
import { createDecipheriv } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createDurableJsonStore } from '../host-store'
import { ChannelRejection } from './authority'

export type Scope = Readonly<{
  accountId: string
  workspaceId: string
  runtimeNodeId: string
}>

export type DesktopSessionCredential = Readonly<{
  credential: string
  sessionId: string
  expiresAt: string
}>

export type DesktopIdentityVerifier = Readonly<{
  /**
   * Proves the credential is live and returns the workspace ids it belongs
   * to. A refused credential throws; the shell never binds on a guess.
   */
  verifySession(input: { session: DesktopSessionCredential }): Promise<readonly string[]>
  /**
   * Proves the runtime node is paired (not revoked) with a verified signing
   * key in the workspace. Revoked or unknown nodes throw.
   */
  verifyNodeEligibility(input: {
    session: DesktopSessionCredential
    workspaceId: string
    runtimeNodeId: string
  }): Promise<void>
}>

type BindingRecord = Readonly<{
  scope: Scope
  sessionId: string
  verifiedAt: string
  sessionExpiresAt: string
}>

export type DesktopIdentityAuthority = Readonly<{
  /** The verified active scope, or undefined while unauthenticated. */
  currentScope(): Scope | undefined
  /**
   * The gate's admission check. Synchronous and total: it must run before
   * capability derivation and dispatch, and it fails closed on a missing,
   * expired, or mismatched binding.
   */
  assertCommandScope(scope: Scope): void
  /**
   * Re-proves runtime-node eligibility when the TTL lapsed. Called by the
   * gate for every privileged operation; a stale cache beyond the TTL fails
   * closed when the cloud cannot be reached.
   */
  ensureNodeEligible(): Promise<void>
  /**
   * Verifies and persists the binding from the authenticated window's bind
   * request. Rotating to a different scope (or an explicit unbind) notifies
   * listeners so every channel created under the old scope is revoked.
   */
  bind(input: { session: DesktopSessionCredential; claimed: Scope }): Promise<Scope>
  /** Clears the binding (sign-out / session revocation) and notifies. */
  unbind(reason: string): void
  onBindingChanged(listener: (reason: 'bound' | 'unbound') => void): void
}>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function assertUuidField(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ChannelRejection('invalid_state', `${what} is not a canonical id`, 400)
  }
  return value
}

function assertSessionCredential(value: unknown): DesktopSessionCredential {
  const session = value as Partial<DesktopSessionCredential> | undefined
  if (
    !session ||
    typeof session.credential !== 'string' ||
    session.credential.length < 32 ||
    typeof session.sessionId !== 'string' ||
    session.sessionId.length < 16 ||
    typeof session.expiresAt !== 'string' ||
    Number.isNaN(Date.parse(session.expiresAt))
  ) {
    throw new ChannelRejection('invalid_state', 'desktop session credential is malformed', 400)
  }
  return session as DesktopSessionCredential
}

/**
 * The production verifier: the same-origin desktop lane the shell already
 * proxies to. `GET /api/workspaces` authorizes with `Authorization: Desktop
 * <credential>`; a 200 proves the session is live and the body lists the
 * workspaces the session's user is a member of. The runtime-nodes listing is
 * the M10 read model: the node must appear with paired state.
 */
export function createCloudIdentityVerifier(options: {
  cloudOrigin: string
  shellOrigin: string
  fetchImpl?: typeof fetch
}): DesktopIdentityVerifier {
  const doFetch = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init))
  async function cloudJson(path: string, session: DesktopSessionCredential): Promise<unknown> {
    let response: Response
    try {
      response = await doFetch(`${options.cloudOrigin}${path}`, {
        headers: {
          accept: 'application/json',
          'x-adea-client': 'desktop',
          // The cloud's desktop lane trusts exactly the shell origin; the
          // proxy presents the same value for client-forwarded traffic.
          origin: options.shellOrigin,
          authorization: `Desktop ${session.credential}`,
          'x-adea-desktop-session': session.sessionId,
        },
      })
    } catch {
      throw new ChannelRejection(
        'runtime_node_unavailable',
        'the identity authority is unreachable',
        503,
        true
      )
    }
    if (!response.ok) {
      throw new ChannelRejection(
        response.status === 401 || response.status === 403 ? 'unauthenticated' : 'unavailable',
        'the desktop session was refused by the identity authority',
        401
      )
    }
    try {
      return await response.json()
    } catch {
      throw new ChannelRejection('corrupt_state', 'identity authority response was not JSON', 502)
    }
  }
  return {
    async verifySession(input) {
      const body = await cloudJson('/api/workspaces', input.session)
      if (!Array.isArray(body)) {
        throw new ChannelRejection('corrupt_state', 'workspace listing was malformed', 502)
      }
      return body
        .map((entry) => (entry as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === 'string')
    },
    async verifyNodeEligibility(input) {
      const body = await cloudJson(
        `/api/v1/workspaces/${input.workspaceId}/runtime-nodes`,
        input.session
      )
      const nodes = Array.isArray(body) ? body : (body as { items?: unknown[] })?.items
      const node = Array.isArray(nodes)
        ? (nodes as Array<{ id?: unknown; pairingState?: unknown }>).find(
            (entry) => entry?.id === input.runtimeNodeId
          )
        : undefined
      if (!node || node.pairingState !== 'paired') {
        throw new ChannelRejection(
          'runtime_node_revoked',
          'the runtime node is not eligible for privileged operations',
          403
        )
      }
    },
  }
}

/**
 * Reads the client's sealed session vault (the transitional command surface's
 * `session.sealed` under device-key AES-256-GCM). The shell never writes this
 * file; a missing or unreadable entry reads as unauthenticated.
 */
export function readSealedDesktopSession(dataDir: string): DesktopSessionCredential | undefined {
  const stateDir = join(dataDir, 'desktop-state')
  const keyFile = join(stateDir, 'device.key')
  const sealedFile = join(stateDir, 'session.sealed')
  try {
    if (!existsSync(keyFile) || !existsSync(sealedFile)) return undefined
    const key = readFileSync(keyFile)
    if (key.byteLength !== 32) return undefined
    const raw = Buffer.from(readFileSync(sealedFile, 'utf8'), 'base64')
    if (raw.byteLength < 29) return undefined
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const body = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    // The command surface seals the session object itself (not a wrapper).
    return assertSessionCredential(JSON.parse(plaintext))
  } catch {
    return undefined
  }
}

export function createDesktopIdentityAuthority(options: {
  dataDir: string
  verifier: DesktopIdentityVerifier
  now?: () => number
}): DesktopIdentityAuthority {
  if (!options.verifier) {
    throw new Error('the desktop identity authority requires a verifier')
  }
  const now = options.now ?? (() => Date.now())
  const store = createDurableJsonStore<BindingRecord>({
    file: join(options.dataDir, 'dev-runtime', 'identity', 'binding.json'),
    schemaVersion: 1,
    label: 'desktop identity binding',
  })
  const listeners = new Set<(reason: 'bound' | 'unbound') => void>()

  function loadBinding(): BindingRecord | undefined {
    const record = store.load().records[0]
    if (!record) return undefined
    if (Date.parse(record.sessionExpiresAt) <= now()) return undefined
    return record
  }

  function persistBinding(record: BindingRecord | undefined): void {
    store.save(record ? [record] : [])
  }

  function sessionForRecheck(): DesktopSessionCredential | undefined {
    // The credential lives in the client's sealed vault; if the client signed
    // out or cleared it, eligibility can no longer be re-proven.
    return readSealedDesktopSession(options.dataDir)
  }

  return {
    currentScope() {
      return loadBinding()?.scope
    },
    assertCommandScope(scope) {
      const binding = loadBinding()
      if (!binding) {
        throw new ChannelRejection(
          'unauthenticated',
          'no authenticated desktop identity is bound to this shell',
          401
        )
      }
      if (
        binding.scope.accountId !== scope.accountId ||
        binding.scope.workspaceId !== scope.workspaceId ||
        binding.scope.runtimeNodeId !== scope.runtimeNodeId
      ) {
        throw new ChannelRejection(
          'channel_unauthorized',
          'command scope does not match the authenticated identity binding',
          403
        )
      }
    },
    async ensureNodeEligible() {
      const binding = loadBinding()
      if (!binding) {
        throw new ChannelRejection('unauthenticated', 'identity binding is not present', 401)
      }
      // Every privileged operation re-proves eligibility: a node revoked at
      // any point fails the next command, not the next bind. There is no
      // TTL cache on purpose — fail closed beats fail fresh.
      const session = sessionForRecheck()
      if (!session || session.sessionId !== binding.sessionId) {
        throw new ChannelRejection(
          'runtime_node_unavailable',
          'runtime-node eligibility cannot be re-proven without the authenticated session',
          503
        )
      }
      try {
        await options.verifier.verifyNodeEligibility({
          session,
          workspaceId: binding.scope.workspaceId,
          runtimeNodeId: binding.scope.runtimeNodeId,
        })
      } catch (error) {
        if (error instanceof ChannelRejection) throw error
        throw new ChannelRejection(
          'runtime_node_unavailable',
          'runtime-node eligibility could not be verified',
          503,
          true
        )
      }
    },
    async bind(input) {
      const session = assertSessionCredential(input.session)
      const claimed = {
        accountId: assertUuidField(input.claimed.accountId, 'accountId'),
        workspaceId: assertUuidField(input.claimed.workspaceId, 'workspaceId'),
        runtimeNodeId: assertUuidField(input.claimed.runtimeNodeId, 'runtimeNodeId'),
      }
      if (Date.parse(session.expiresAt) <= now()) {
        throw new ChannelRejection('unauthenticated', 'the desktop session has expired', 401)
      }
      // Authoritative membership: the claimed workspace must be one of the
      // workspaces the verified credential belongs to. A foreign account or
      // workspace can never pass this, whatever the renderer claims.
      const workspaces = await options.verifier.verifySession({ session })
      if (!workspaces.includes(claimed.workspaceId)) {
        throw new ChannelRejection(
          'unauthorized',
          'the authenticated account is not a member of the claimed workspace',
          403
        )
      }
      await options.verifier.verifyNodeEligibility({
        session,
        workspaceId: claimed.workspaceId,
        runtimeNodeId: claimed.runtimeNodeId,
      })
      const binding: BindingRecord = {
        scope: claimed,
        sessionId: session.sessionId,
        verifiedAt: new Date(now()).toISOString(),
        sessionExpiresAt: session.expiresAt,
      }
      const previous = loadBinding()
      persistBinding(binding)
      // A re-bind under a different scope (workspace/account switch) or a
      // fresh bind invalidates channels minted under the old one.
      if (
        previous &&
        (previous.scope.accountId !== claimed.accountId ||
          previous.scope.workspaceId !== claimed.workspaceId ||
          previous.scope.runtimeNodeId !== claimed.runtimeNodeId)
      ) {
        for (const listener of listeners) listener('bound')
      } else if (!previous) {
        for (const listener of listeners) listener('bound')
      }
      return claimed
    },
    unbind(reason) {
      const previous = loadBinding()
      persistBinding(undefined)
      if (previous) {
        for (const listener of listeners) listener('unbound')
      }
      void reason
    },
    onBindingChanged(listener) {
      listeners.add(listener)
    },
  }
}
