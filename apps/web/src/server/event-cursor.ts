/**
 * Opaque reconnect cursor for the workspace event stream.
 *
 * The client only ever stores and returns the token; the server is the only
 * side that reads it. It is versioned, bound to one workspace, signed so a
 * client cannot mint one, and carries its issue time so a cursor can expire
 * instead of being trusted forever.
 *
 * The signing key is derived from the deployment's existing auth cookie secret
 * with a domain-separation label. That keeps one secret to rotate rather than
 * two, and a missing secret fails closed: the stream refuses to start rather
 * than signing cursors with a default.
 */

const CURSOR_VERSION = 'v1'
const CURSOR_DOMAIN = 'adea:workspace-event-cursor:v1'
/** How long a cursor stays verifiable; the retained-event window is the other bound. */
export const EVENT_CURSOR_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000

export type WorkspaceEventCursor = Readonly<{ sequence: number; workspaceId: string }>

export type CursorRejection = 'expired' | 'foreign-workspace' | 'malformed' | 'unavailable'

export type CursorDecodeResult =
  | Readonly<{ ok: true; cursor: WorkspaceEventCursor }>
  | Readonly<{ ok: false; reason: CursorRejection }>

function cursorSecret(environment: Record<string, string | undefined>): string | null {
  const secret = environment.NEON_AUTH_COOKIE_SECRET
  return secret && secret.length >= 32 ? secret : null
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

async function signingKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${CURSOR_DOMAIN}:${secret}`)
  )
  return crypto.subtle.importKey('raw', material, { hash: 'SHA-256', name: 'HMAC' }, false, [
    'sign',
    'verify',
  ])
}

async function sign(payload: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    new TextEncoder().encode(payload)
  )
  return base64url(new Uint8Array(signature))
}

/**
 * Mint the cursor a client stores and returns on reconnect. `sequence` is the
 * workspace sequence of the last event the client applied.
 */
export async function encodeWorkspaceEventCursor(
  cursor: WorkspaceEventCursor,
  environment: Record<string, string | undefined> = process.env,
  issuedAtMs: number = Date.now()
): Promise<string | null> {
  const secret = cursorSecret(environment)
  if (!secret) return null
  const payload = [
    CURSOR_VERSION,
    cursor.workspaceId,
    String(cursor.sequence),
    String(issuedAtMs),
  ].join(':')
  return `${base64url(new TextEncoder().encode(payload))}.${await sign(payload, secret)}`
}

/**
 * Verify a cursor. Every rejection is explicit: a client that presents a cursor
 * from another workspace, a forged one, an expired one, or a malformed one is
 * told to resync rather than being silently moved to a different position.
 */
export async function decodeWorkspaceEventCursor(
  token: string,
  workspaceId: string,
  environment: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now()
): Promise<CursorDecodeResult> {
  const secret = cursorSecret(environment)
  if (!secret) return { ok: false, reason: 'unavailable' }

  const [encoded, signature, ...rest] = token.split('.')
  if (!encoded || !signature || rest.length > 0) return { ok: false, reason: 'malformed' }

  let payload: string
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const [version, payloadWorkspaceId, sequenceValue, issuedAtValue, ...extra] = payload.split(':')
  if (
    version !== CURSOR_VERSION ||
    extra.length > 0 ||
    !payloadWorkspaceId ||
    !sequenceValue ||
    !issuedAtValue
  ) {
    return { ok: false, reason: 'malformed' }
  }

  const expected = await sign(payload, secret)
  // Constant-time-ish comparison over equal-length strings; a length mismatch is
  // already a rejection.
  if (
    expected.length !== signature.length ||
    !expected.split('').every((character, index) => character === signature[index])
  ) {
    return { ok: false, reason: 'malformed' }
  }

  if (payloadWorkspaceId !== workspaceId) return { ok: false, reason: 'foreign-workspace' }

  const sequence = Number(sequenceValue)
  const issuedAtMs = Number(issuedAtValue)
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(issuedAtMs)) {
    return { ok: false, reason: 'malformed' }
  }
  if (nowMs - issuedAtMs > EVENT_CURSOR_LIFETIME_MS) return { ok: false, reason: 'expired' }

  return { ok: true, cursor: { sequence, workspaceId: payloadWorkspaceId } }
}
