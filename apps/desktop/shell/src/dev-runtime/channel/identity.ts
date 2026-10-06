// The Dev Runtime scope authority (M10 #33/#34 consumption).
//
// The scope triple (account, workspace, runtime node) is never accepted from
// the renderer as a global injection. The shell mints a DEVICE-LOCAL identity
// on first boot — a durable guest scope the renderer can only learn by asking
// — so the whole Dev Runtime works signed-out, offline, with no account and
// no prompt: the app is the machine owner's tool first. The app's own window
// may additionally bind a cloud identity over the signed legacy channel
// (`desktop_identity_bind`): the shell verifies the presented desktop session
// credential against the cloud (`GET /api/workspaces` proves liveness and
// workspace membership), proves the runtime node is paired and unrevoked in
// that workspace, and only then persists the binding. The cloud binding
// supersedes the guest scope until sign-out, which always returns to the same
// device-local identity — signing out never strands the surface. Every
// privileged command is checked against the ACTIVE binding (guest or cloud)
// BEFORE capability checks and dispatch; node eligibility is re-proven
// against the cloud only for the cloud binding (the device-local node is the
// shell's own machine, where the shell is the eligibility authority), and a
// re-bind, unbind, session expiry, or workspace switch drops every channel
// created under the superseded scope.
//
// The session credential itself stays in the client's sealed session vault
// (`desktop_user_session_save`, same sealing scheme as the transitional
// command surface); this module reads it only to re-verify eligibility.
//
// Device workspace scope (ADR 0011): the trusted window may also SELECT the
// Dev scope for a cloud workspace (`desktop_identity_select_workspace`). The
// shell proves membership with the presented desktop session or guest
// temporary credential (`GET /api/workspaces`), then activates
// `{ local accountId, cloud workspaceId, local runtimeNodeId }`, so every
// cloud workspace owns its own Dev partition. Verified memberships are cached
// per credential digest for `IDENTITY_LIMITS.membershipCacheTtlMs`, which is
// the only way a selection succeeds while the cloud is unreachable. A paired
// cloud binding takes precedence over any device selection.
import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
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

/** The identity limits registry (docs/specs/dev-runtime.md, "Consolidated
 *  limits registry"). An implementation may tighten a value; relaxing one
 *  requires a spec change. */
export const IDENTITY_LIMITS = {
  /** A verified workspace membership admits offline selection for 24 hours. */
  membershipCacheTtlMs: 24 * 60 * 60 * 1_000,
  /** At most 256 cached memberships; the oldest verification is dropped first. */
  maxCachedMemberships: 256,
} as const

/** The credential that proves workspace membership for a device scope: the
 *  signed-in desktop session or the guest's temporary workspace credential. */
export type WorkspaceMembershipCredential =
  | Readonly<{ kind: 'desktop'; session: DesktopSessionCredential }>
  | Readonly<{ kind: 'temporary'; credential: string }>

/** What the verifier presents to the cloud workspace listing. */
export type MembershipProof =
  | Readonly<{ session: DesktopSessionCredential; temporaryCredential?: undefined }>
  | Readonly<{ temporaryCredential: string; session?: undefined }>

export type DesktopIdentityKind = 'guest' | 'device' | 'cloud'

export type DeviceWorkspaceSelection = Readonly<{
  scope: Scope
  kind: DesktopIdentityKind
}>

