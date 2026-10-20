// The failure kinds and the redaction of the built-Worker qualification.
//
// A failure message is evidence, and evidence must not become a leak. The
// qualification runs against an instance that has a password, a schema that
// has a provider secret, and a local runtime that prints its own configuration
// when it fails. A raw exception message or a raw runtime log line can carry
// any of those values.
//
// So every failure the qualification reports has one of the fixed kinds below,
// and its detail is redacted before it is published: the secrets the run
// knows are removed, credential-shaped values are removed even when the run
// does not know them, and the result is bounded in length. The kinds are the
// vocabulary; the detail is evidence, never a value.

/** The fixed vocabulary of qualification failures. */
export type BuiltWorkerFailureKind =
  | 'artifact-unavailable'
  | 'artifact-provenance-unverified'
  | 'build-failed'
  | 'container-unavailable'
  | 'instance-unavailable'
  | 'migration-failed'
  | 'auth-schema-failed'
  | 'lifecycle-failed'
  | 'worker-start-failed'
  | 'worker-stop-failed'
  | 'transport-failed'
  | 'application-failure'
  | 'infrastructure-failure'
  | 'assertion-failed'
  | 'cleanup-failed'
  | 'unexpected-failure'

/** The kinds, so a test can prove the vocabulary did not grow unnoticed. */
export const BUILT_WORKER_FAILURE_KINDS: readonly BuiltWorkerFailureKind[] = [
  'artifact-unavailable',
  'artifact-provenance-unverified',
  'build-failed',
  'container-unavailable',
  'instance-unavailable',
  'migration-failed',
  'auth-schema-failed',
  'lifecycle-failed',
  'worker-start-failed',
  'worker-stop-failed',
  'transport-failed',
  'application-failure',
  'infrastructure-failure',
  'assertion-failed',
  'cleanup-failed',
  'unexpected-failure',
]

/** A qualification failure: a fixed kind and a redacted detail. */
export class BuiltWorkerFailure extends Error {
  readonly kind: BuiltWorkerFailureKind
  /** The redacted detail. It never carries a value the run knows. */
  readonly detail: string

