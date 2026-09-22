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
  decodeDevCommand,
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

/**
 * The trusted internal-caller marker for `dispatchLocal` (the in-process
 * dispatch seam). The authority is the sole gate in front of the shell's
 * privileged command surface, and this symbol is the only key that opens the
 * in-process lane: `dispatchLocal` fails closed without the exact marker, so
 * the seam cannot be reached accidentally and no renderer-reachable path can
 * mint one (the symbol lives in shell-internal module scope, never crosses a
 * transport, and is not part of any bridge contract).
 *
 * Trust argument — what an internal caller satisfies STRUCTURALLY, because it
 * authors the envelope itself and holds no client-supplied bytes:
 * - Trusted origin: the caller runs inside the shell process (the same trust
 *   boundary the socket path proves with the loopback origin checks).
 * - Channel credential and identity proof: there is no channel; the envelope
 *   is authored by shell code that already holds the provider-side trust, so
 *   there is no secret to verify and no identity to bind.
 * - Replay: the envelope is minted fresh per dispatch inside the trust
 *   boundary and never serialized onto a transport, so no captured bytes can
 *   be replayed; a stale envelope is still bounded by the freshness window.
 * What it does NOT satisfy structurally — and therefore what `dispatchLocal`
 * still runs exactly as the socket path does: scope admission
 * (`authorizeCommand`), capability derivation against the registry, the
 * freshness/expiry window, resource binding and the generation fence (provider
 * re-proofs), and registered-provider invocation.
 */
export const INTERNAL_DISPATCH_MARKER: unique symbol = Symbol('adea.dev-runtime.internal-dispatch')
export type InternalDispatchMarker = typeof INTERNAL_DISPATCH_MARKER

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

export type DevCommandHandler = (
  command: DevCommand,
  /** The authenticated channel of the caller; stream-grant replies bind to it. */
  identity?: ChannelIdentity
) => unknown | Promise<unknown>

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
  eventsToken?: { value: string; event: string; expiresAt: number; consumed: boolean }
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

/** Safe accessors for the in-process lane, where the argument is the command
 *  itself (not the frame wrapper) and may be malformed at runtime. */