export type DesktopIdentityVerifier = Readonly<{
  /**
   * Proves the credential is live and returns the workspace ids it belongs
   * to. A refused credential throws; the shell never binds on a guess.
   */
  verifySession(input: MembershipProof): Promise<readonly string[]>
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

/** The device-local identity: minted once per data directory, never rotated
 *  and never deleted, so projects, sessions, and history keyed to it survive
 *  every restart and every sign-in/sign-out cycle. */
type LocalIdentityRecord = Readonly<{
  scope: Scope
  createdAt: string
}>

/** One verified membership: the credential digest (never the credential)
 *  that proved it, the cloud workspace, and when the proof lapses. */
type MembershipRecord = Readonly<{
  principal: string
  workspaceId: string
  verifiedAt: string
  expiresAt: string
}>

/** The persisted device selection. It is active only while the membership
 *  that admitted it is cached and unexpired for the same principal. */
type DeviceSelectionRecord = Readonly<{
  principal: string
  workspaceId: string
  selectedAt: string
}>

type ActiveIdentity =
  | Readonly<{ kind: 'guest'; scope: Scope }>
  | Readonly<{ kind: 'device'; scope: Scope; selection: DeviceSelectionRecord }>
  | Readonly<{ kind: 'cloud'; scope: Scope; binding: BindingRecord }>

function activeIdentityOf(
  localScope: Scope,
  binding: BindingRecord | undefined,
  selection: DeviceSelectionRecord | undefined
): ActiveIdentity {
  // Precedence: a paired cloud binding, then a verified device selection,
  // then the device-local guest identity.
  if (binding) return { kind: 'cloud', scope: binding.scope, binding }
  if (selection) {
    return {
      kind: 'device',
      scope: {
        accountId: localScope.accountId,
        workspaceId: selection.workspaceId,
        runtimeNodeId: localScope.runtimeNodeId,
      },
      selection,
    }
  }
  return { kind: 'guest', scope: localScope }
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

export type DesktopIdentityAuthority = Readonly<{
  /** The active scope: the cloud binding when present, the device-local
   *  identity otherwise. Always defined — a signed-out shell still owns a
   *  scope. */
  currentScope(): Scope
  /** Which binding is active: the device-local guest identity, a
   *  membership-verified device workspace scope, or a paired cloud binding.
   *  UI surfaces read this to keep sign-in an optional upgrade, never a
   *  gate. */
  identityKind(): DesktopIdentityKind
  /**
   * The gate's admission check. Synchronous and total: it must run before
   * capability derivation and dispatch, and it fails closed on a mismatch
   * with the active binding — a renderer-asserted scope never matches.
   */
  assertCommandScope(scope: Scope): void
  /**
   * Re-proves runtime-node eligibility when the active binding is the cloud
   * one. Called by the gate for every privileged operation; a stale cache
   * beyond the TTL fails closed when the cloud cannot be reached. The
   * device-local identity needs no re-proof: the shell is the eligibility
   * authority over its own machine.
   */
  ensureNodeEligible(): Promise<void>
  /**
   * Verifies and persists the cloud binding from the authenticated window's
   * bind request, superseding the device-local identity. Rotating to a
   * different scope (or an explicit unbind) notifies listeners so every
   * channel created under the old scope is revoked.
   */
  bind(input: { session: DesktopSessionCredential; claimed: Scope }): Promise<Scope>
  /** Clears the cloud binding (sign-out / session revocation) and notifies;
   *  the active identity returns to the device selection or the device-local
   *  scope. */
  unbind(reason: string): void
  /**
   * Selects the device workspace scope for a cloud workspace the presented
   * credential is a verified member of. Online, the cloud listing is
   * authoritative and refreshes the membership cache; when the cloud is
   * unreachable only an unexpired cached membership for the same credential
   * admits the selection. Refusals are typed and fail closed: the active
   * scope is unchanged. An effective scope change notifies listeners so
   * every channel minted under the previous scope is revoked.
   */
  selectWorkspace(input: {
    workspaceId: string
    credential: WorkspaceMembershipCredential
  }): Promise<DeviceWorkspaceSelection>
  onBindingChanged(listener: (reason: 'bound' | 'unbound' | 'selected') => void): void
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

/** The guest credential shape the cloud mints (`adea_tmp_` + 32 random
 *  bytes, base64url). Anything else is refused before any network call. */
const TEMPORARY_CREDENTIAL_PATTERN = /^adea_tmp_[A-Za-z0-9_-]{43}$/

function assertMembershipCredential(value: unknown): {
  proof: MembershipProof
  principal: string
  sessionExpiresAt?: string
} {
  const candidate = value as { kind?: unknown; session?: unknown; credential?: unknown } | undefined
  if (candidate?.kind === 'desktop') {
    const session = assertSessionCredential(candidate.session)
    return {
      proof: { session },
      principal: credentialDigest('desktop', session.credential),
      sessionExpiresAt: session.expiresAt,
    }
  }
  if (
    candidate?.kind === 'temporary' &&
    typeof candidate.credential === 'string' &&
    TEMPORARY_CREDENTIAL_PATTERN.test(candidate.credential)
  ) {
    return {
      proof: { temporaryCredential: candidate.credential },
      principal: credentialDigest('temporary', candidate.credential),
    }
  }
  throw new ChannelRejection('invalid_state', 'workspace membership credential is malformed', 400)
}

/** Memberships are keyed by a digest of the credential itself, so an offline
 *  selection requires possession of the credential that verified it — a
 *  public session id or a different (signed-out, rotated) credential never
 *  matches. The credential is never persisted. */
function credentialDigest(kind: 'desktop' | 'temporary', credential: string): string {
  return createHash('sha256')
    .update(`adea-membership:v1\u001f${kind}\u001f${credential}`)
    .digest('hex')
}

/** Cloud failures that mean "could not ask", not "asked and refused": only
 *  these fall back to the membership cache. */
function isUnreachable(error: unknown): boolean {
  if (!(error instanceof ChannelRejection)) return true
  return error.code === 'runtime_node_unavailable' || error.code === 'unavailable'
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
  async function cloudJson(path: string, proof: MembershipProof): Promise<unknown> {
    // A desktop session authorizes as `Desktop <credential>` with its session
    // id; a guest presents its temporary workspace credential, which the
    // cloud resolves without minting a new guest session on this route.
    const authorization: Record<string, string> = proof.session
      ? {
          authorization: `Desktop ${proof.session.credential}`,
          'x-adea-desktop-session': proof.session.sessionId,
        }
      : { authorization: `Temporary ${proof.temporaryCredential}` }
    let response: Response
    try {
      response = await doFetch(`${options.cloudOrigin}${path}`, {
        headers: {
          accept: 'application/json',
          'x-adea-client': 'desktop',
          // The cloud's desktop lane trusts exactly the shell origin; the
          // proxy presents the same value for client-forwarded traffic.
          origin: options.shellOrigin,
          ...authorization,
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
      const body = await cloudJson('/api/workspaces', input)
      if (!Array.isArray(body)) {
        throw new ChannelRejection('corrupt_state', 'workspace listing was malformed', 502)
      }
      return body
        .map((entry) => (entry as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === 'string')
    },
    async verifyNodeEligibility(input) {
      const body = await cloudJson(`/api/v1/workspaces/${input.workspaceId}/runtime-nodes`, {
        session: input.session,
      })
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

/**
 * Loads — or mints once and persists — the device-local identity. The file is
 * owner-only durable state under the shell's data directory; the renderer has
 * no path to write or choose it, which is what keeps "the renderer never
 * self-asserts a scope" true with no account in the picture.
 */
export function loadOrCreateLocalIdentity(dataDir: string, now?: () => number): Scope {
  const store = createDurableJsonStore<LocalIdentityRecord>({
    file: join(dataDir, 'dev-runtime', 'identity', 'local.json'),
    schemaVersion: 1,
    label: 'device-local identity',
  })
  const existing = store.load().records[0]
  if (existing) return existing.scope
  const record: LocalIdentityRecord = {
    scope: {
      accountId: randomUUID(),
      workspaceId: randomUUID(),
      runtimeNodeId: randomUUID(),
    },
    createdAt: new Date((now ?? (() => Date.now()))()).toISOString(),
  }
  store.save([record])
  return record.scope
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
  const localScope = loadOrCreateLocalIdentity(options.dataDir, now)
  const store = createDurableJsonStore<BindingRecord>({
    file: join(options.dataDir, 'dev-runtime', 'identity', 'binding.json'),
    schemaVersion: 1,
    label: 'desktop identity binding',
  })
  const membershipStore = createDurableJsonStore<MembershipRecord>({
    file: join(options.dataDir, 'dev-runtime', 'identity', 'memberships.json'),
    schemaVersion: 1,
    label: 'workspace membership cache',
  })
  const selectionStore = createDurableJsonStore<DeviceSelectionRecord>({
    file: join(options.dataDir, 'dev-runtime', 'identity', 'device-scope.json'),
    schemaVersion: 1,
    label: 'device workspace scope',
  })
  const listeners = new Set<(reason: 'bound' | 'unbound' | 'selected') => void>()

  function loadBinding(): BindingRecord | undefined {
    const record = store.load().records[0]
    if (!record) return undefined
    if (Date.parse(record.sessionExpiresAt) <= now()) return undefined
    return record
  }

  function persistBinding(record: BindingRecord | undefined): void {
    store.save(record ? [record] : [])
  }

  function liveMemberships(): MembershipRecord[] {
    const at = now()
    return membershipStore.load().records.filter((record) => Date.parse(record.expiresAt) > at)
  }

  function cachedMembership(principal: string, workspaceId: string): MembershipRecord | undefined {
    return liveMemberships().find(
      (record) => record.principal === principal && record.workspaceId === workspaceId
    )
  }

  /** The cloud listing is authoritative for its principal: it replaces every
   *  cached membership of that credential, so a removed membership stops
   *  admitting offline selection at the next online check. */
  function recordMemberships(principal: string, workspaceIds: readonly string[]): void {
    const at = now()
    const verifiedAt = new Date(at).toISOString()
    const expiresAt = new Date(at + IDENTITY_LIMITS.membershipCacheTtlMs).toISOString()
    const fresh = [...new Set(workspaceIds)]
      .filter((id) => UUID_PATTERN.test(id))
      .map((workspaceId) => ({ principal, workspaceId, verifiedAt, expiresAt }))
    const others = liveMemberships().filter((record) => record.principal !== principal)
    const merged = [...others, ...fresh]
      .toSorted((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt))
      .slice(0, IDENTITY_LIMITS.maxCachedMemberships)
    membershipStore.save(merged)
  }

  function forgetPrincipal(principal: string): void {
    membershipStore.save(liveMemberships().filter((record) => record.principal !== principal))
  }

  /** The persisted device selection. It stays the active scope even after its
   *  admitting membership lapses — the composed host and the gate must keep
   *  agreeing on one scope — and `ensureNodeEligible` then fails every
   *  command closed until a fresh selection re-proves membership. */
  function loadSelection(): DeviceSelectionRecord | undefined {
    return selectionStore.load().records[0]
  }

  function activeIdentity(): ActiveIdentity {
    return activeIdentityOf(localScope, loadBinding(), loadSelection())
  }

  function notify(reason: 'bound' | 'unbound' | 'selected'): void {
    for (const listener of listeners) listener(reason)
  }

  function sessionForRecheck(): DesktopSessionCredential | undefined {
    // The credential lives in the client's sealed vault; if the client signed
    // out or cleared it, eligibility can no longer be re-proven.
    return readSealedDesktopSession(options.dataDir)
  }

  return {
    currentScope() {
      return activeIdentity().scope
    },
    identityKind() {
      return activeIdentity().kind
    },
    assertCommandScope(scope) {
      const active = activeIdentity().scope
      if (!sameScope(active, scope)) {
        throw new ChannelRejection(
          'channel_unauthorized',
          'command scope does not match the active identity binding',
          403
        )
      }
    },
    async ensureNodeEligible() {
      const active = activeIdentity()
      // The device-local node is the machine running the shell: the shell is
      // the eligibility authority, and there is nothing to re-prove.
      if (active.kind === 'guest') return
      // A device workspace scope runs on that same node, so only its
      // admitting membership is re-checked: a lapsed (expired, or refused by
      // the cloud since) proof fails every command closed until the window
      // re-selects the workspace and the cloud re-proves membership.
      if (active.kind === 'device') {
        if (!cachedMembership(active.selection.principal, active.selection.workspaceId)) {
          throw new ChannelRejection(
            'workspace_unavailable',
            'the device workspace membership has lapsed and must be re-verified',
            503,
            true
          )
        }
        return
      }
      // Every privileged operation re-proves eligibility: a node revoked at
      // any point fails the next command, not the next bind. There is no
      // TTL cache on purpose — fail closed beats fail fresh.
      const session = sessionForRecheck()
      if (!session || session.sessionId !== active.binding.sessionId) {
        throw new ChannelRejection(
          'runtime_node_unavailable',
          'runtime-node eligibility cannot be re-proven without the authenticated session',
          503
        )
      }
      try {
        await options.verifier.verifyNodeEligibility({
          session,
          workspaceId: active.binding.scope.workspaceId,
          runtimeNodeId: active.binding.scope.runtimeNodeId,
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
      const previous = activeIdentity().scope
      persistBinding(binding)
      // Any effective scope change — including the guest-to-cloud upgrade —
      // invalidates channels minted under the previous one.
      if (!sameScope(previous, claimed)) notify('bound')
      return claimed
    },
    unbind(reason) {
      const previous = loadBinding()
      persistBinding(undefined)
      // The device selection (or the device-local identity) takes over;
      // channels minted under the cloud binding are revoked and the next
      // handshake rides that scope. The local identity itself is never
      // rotated or deleted.
      if (previous) notify('unbound')
      void reason
    },
    async selectWorkspace(input) {
      const workspaceId = assertUuidField(input.workspaceId, 'workspaceId')
      const credential = assertMembershipCredential(input.credential)
      if (credential.sessionExpiresAt && Date.parse(credential.sessionExpiresAt) <= now()) {
        throw new ChannelRejection('unauthenticated', 'the desktop session has expired', 401)
      }
      try {
        const workspaces = await options.verifier.verifySession(credential.proof)
        recordMemberships(credential.principal, workspaces)
      } catch (error) {
        if (!isUnreachable(error)) {
          // The cloud answered and refused the credential: its cached
          // memberships no longer prove anything.
          forgetPrincipal(credential.principal)
          throw error
        }
        // Offline: fall through to the cache check below, which admits only a
        // membership this exact credential proved within the TTL.
        if (!cachedMembership(credential.principal, workspaceId)) {
          throw new ChannelRejection(
            'workspace_unavailable',
            'workspace membership cannot be verified while the identity authority is unreachable',
            503,
            true
          )
        }
      }
      if (!cachedMembership(credential.principal, workspaceId)) {
        throw new ChannelRejection(
          'unauthorized',
          'the presented credential is not a member of the selected workspace',
          403
        )
      }
      const binding = loadBinding()
      if (binding && binding.scope.workspaceId !== workspaceId) {
        // The paired cloud binding takes precedence and is left untouched; a
        // device selection for another workspace would be silently shadowed,
        // so it is refused instead.
        throw new ChannelRejection(
          'identity_mismatch',
          'a paired runtime-node binding is active for another workspace',
          409
        )
      }
      const previous = activeIdentity().scope
      selectionStore.save([
        {
          principal: credential.principal,
          workspaceId,
          selectedAt: new Date(now()).toISOString(),
        },
      ])
      const next = activeIdentity()
      // An effective scope change drops every channel minted under the
      // previous scope; re-selecting the active workspace is a no-op.
      if (!sameScope(previous, next.scope)) notify('selected')
      return { scope: next.scope, kind: next.kind }
    },
    onBindingChanged(listener) {
      listeners.add(listener)
    },
  }
}