  constructor(
    kind: BuiltWorkerFailureKind,
    detail = '',
    options: { readonly cause?: unknown; readonly secrets?: readonly string[] } = {}
  ) {
    super(`the built-Worker qualification failed: ${kind}`)
    this.name = 'BuiltWorkerFailure'
    this.kind = kind
    this.detail = sanitizeText(detail, options.secrets ?? [])
    if (options.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

/** The placeholder a redacted value leaves behind. */
export const REDACTED = '[redacted]'

/** How long a sanitized detail may be. */
const MAX_DETAIL_LENGTH = 400

/** How many runtime lines a sanitized log keeps. */
const MAX_LOG_LINES = 5

/** A URL that carries a password. */
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s@]*@/giu

/**
 * The name of a value that is a secret. The name may carry a prefix or a
 * suffix, so `AUTH_SECRET` and `x-password` are both recognised.
 */
const SECRET_NAME =
  '[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|apikey|api_key|credential|authorization|cookie)[A-Za-z0-9_.-]*'

/** A `name=value` pair whose name says the value is a secret. */
const SECRET_ASSIGNMENT = new RegExp(
  `(${SECRET_NAME})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s,;)&]+)`,
  'giu'
)

/** A `name: value` pair whose name says the value is a secret. */
const SECRET_FIELD = new RegExp(
  `(["']?)(${SECRET_NAME})\\1\\s*:\\s*("[^"]*"|'[^']*'|[^\\s,;)&]+)`,
  'giu'
)

/**
 * Removes every secret and every credential-shaped value from a text.
 *
 * The known secrets are removed first, so the exact value never survives. The
 * credential-shaped patterns are removed next, so a value the run did not know
 * — a password in a URL the runtime printed, a token in a log line — does not
 * survive either. The result is bounded, so a long detail cannot grow the
 * evidence without limit.
 */

/**
 * A URL query parameter whose name says the value is a secret.
 *
 * A failed response can name a token in its location, and a location that
 * reaches a receipt is a published credential. The parameter's name decides:
 * the value is replaced, the name is kept, so the evidence still says which
 * parameter was there.
 */
const SECRET_QUERY =
  /([?&][A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|apikey|api_key|credential|authorization|cookie|code|nonce)[A-Za-z0-9_.-]*=)([^&#\s"']*)/giu

/**
 * Removes every secret and every credential-shaped value from a text.
 *
 * The known secrets are removed first, so the exact value never survives. The
 * credential-shaped patterns are removed next, so a value the run did not know
 * — a password in a URL the runtime printed, a token in a log line — does not
 * survive either. The result is bounded, so a long detail cannot grow the
 * evidence without limit.
 */
export function sanitizeText(value: string, secrets: readonly string[] = []): string {
  let text = String(value ?? '')
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue
    text = text.split(secret).join(REDACTED)
    try {
      const encoded = encodeURIComponent(secret)
      if (encoded !== secret) text = text.split(encoded).join(REDACTED)
    } catch {
      // A secret that is not encodable is still removed by the plain match.
    }
  }
  text = text.replace(CREDENTIAL_URL, `$1://${REDACTED}:${REDACTED}@`)
  text = text.replace(SECRET_QUERY, `$1${REDACTED}`)
  text = text.replace(SECRET_ASSIGNMENT, `$1=${REDACTED}`)
  text = text.replace(SECRET_FIELD, `$1$2$1: ${REDACTED}`)
  // Control characters are removed without a control-character pattern: a
  // detail is one line, and a line break inside a published message is a way
  // to smuggle a second line past a reader.
  text = [...text]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
  return text.slice(0, MAX_DETAIL_LENGTH)
}

/**
 * The end of the string that starts at `start`, quotes included.
 *
 * The scan is linear and bounded: it walks the text once and it never
 * backtracks.
 */
function scanString(body: string, start: number): number {
  let index = start + 1
  while (index < body.length) {
    const character = body[index]!
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '"') return index + 1
    index += 1
  }
  return body.length
}

/** The content of the string between `start` and `end`. */
function readString(body: string, start: number, end: number): string {
  return body.slice(start + 1, Math.max(start + 1, end - 1))
}

/** The end of the value that starts at `start`. */
function scanValue(body: string, start: number): number {
  const character = body[start]
  if (character === '"') return scanString(body, start)
  if (character === '{' || character === '[') {
    let depth = 0
    let index = start
    while (index < body.length) {
      const current = body[index]!
      if (current === '"') {
        index = scanString(body, index)
        continue
      }
      if (current === '{' || current === '[') depth += 1
      else if (current === '}' || current === ']') {
        depth -= 1
        if (depth === 0) return index + 1
      }
      index += 1
    }
    return body.length
  }
  let index = start
  while (index < body.length && !',}]'.includes(body[index]!)) index += 1
  return index
}

/**
 * The span of the first top-level member with the given name.
 *
 * Only the top level counts: a member nested inside an object or an array is
 * not a top-level member, and neither is a value that only looks like one.
 */
function topLevelMemberValue(
  body: string,
  field: string
): { keyStart: number; valueStart: number; valueEnd: number } | null {
  let depth = 0
  let index = 0
  while (index < body.length) {
    const character = body[index]!
    if (character === '"') {
      const end = scanString(body, index)
      if (depth === 1) {
        let cursor = end
        while (cursor < body.length && body[cursor]!.trim() === '') cursor += 1
        if (body[cursor] === ':' && readString(body, index, end) === field) {
          let value = cursor + 1
          while (value < body.length && body[value]!.trim() === '') value += 1
          return { keyStart: index, valueStart: value, valueEnd: scanValue(body, value) }
        }
      }
      index = end
      continue
    }
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
    index += 1
  }
  return null
}

/**
 * The body with the first top-level occurrence of a value removed.
 *
 * A body is a structure, and the same credential may sit in it more than once.
 * Only the value of the one top-level member that is allowed to carry it is
 * removed: a nested copy and a duplicate member stay in the text, so the caller
 * still sees them and can refuse them.
 */
export function withoutTopLevelValue(body: string, field: string): string {
  const span = topLevelMemberValue(body, field)
  if (!span) return body
  return `${body.slice(0, span.valueStart)}${body.slice(span.valueEnd)}`
}

/**
 * The value of the first top-level member with the given name, when it is a
 * string.
 *
 * A member whose value is an object is not a scalar value: a credential that
 * carries another credential is not a credential. The nested member is not
 * reported, and the caller's own reading of the body is the only reading that
 * counts.
 */
export function topLevelStringValue(body: string, field: string): string | null {
  const span = topLevelMemberValue(body, field)
  if (!span) return null
  const raw = body.slice(span.valueStart, span.valueEnd).trim()
  if (!raw.startsWith('"')) return null
  return readString(raw, 0, scanString(raw, 0))
}

/**
 * Sanitizes every string of a value, however deeply it is nested.
 *
 * A receipt is a tree of strings, and a secret can sit in any of them: in a
 * detail, in a URL, in a name a suite reported, in a provenance field. The
 * whole tree is walked, so a field nobody thought of is covered too.
 */
export function sanitizeValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return sanitizeText(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, secrets))
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [name, entry] of Object.entries(value)) {
      sanitized[name] = sanitizeValue(entry, secrets)
    }
    return sanitized
  }
  return value
}

