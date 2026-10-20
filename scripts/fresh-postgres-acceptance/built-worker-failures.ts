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
const SECRET_FIELD = new RegExp(`(${SECRET_NAME})\\s*:\\s*("[^"]*"|'[^']*'|[^\\s,;)&]+)`, 'giu')

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
  text = text.replace(SECRET_ASSIGNMENT, `$1=${REDACTED}`)
  text = text.replace(SECRET_FIELD, `$1: ${REDACTED}`)
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
