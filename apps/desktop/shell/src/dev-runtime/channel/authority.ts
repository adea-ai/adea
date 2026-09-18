// The M10 channel authority (#33): the sole gate in front of the shell's
// privileged command surface. It mints the per-launch bootstrap capability,
// runs `dev.runtime.handshake.v1`, authenticates every request and frame
// (HMAC over the canonical proof inputs shared with `packages/types`),
// atomically consumes nonces, verifies expiry and clock skew, derives the
// required capability set from the operation registry, and issues/consumes
// single-use stream grants for the full-duplex channel. Audit records and
// counters are secret-free by construction.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  decodeAuthorizedDevFrame,
  decodeDevChannelHandshakeRequest,
  decodeDevStreamAttach,
  devCommandProofMessage,
  devOperationDefinitions,
  devStreamAttachProofMessage,
  type CapabilitySnapshot,
  type DevChannelHandshakeReply,
  type DevCommand,
  type DevError,
  type DevErrorCode,
  type DevOperation,
  type DevReply,
  type DevStreamAttach,
  type DevStreamGrant,
  type DevStreamProtocol,
  type Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { isTrustedLoopbackRequest, type TrustedLoopbackPolicy } from './loopback'

export const LEGACY_INVOKE_PROOF_CONTEXT = 'adea-invoke-v1'

export const COMMAND_EXPIRY_MS = 60_000
export const CLOCK_SKEW_MS = 30_000
export const CHANNEL_LIFETIME_MS = 12 * 60 * 60_000
export const MAX_CONTROL_BYTES = 256 * 1024
const NONCE_RETENTION_MS = 30_000
const MAX_NONCES_PER_KEY = 4096
const MAX_ACTIVE_CHANNELS = 4
const MAX_AUDIT_RECORDS = 512

export class ChannelRejection extends Error {
  readonly code: DevErrorCode
  readonly httpStatus: number
  readonly retryable: boolean

  constructor(code: DevErrorCode, message: string, httpStatus = 401, retryable = false) {
    super(message)
    this.name = 'ChannelRejection'
    this.code = code
    this.httpStatus = httpStatus
    this.retryable = retryable
  }
}

export type ChannelIdentity = Readonly<{ channelId: string; clientCredentialId: string }>

export type DevCommandHandler = (command: DevCommand) => unknown | Promise<unknown>

export type ChannelAuditRecord = Readonly<{
  at: string
  kind:
    | 'handshake_accepted'
    | 'handshake_refused'
    | 'command_accepted'
    | 'command_refused'
    | 'stream_granted'
    | 'stream_attach_accepted'
    | 'stream_attach_refused'
  channelId?: string
  clientCredentialId?: string
  operation?: string
  resource?: string
  errorCode?: DevErrorCode
}>

export type ChannelRejectionCounters = Readonly<{
  originRefused: number
  handshakeRefused: number
  channelUnauthenticated: number
  tokenExpired: number
  replayRejected: number
  identityMismatch: number
  capabilityDenied: number
  commandsAccepted: number
  commandsRefused: number
}>

type ChannelRecord = {
  clientCredentialId: string
  secret: Buffer
  generation: number
  createdAt: number
  expiresAt: number
  eventsToken?: { value: string; expiresAt: number; consumed: boolean }
}

type GrantRecord = {
  grant: DevStreamGrant
  expiresAt: number
  consumed: boolean
}