/**
 * The receipt as it may be published.
 *
 * Every field of the receipt is sanitized, not only the fields that are known
 * to carry a value. The receipt of a failed run is published as the evidence
 * of that failure, and evidence that leaks a credential is not evidence.
 */
export function sanitizeReceipt<T>(receipt: T, secrets: readonly string[] = []): T {
  return sanitizeValue(receipt, secrets) as T
}

/**
 * The receipt as it is published.
 *
 * The published receipt carries the teardown's verdict and nothing that must
 * not leave the run: every field is sanitized on the way out, whatever field
 * it sits in.
 */
export function publishedReceipt<T extends object>(input: {
  readonly receipt: T
  readonly verdict: {
    readonly workerStopped: boolean
    readonly containerRemoved: boolean
    readonly materialRemoved: boolean
  }
  readonly secrets?: readonly string[]
}): T & {
  readonly cleanup: {
    readonly workerStopped: boolean
    readonly containerRemoved: boolean
    readonly materialRemoved: boolean
  }
} {
  return sanitizeReceipt({ ...input.receipt, cleanup: input.verdict }, input.secrets ?? []) as T & {
    readonly cleanup: {
      readonly workerStopped: boolean
      readonly containerRemoved: boolean
      readonly materialRemoved: boolean
    }
  }
}

/**
 * The runtime lines a failure may quote.
 *
 * Only the lines that report a failure are kept, they are redacted, and their
 * number and length are bounded. The rest of the runtime's output is dropped:
 * it describes the run, and the run's evidence is the kind and the detail.
 */
export function sanitizeWorkerLogs(
  lines: readonly string[],
  secrets: readonly string[] = []
): readonly string[] {
  const kept = lines
    .filter((line) => /error|failed|denied|exception|fatal|panic/iu.test(line))
    .map((line) => sanitizeText(line, secrets))
    .filter((line) => line.length > 0)
  return kept.slice(-MAX_LOG_LINES)
}

/** The published message of a failure: its kind and its redacted detail. */
export function failureMessage(failure: BuiltWorkerFailure): string {
  return failure.detail
    ? `${failure.kind}: ${failure.detail}`
    : `${failure.kind}: the qualification did not complete`
}