function localRequestId(command: unknown): string {
  try {
    const id = (command as { requestId?: unknown } | undefined)?.requestId
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

function localOperation(command: unknown): DevOperation | undefined {
  try {
    const operation = (command as { operation?: unknown } | undefined)?.operation
    return typeof operation === 'string' ? (operation as DevOperation) : undefined
  } catch {
    return undefined
  }
}

function localResourceLabel(command: unknown): string | undefined {
  try {
    const resource = (
      command as { resource?: { kind?: unknown; id?: unknown; generation?: unknown } } | undefined
    )?.resource
    if (!resource || typeof resource !== 'object') return undefined
    return `${String(resource.kind)}:${String(resource.id)}:${String(resource.generation)}`
  } catch {
    return undefined
  }
}

export function createChannelAuthority(options?: {
  /** Injected wall clock in epoch milliseconds (host tests use a fixed one). */
  now?: () => number
  shellHost: string
  shellOrigin: string
  /** Authoritative account/workspace/node admission, supplied by the host.
   *  `identity` is the authenticated channel of the caller; the in-process
   *  `dispatchLocal` lane passes none (there is no channel to bind), which is
   *  sound because its envelope holds no client-supplied bytes. */
  authorizeCommand?: (command: DevCommand, identity?: ChannelIdentity) => void | Promise<void>
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
      // replay. Capability derivation and scope admission follow the proof.
      const frame = decodeAuthorizedDevFrame(raw)
      const channel = channelFor(frame)
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
      // Step 3 precedes capability derivation: the renderer-submitted scope is
      // never trusted, so a scope mismatch is refused before the capability
      // set is compared and before any provider dispatch can run.
      if (options?.authorizeCommand) {
        try {
          await options.authorizeCommand(frame.command, {
            channelId: frame.channelId,
            clientCredentialId: frame.clientCredentialId,
          })
        } catch (error) {
          throw new ChannelRejection(
            error instanceof ChannelRejection ? error.code : 'channel_unauthenticated',
            error instanceof Error ? error.message : 'command scope is not authorized',
            403
          )
        }
      }
      const definition = devOperationDefinitions[frame.command.operation]
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
        value = await provider(frame.command, {
          channelId: frame.channelId,
          clientCredentialId: frame.clientCredentialId,
        })
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
      // A provider's typed failure is a valid refusal, not a crash: a thrown
      // DevError-shaped value is surfaced verbatim so callers see the exact
      // contract code (spec: "Messages may change; code, retryability, and
      // remediation shape are API").
      if (isDevErrorShape(error)) {
        return refusal(error, {
          operation: decodeOperation(raw),
          channelId: decodeChannelId(raw),
          clientCredentialId: decodeCredentialId(raw),
        })
      }
      return refusal({
        code: 'invalid_state',
        retryable: false,
        message: 'command frame was malformed',
        observedAt: iso(now()),
      })
    }
  }

  // ── In-process dispatch (the internal-caller seam) ────────────────────────

  /**
   * Dispatches a FULLY-FORMED `DevCommand` through the same terminal steps the
   * socket path runs — structural validation (`decodeDevCommand`, the exact
   * decoder the authorized frame path reaches), the freshness/expiry window,
   * scope admission via `authorizeCommand`, capability derivation against the
   * operation registry, registered-provider invocation, and the reply/audit
   * machinery — with the trusted internal-caller marker standing in for the
   * socket transport proof. Fail closed: any other marker throws
   * `channel_unauthenticated` before a command is even looked at.
   *
   * Which proofs the marker replaces (and why that is sound) is documented on
   * `INTERNAL_DISPATCH_MARKER`; which steps still run is exactly the list
   * above. The command must be authored entirely by trusted shell code — the
   * seam never accepts a raw frame, a proof, or any client-supplied bytes.
   * Audit records for this lane carry no channel fields, which is what makes
   * an internal dispatch distinguishable in the audit trail.
   */
  async function dispatchLocal(
    marker: InternalDispatchMarker,
    command: DevCommand
  ): Promise<DevReply> {
    if (marker !== INTERNAL_DISPATCH_MARKER) {
      counters.originRefused += 1
      audit({ at: iso(now()), kind: 'command_refused', errorCode: 'channel_unauthenticated' })
      throw new ChannelRejection(
        'channel_unauthenticated',
        'internal dispatch requires the trusted in-process marker',
        403
      )
    }
    const at = now()
    const refusal = (error: DevError, operation?: DevOperation): DevReply => {
      counters.commandsRefused += 1
      audit({
        at: iso(now()),
        kind: 'command_refused',
        operation,
        resource: localResourceLabel(command),
        errorCode: error.code,
      })
      return {
        schemaVersion: 1,
        operation: (operation ?? 'unknown') as DevOperation,
        requestId: localRequestId(command),
        ok: false,
        error,
      }
    }
    try {
      // The same structural validation (shape, schema, size, scope, registry
      // capability equality, body/resource binding) the authorized frame path
      // reaches through `decodeAuthorizedDevFrame`.
      const decoded = decodeDevCommand(command)
      const issuedAt = Date.parse(decoded.issuedAt)
      const expiresAt = Date.parse(decoded.expiresAt)
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
      // Step 3, unchanged: scope admission precedes capability comparison and
      // any provider dispatch. There is no channel identity on this lane.
      if (options?.authorizeCommand) {
        try {
          await options.authorizeCommand(decoded)
        } catch (error) {
          throw new ChannelRejection(
            error instanceof ChannelRejection ? error.code : 'channel_unauthenticated',
            error instanceof Error ? error.message : 'command scope is not authorized',
            403
          )
        }
      }
      // Capability derivation, unchanged: the submitted capability set must
      // equal the registry's exactly (also enforced by the decoder; the
      // explicit check keeps the admission sequence legible and counted).
      const definition = devOperationDefinitions[decoded.operation]
      if (
        decoded.capabilities.length !== definition.capabilities.length ||
        decoded.capabilities.some(
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
      // Steps 4-6, unchanged: the local-device lane binds the shell itself,
      // and only a registered provider may serve the operation.
      const provider = commandProviders.get(decoded.operation)
      let value: unknown
      if (provider) {
        value = await provider(decoded)
      } else {
        counters.capabilityDenied += 1
        return refusal(
          {
            code: 'capability_unavailable',
            retryable: true,
            message: `no provider is registered for ${decoded.operation}`,
            observedAt: iso(now()),
          },
          decoded.operation
        )
      }
      counters.commandsAccepted += 1
      audit({
        at: iso(now()),
        kind: 'command_accepted',
        operation: decoded.operation,
        resource: decoded.resource
          ? `${decoded.resource.kind}:${decoded.resource.id}:${decoded.resource.generation}`
          : undefined,
      })
      return {
        schemaVersion: 1,
        operation: decoded.operation,
        requestId: decoded.requestId,
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
          localOperation(command)
        )
      }
      // A provider's typed failure is a valid refusal, surfaced verbatim —
      // the same contract the socket path honors.
      if (isDevErrorShape(error)) {
        return refusal(error, localOperation(command))
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

  function mintEventsToken(
    identity: ChannelIdentity,
    event: string
  ): { token: string; expiresAt: string } {
    const channel = channelFor(identity)
    if (event.length === 0 || event.length > 256) {
      throw new ChannelRejection('invalid_state', 'event name is malformed', 400)
    }
    const token = randomBytes(32).toString('base64url')
    channel.eventsToken = { value: token, event, expiresAt: now() + 60_000, consumed: false }
    return { token, expiresAt: iso(channel.eventsToken.expiresAt) }
  }

  function consumeEventsToken(identity: ChannelIdentity, event: string, token: string): boolean {
    const channel = channelFor(identity)
    const minted = channel.eventsToken
    if (!minted || minted.consumed || minted.expiresAt < now()) return false
    if (minted.event !== event) return false
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

  /**
   * Revokes every active channel (identity rebind, workspace switch, sign
   * out, session revocation). Each socket's next request fails
   * `channel_unauthenticated` and must complete a fresh trusted handshake
   * with a launch bootstrap — reconnects never inherit old authority.
   */
  function revokeAllChannels(): number {
    const count = channels.size
    channels.clear()
    grants.clear()
    if (count > 0) {
      audit({ at: iso(now()), kind: 'handshake_refused', errorCode: 'channel_unauthenticated' })
    }
    return count
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

  /** Composition introspection: which operations have a registered provider. */
  function registeredOperations(): readonly DevOperation[] {
    return [...commandProviders.keys()]
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
    dispatchLocal,
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
    revokeAllChannels,
    registeredOperations,
  }
}

/** Structural guard for provider-thrown DevError values (never a guess). */
function isDevErrorShape(error: unknown): error is DevError {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; retryable?: unknown; message?: unknown }
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    typeof candidate.message === 'string' &&
    candidate.message.length > 0
  )
}

export type ChannelAuthority = ReturnType<typeof createChannelAuthority>