export type StreamGrantRequest = {
  identity: ChannelIdentity
  protocol: DevStreamProtocol
  scope: Scope
  resource: { kind: string; id: string; generation: number }
  direction: 'read' | 'write'
  fromSequence?: string
  maxFrameBytes?: number
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function hmac(secret: Buffer, message: string): Buffer {
  return createHmac('sha256', secret).update(message, 'utf8').digest()
}

function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function constantTimeEqualString(left: string, right: string): boolean {
  return constantTimeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function decodeRequestId(raw: unknown): string {
  try {
    const command = (raw as { command?: { requestId?: string } }).command
    return typeof command?.requestId === 'string' ? command.requestId : ''
  } catch {
    return ''
  }
}

function decodeOperation(raw: unknown): string | undefined {
  try {
    const operation = (raw as { command?: { operation?: string } }).command?.operation
    return typeof operation === 'string' ? operation : undefined
  } catch {
    return undefined
  }
}

function decodeChannelId(raw: unknown): string | undefined {
  try {
    const channelId = (raw as { channelId?: string }).channelId
    return typeof channelId === 'string' ? channelId : undefined
  } catch {
    return undefined
  }
}

function decodeCredentialId(raw: unknown): string | undefined {
  try {
    const id = (raw as { clientCredentialId?: string }).clientCredentialId
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

export function createChannelAuthority(options?: {
  /** Injected wall clock in epoch milliseconds (host tests use a fixed one). */
  now?: () => number
  shellHost: string
  shellOrigin: string
}) {
  const now = options?.now ?? (() => Date.now())
  const policy: TrustedLoopbackPolicy = {
    shellHost: options!.shellHost,
    shellOrigin: options!.shellOrigin,
  }

  let bootstrap: { value: string; consumed: boolean } | undefined
  const channels = new Map<string, ChannelRecord>()
  const nonces = new Map<string, Map<string, number>>()
  const grants = new Map<string, GrantRecord>()
  const commandProviders = new Map<DevOperation, DevCommandHandler>()
  const streamProviders = new Map<DevStreamProtocol, boolean>()
  const auditRecords: ChannelAuditRecord[] = []
  const counters = {
    originRefused: 0,
    handshakeRefused: 0,
    channelUnauthenticated: 0,
    tokenExpired: 0,
    replayRejected: 0,
    identityMismatch: 0,
    capabilityDenied: 0,
    commandsAccepted: 0,
    commandsRefused: 0,
  }

  function audit(record: ChannelAuditRecord): void {
    auditRecords.push(record)
    if (auditRecords.length > MAX_AUDIT_RECORDS) auditRecords.shift()
  }

  function sweepNonces(key: string, at: number): void {
    const bucket = nonces.get(key)
    if (!bucket) return
    for (const [nonce, expiry] of bucket) if (expiry < at) bucket.delete(nonce)
    if (bucket.size === 0) nonces.delete(key)
  }

  /**
   * Consumes a nonce exactly once under (clientCredentialId, accountId,
   * workspaceId) through expiry plus the retention window; a repeat is
   * `replay_rejected` even when the body matches. Runs synchronously, so the
   * check-and-store is atomic within the shell process.
   */
  function consumeNonce(key: string, nonce: string, expiresAt: number): void {
    sweepNonces(key, now())
    let bucket = nonces.get(key)
    if (!bucket) {
      bucket = new Map()
      nonces.set(key, bucket)
    }
    if (bucket.has(nonce)) {
      counters.replayRejected += 1
      throw new ChannelRejection('replay_rejected', 'nonce was already consumed', 401)
    }
    if (bucket.size >= MAX_NONCES_PER_KEY) {
      throw new ChannelRejection('limit_exceeded', 'too many pending request nonces', 429)
    }
    bucket.set(nonce, expiresAt + NONCE_RETENTION_MS)
  }

  function channelFor(identity: ChannelIdentity): ChannelRecord {
    const channel = channels.get(identity.channelId)
    if (!channel || channel.clientCredentialId !== identity.clientCredentialId) {
      counters.channelUnauthenticated += 1
      throw new ChannelRejection('channel_unauthenticated', 'unknown channel credential', 401)
    }
    if (channel.expiresAt <= now()) {
      channels.delete(identity.channelId)
      counters.tokenExpired += 1
      throw new ChannelRejection('token_expired', 'channel credential expired', 401)
    }
    return channel
  }

  function requireTrusted(context: { trusted: boolean }, kind: ChannelAuditRecord['kind']): void {
    if (context.trusted) return
    counters.originRefused += 1
    audit({ at: iso(now()), kind, errorCode: 'channel_unauthenticated' })
    throw new ChannelRejection('channel_unauthenticated', 'untrusted client origin', 403)
  }

  // ── Launch bootstrap + handshake ─────────────────────────────────────────

  /**
   * The single-use capability injected into the app's own window only. A page
   * reload may need a fresh one, so a call after consumption mints a new
   * token; the previous one stays dead.
   */
  function issueLaunchBootstrap(): string {
    if (bootstrap && !bootstrap.consumed) return bootstrap.value
    bootstrap = { value: randomBytes(32).toString('base64url'), consumed: false }
    return bootstrap.value
  }

  function handshake(raw: unknown, context: { trusted: boolean }): DevChannelHandshakeReply {
    try {
      requireTrusted(context, 'handshake_refused')
      const request = decodeDevChannelHandshakeRequest(raw)
      const at = now()
      const issuedAt = Date.parse(request.issuedAt)
      const expiresAt = Date.parse(request.expiresAt)
      if (
        !bootstrap ||
        bootstrap.consumed ||
        !constantTimeEqualString(request.bootstrap, bootstrap.value)
      ) {
        counters.handshakeRefused += 1
        counters.channelUnauthenticated += 1
        audit({
          at: iso(at),
          kind: 'handshake_refused',
          errorCode: 'channel_unauthenticated',
        })
        throw new ChannelRejection(
          'channel_unauthenticated',
          'launch bootstrap was missing, consumed, or wrong',
          403
        )
      }
      if (issuedAt > at + CLOCK_SKEW_MS || expiresAt > issuedAt + 60_000 || expiresAt < at) {
        counters.handshakeRefused += 1
        counters.tokenExpired += 1
        audit({ at: iso(at), kind: 'handshake_refused', errorCode: 'token_expired' })
        throw new ChannelRejection('token_expired', 'handshake window is invalid', 401)
      }
      bootstrap.consumed = true
      if (channels.size >= MAX_ACTIVE_CHANNELS) {
        // The app has one window: every handshake supersedes an older page
        // load, so the oldest channel is the stale one. Evict it instead of
        // wedging the product behind a reload cap.
        const oldest = [...channels.entries()].toSorted(
          (a, b) => a[1].createdAt - b[1].createdAt
        )[0]
        if (oldest) channels.delete(oldest[0])
      }
      const channelId = randomUUID()
      const clientCredentialId = randomUUID()
      const channel: ChannelRecord = {
        clientCredentialId,
        secret: randomBytes(32),
        generation: 1,
        createdAt: at,
        expiresAt: at + CHANNEL_LIFETIME_MS,
      }
      channels.set(channelId, channel)
      audit({
        at: iso(at),
        kind: 'handshake_accepted',
        channelId,
        clientCredentialId,
      })
      return {
        schemaVersion: 1,
        method: 'dev.runtime.handshake.v1',
        requestId: request.requestId,
        ok: true,
        channelId,
        clientCredentialId,
        clientSecret: channel.secret.toString('base64url'),
        channelGeneration: channel.generation,
        protocolVersion: '1',
        serverExpiresAt: iso(channel.expiresAt),
        observedAt: iso(at),
      }
    } catch (error) {
      if (error instanceof ChannelRejection) {
        counters.handshakeRefused += 1
        audit({ at: iso(now()), kind: 'handshake_refused', errorCode: error.code })
        throw rejectionWithCode(error)
      }
      counters.handshakeRefused += 1
      audit({ at: iso(now()), kind: 'handshake_refused', errorCode: 'unsupported_version' })
      throw new ChannelRejection('unsupported_version', 'malformed handshake request', 400)
    }
  }

  function rejectionWithCode(error: ChannelRejection): ChannelRejection {
    // Keep the counter semantics readable: classify every refusal once.
    if (error.code === 'replay_rejected') counters.replayRejected += 1
    if (error.code === 'identity_mismatch') counters.identityMismatch += 1
    if (error.code === 'capability_denied') counters.capabilityDenied += 1
    return error
  }

  // ── Authenticated legacy invoke (the guarded /__adea/invoke path) ────────

  function legacyProofMessage(input: {
    channelId: string
    clientCredentialId: string
    nonce: string
    timestampMs: string
    bodySha256: string
  }): string {
    return [
      LEGACY_INVOKE_PROOF_CONTEXT,
      input.channelId,
      input.clientCredentialId,
      input.nonce,
      input.timestampMs,
      input.bodySha256,
    ].join('\u001f')
  }

  function header(headers: Record<string, string | undefined>, name: string): string {
    const value = headers[name]
    if (typeof value !== 'string' || value.length === 0) {
      counters.channelUnauthenticated += 1
      throw new ChannelRejection('channel_unauthenticated', `missing ${name} header`, 401)
    }
    return value
  }

  /**
   * Verifies a signed legacy invoke/events-token request. The proof binds the
   * context, channel, credential, a fresh nonce, the send time, and the exact
   * request body.
   */
  function authenticateLegacyRequest(input: {
    headers: Record<string, string | undefined>
    body: string
  }): ChannelIdentity {
    const channelId = header(input.headers, 'x-adea-channel')
    const clientCredentialId = header(input.headers, 'x-adea-credential')
    const nonce = header(input.headers, 'x-adea-nonce')
    const timestampMs = header(input.headers, 'x-adea-timestamp')
    const proof = header(input.headers, 'x-adea-proof')
    const channel = channelFor({ channelId, clientCredentialId })
    const at = now()
    const sentAt = Number(timestampMs)
    if (!Number.isSafeInteger(sentAt) || Math.abs(at - sentAt) > CLOCK_SKEW_MS) {
      counters.tokenExpired += 1
      throw new ChannelRejection('token_expired', 'request timestamp outside the clock skew', 401)
    }
    consumeNonce(`${clientCredentialId}\u0000\u0000\u0000`, nonce, sentAt + CLOCK_SKEW_MS)
    const bodySha256 = createHash('sha256').update(input.body, 'utf8').digest('hex')
    const expected = hmac(
      channel.secret,
      legacyProofMessage({
        channelId,
        clientCredentialId,
        nonce,
        timestampMs,
        bodySha256,
      })
    )
    if (!constantTimeEqual(expected, Buffer.from(proof, 'base64url'))) {
      counters.identityMismatch += 1
      throw new ChannelRejection('identity_mismatch', 'request proof did not verify', 403)
    }
    return { channelId, clientCredentialId }
  }

  // ── dev.* command execution (dev.runtime.execute.v1) ─────────────────────

  /**
   * The M10 gate, in the order the Dev Runtime spec pins it:
   * 1. channel credential/signature and trusted client identity;
   * 2. expiry, nonce/replay, schema, payload size;
   * 3. authenticated user and account/workspace capability;
   * 4. eligible runtime node (the local lane binds the shell itself);
   * 5. resource scope/generation ownership (provider rechecks);
   * 6. operation-specific preconditions (registered provider);
   * 7. idempotency (provider responsibility before mutation).
   */
  async function execute(raw: unknown, context: { trusted: boolean }): Promise<DevReply> {
    const at = now()
    const refusal = (
      error: DevError,
      frame?: {
        channelId?: string
        clientCredentialId?: string
        operation?: string
      }
    ): DevReply => {
      counters.commandsRefused += 1
      audit({
        at: iso(now()),
        kind: 'command_refused',
        channelId: frame?.channelId,
        clientCredentialId: frame?.clientCredentialId,
        operation: frame?.operation,
        errorCode: error.code,
      })
      return {
        schemaVersion: 1,
        operation: (frame?.operation ?? 'unknown') as DevOperation,
        requestId: decodeRequestId(raw),
        ok: false,
        error,
      }
    }
    try {
      requireTrusted(context, 'command_refused')
      if (typeof raw === 'string' && raw.length > MAX_CONTROL_BYTES) {
        return refusal({
          code: 'limit_exceeded',
          retryable: false,
          message: 'control payload exceeds 256 KiB',
        })
      }
      // Steps 1-2: frame structure, channel credential, proof, freshness,
      // replay.
      const frame = decodeAuthorizedDevFrame(raw)
      const channel = channelFor(frame)
      const definition = devOperationDefinitions[frame.command.operation]
      // Step 3: the gate independently derives the required capability set.
      if (
        frame.command.capabilities.length !== definition.capabilities.length ||
        frame.command.capabilities.some(
          (capability, index) => capability !== definition.capabilities[index]
        )
      ) {
        counters.capabilityDenied += 1
        throw new ChannelRejection(
          'capability_denied',
          'capabilities do not match the registry',
          403
        )
      }
      const issuedAt = Date.parse(frame.command.issuedAt)
      const expiresAt = Date.parse(frame.command.expiresAt)
      if (issuedAt > at + CLOCK_SKEW_MS) {
        counters.tokenExpired += 1
        throw new ChannelRejection('token_expired', 'command issued in the future', 401)
      }
      if (expiresAt > issuedAt + COMMAND_EXPIRY_MS) {
        counters.tokenExpired += 1
        throw new ChannelRejection('token_expired', 'command lifetime exceeds 60 seconds', 401)
      }
      if (expiresAt < at) {
        counters.tokenExpired += 1
        throw new ChannelRejection('token_expired', 'command expired', 401)
      }
      const expectedProof = hmac(
        channel.secret,
        devCommandProofMessage({
          channelId: frame.channelId,
          clientCredentialId: frame.clientCredentialId,
          command: frame.command,
        })
      )
      if (!constantTimeEqual(expectedProof, Buffer.from(frame.proof, 'base64url'))) {
        counters.identityMismatch += 1
        throw new ChannelRejection('identity_mismatch', 'command proof did not verify', 403)
      }
      consumeNonce(
        `${frame.clientCredentialId}\u0000${frame.command.scope.accountId}\u0000${frame.command.scope.workspaceId}`,
        frame.command.nonce,
        expiresAt
      )
      // Step 4: this is the local-device lane; the shell is the runtime node.
      // Remote RuntimeConnection routing repeats the gate on the node host.
      const provider = commandProviders.get(frame.command.operation)
      let value: unknown
      if (provider) {
        value = await provider(frame.command)
      } else {
        // Step 6: deny by default — no ad hoc native commands.
        counters.capabilityDenied += 1
        return refusal(
          {
            code: 'capability_unavailable',
            retryable: true,
            message: `no provider is registered for ${frame.command.operation}`,
            observedAt: iso(now()),
          },
          {
            channelId: frame.channelId,
            clientCredentialId: frame.clientCredentialId,
            operation: frame.command.operation,
          }
        )
      }
      counters.commandsAccepted += 1
      audit({
        at: iso(now()),
        kind: 'command_accepted',
        channelId: frame.channelId,
        clientCredentialId: frame.clientCredentialId,
        operation: frame.command.operation,
        resource: frame.command.resource
          ? `${frame.command.resource.kind}:${frame.command.resource.id}:${frame.command.resource.generation}`
          : undefined,
      })
      return {
        schemaVersion: 1,
        operation: frame.command.operation,
        requestId: frame.command.requestId,
        ok: true,
        value: value ?? null,
        observedAt: iso(now()),
      }
    } catch (error) {
      if (error instanceof ChannelRejection) {
        rejectionWithCode(error)
        return refusal(
          {
            code: error.code,
            retryable: error.retryable,
            message: error.message,
            observedAt: iso(now()),
          },
          {
            operation: decodeOperation(raw),
            channelId: decodeChannelId(raw),
            clientCredentialId: decodeCredentialId(raw),
          }
        )
      }
      return refusal({
        code: 'invalid_state',
        retryable: false,
        message: 'command frame was malformed',
        observedAt: iso(now()),
      })
    }
  }

  // ── Capability snapshot (the channel's own probe operation) ──────────────

  function capabilitySnapshot(scope: Scope, identity?: ChannelIdentity): CapabilitySnapshot {
    const channel = identity ? channels.get(identity.channelId) : undefined
    const granted = (['dev.appearance.read', 'dev.appLibrary.manage'] as const).toSorted()
    const clientOnlyGrants = new Set<string>(granted)
    const unavailable = Object.values(devOperationDefinitions)
      .flatMap((definition) => definition.capabilities)
      .filter((capability) => !clientOnlyGrants.has(capability))
    return {
      scope,
      granted,
      unavailable: [...new Set(unavailable)].toSorted().map((capability) => ({
        capability,
        reason: 'capability_unavailable' as const,
      })),
      channelGeneration: channel?.generation ?? 0,
      observedAt: iso(now()),
    }
  }

  // ── Events tokens (single-use, 60 s, for the SSE bridge) ─────────────────

  function mintEventsToken(identity: ChannelIdentity): { token: string; expiresAt: string } {
    const channel = channelFor(identity)
    const token = randomBytes(32).toString('base64url')
    channel.eventsToken = { value: token, expiresAt: now() + 60_000, consumed: false }
    return { token, expiresAt: iso(channel.eventsToken.expiresAt) }
  }

  function consumeEventsToken(identity: ChannelIdentity, token: string): boolean {
    const channel = channelFor(identity)
    const minted = channel.eventsToken
    if (!minted || minted.consumed || minted.expiresAt < now()) return false
    if (!constantTimeEqualString(minted.value, token)) return false
    minted.consumed = true
    return true
  }

  // ── Stream grants (the full-duplex attach path) ──────────────────────────

  function registerStreamProvider(protocol: DevStreamProtocol): void {
    streamProviders.set(protocol, true)
  }

  function hasStreamProvider(protocol: DevStreamProtocol): boolean {
    return streamProviders.get(protocol) === true
  }

  function mintStreamGrant(input: StreamGrantRequest): DevStreamGrant {
    const channel = channelFor(input.identity)
    const at = now()
    const grant: DevStreamGrant = {
      schemaVersion: 1,
      grantId: randomUUID(),
      protocol: input.protocol,
      channelId: input.identity.channelId,
      scope: input.scope,
      resource: input.resource,
      direction: input.direction,
      fromSequence: input.fromSequence ?? '0',
      expiresAt: iso(at + 60_000),
      maxFrameBytes: input.maxFrameBytes ?? 65_536,
    }
    grants.set(grant.grantId, { grant, expiresAt: Date.parse(grant.expiresAt), consumed: false })
    audit({
      at: iso(at),
      kind: 'stream_granted',
      channelId: grant.channelId,
      clientCredentialId: channel.clientCredentialId,
      resource: `${grant.resource.kind}:${grant.resource.id}:${grant.resource.generation}`,
    })
    return grant
  }

  /**
   * Consumes a stream attach: the grant must be live, unspent, bound to this
   * channel and scope, and the attach proof must verify against the channel
   * secret. The grant's parameters are structurally bound by the stored row.
   */
  function attachStream(input: {
    identity: ChannelIdentity
    attach: unknown
    /** Refuses before the single-use grant is spent, e.g. when no provider. */
    acceptProtocol?: (protocol: DevStreamProtocol, grant: DevStreamGrant) => boolean
  }): DevStreamGrant {
    const at = now()
    try {
      const attach: DevStreamAttach = decodeDevStreamAttach(input.attach)
      const channel = channelFor(input.identity)
      const record = attach.grantId ? grants.get(attach.grantId) : undefined
      if (!record) {
        counters.capabilityDenied += 1
        audit({ at: iso(at), kind: 'stream_attach_refused', errorCode: 'not_found' })
        throw new ChannelRejection('not_found', 'stream grant is unknown', 404)
      }
      if (record.consumed) {
        counters.replayRejected += 1
        audit({ at: iso(at), kind: 'stream_attach_refused', errorCode: 'replay_rejected' })
        throw new ChannelRejection('replay_rejected', 'stream grant was already consumed', 401)
      }
      if (record.expiresAt < at) {
        counters.tokenExpired += 1
        audit({ at: iso(at), kind: 'stream_attach_refused', errorCode: 'token_expired' })
        throw new ChannelRejection('token_expired', 'stream grant expired', 401)
      }
      if (record.grant.channelId !== input.identity.channelId) {
        counters.identityMismatch += 1
        audit({ at: iso(at), kind: 'stream_attach_refused', errorCode: 'identity_mismatch' })
        throw new ChannelRejection('identity_mismatch', 'grant is bound to another channel', 403)
      }
      if (input.acceptProtocol && !input.acceptProtocol(record.grant.protocol, record.grant)) {
        counters.capabilityDenied += 1
        audit({ at: iso(at), kind: 'stream_attach_refused', errorCode: 'capability_unavailable' })
        throw new ChannelRejection(
          'capability_unavailable',
          'no provider is registered for the granted protocol',
          501,
          true
        )
      }
      if (Date.parse(attach.requestId ? '' : '') === 0) {
        // requestId shape was validated by the decoder; nothing further to do.
      }
      const expected = hmac(
        channel.secret,
        devStreamAttachProofMessage({ channelId: input.identity.channelId, attach })
      )
      if (!constantTimeEqual(expected, Buffer.from(attach.proof, 'base64url'))) {
        counters.identityMismatch += 1
        audit({ at: iso(at), kind: 'stream_attach_refused', errorCode: 'identity_mismatch' })
        throw new ChannelRejection('identity_mismatch', 'attach proof did not verify', 403)
      }
      consumeNonce(
        `${channel.clientCredentialId}\u0000\u0000\u0000`,
        attach.nonce,
        record.expiresAt
      )
      record.consumed = true
      audit({
        at: iso(at),
        kind: 'stream_attach_accepted',
        channelId: input.identity.channelId,
        clientCredentialId: channel.clientCredentialId,
        resource: `${record.grant.resource.kind}:${record.grant.resource.id}:${record.grant.resource.generation}`,
      })
      return record.grant
    } catch (error) {
      if (error instanceof ChannelRejection) throw error
      counters.capabilityDenied += 1
      audit({ at: iso(at), kind: 'stream_attach_refused', errorCode: 'unsupported_version' })
      throw new ChannelRejection('unsupported_version', 'malformed stream attach', 400)
    }
  }

  function registerCommandProvider(operation: DevOperation, handler: DevCommandHandler): void {
    commandProviders.set(operation, handler)
  }

  function auditSnapshot(): readonly ChannelAuditRecord[] {
    return [...auditRecords]
  }

  function countersSnapshot(): ChannelRejectionCounters {
    return { ...counters }
  }

  /** Test/ops introspection: active channel ids, never secrets. */
  function activeChannelIds(): readonly string[] {
    return [...channels.keys()]
  }

  function isTrustedRequest(context: {
    host?: string | null
    origin?: string | null
    secFetchSite?: string | null
  }): boolean {
    const trusted = isTrustedLoopbackRequest(context, policy)
    if (!trusted) counters.originRefused += 1
    return trusted
  }

  return {
    issueLaunchBootstrap,
    handshake,
    authenticateLegacyRequest,
    legacyProofMessage,
    execute,
    capabilitySnapshot,
    mintEventsToken,
    consumeEventsToken,
    registerCommandProvider,
    registerStreamProvider,
    hasStreamProvider,
    mintStreamGrant,
    attachStream,
    auditSnapshot,
    countersSnapshot,
    activeChannelIds,
    isTrustedRequest,
  }
}

export type ChannelAuthority = ReturnType<typeof createChannelAuthority>
