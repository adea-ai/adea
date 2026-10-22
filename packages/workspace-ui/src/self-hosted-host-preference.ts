// The remembered self-hosted host, per account and workspace (#188).
//
// This is a local note, not a routing decision. No submission path reads it, so it
// never decides where work runs and never grants authority over a host. It only lets
// this browser keep a note about one host, scoped so that one workspace's note can
// never appear in another.
//
// The record is scoped by account and workspace, so one workspace's choice can never
// appear in another. A malformed record is quarantined rather than discarded, and a
// record from an unknown version is ignored, exactly as the rail preferences do.

export const SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY = 'adea:self-hosted-host:v1'
/** Malformed/future records are quarantined instead of discarded. */
export const SELF_HOSTED_HOST_PREFERENCE_QUARANTINE_KEY = 'adea:self-hosted-host:quarantine:v1'

export type SelfHostedHostPreferenceScope = Readonly<{
  accountId: string
  workspaceId: string
}>

export type SelfHostedHostPreference = Readonly<{
  version: 1
  /** The chosen host id per scope. */
  chosen: Readonly<Record<string, string>>
}>

export const defaultSelfHostedHostPreference: SelfHostedHostPreference = Object.freeze({
  version: 1,
  chosen: Object.freeze({}),
})

/** One scope key per account and workspace. */
export function selfHostedHostScopeKey(scope: SelfHostedHostPreferenceScope): string {
  return `${scope.accountId}:${scope.workspaceId}`
}

function normalizeRecord(raw: unknown): SelfHostedHostPreference | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (record.version !== 1) return undefined
  const chosen = record.chosen
  if (typeof chosen !== 'object' || chosen === null || Array.isArray(chosen)) return undefined
  const normalized: Record<string, string> = {}
  for (const [scope, hostId] of Object.entries(chosen)) {
    if (typeof hostId !== 'string' || hostId.length === 0) continue
    normalized[scope] = hostId
  }
  return { version: 1, chosen: Object.freeze(normalized) }
}

export type NormalizedSelfHostedHostPreference = Readonly<{
  value: SelfHostedHostPreference
  /** The unread raw record when it could not be normalized. Retained, never erased. */
  retainedRaw?: unknown
}>

/** Parse a stored record. Unknown versions and malformed records fall back to the default. */
export function normalizeSelfHostedHostPreference(
  raw: unknown
): NormalizedSelfHostedHostPreference {
  const value = normalizeRecord(raw)
  return value ? { value } : { value: defaultSelfHostedHostPreference, retainedRaw: raw }
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type PreferenceStorageSource =
  | PreferenceStorage
  | (() => PreferenceStorage | undefined)
  | undefined

/**
 * The storage this preference is kept in, or none. A caller may hand over a factory,
 * and that factory may throw: a browser can refuse storage outright, and a caller may
 * pass a getter that fails. Such a failure means "no note", never a broken view and
 * never a thrown error.
 */
function resolveStorage(source: PreferenceStorageSource): PreferenceStorage | undefined {
  if (!source) return undefined
  try {
    const selected = typeof source === 'function' ? source() : source
    return selected ?? undefined
  } catch {
    return undefined
  }
}

/** The chosen host for one scope, or undefined when this scope has none. */
export function readSelfHostedHostPreference(
  source: PreferenceStorageSource,
  scope: SelfHostedHostPreferenceScope
): string | undefined {
  const storage = resolveStorage(source)
  if (!storage) return undefined
  try {
    const raw = storage.getItem(SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY)
    if (raw === null) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Preserve malformed text byte-for-byte for diagnostics/recovery.
      try {
        storage.setItem(SELF_HOSTED_HOST_PREFERENCE_QUARANTINE_KEY, raw)
      } catch {
        // Storage remains best-effort; the active view still fails closed.
      }
      return undefined
    }
    const normalized = normalizeSelfHostedHostPreference(parsed)
    if (normalized.retainedRaw !== undefined) {
      try {
        storage.setItem(
          SELF_HOSTED_HOST_PREFERENCE_QUARANTINE_KEY,
          JSON.stringify(normalized.retainedRaw)
        )
      } catch {
        // Storage remains best-effort; the active view still fails closed.
      }
    }
    return normalized.value.chosen[selfHostedHostScopeKey(scope)]
  } catch {
    return undefined
  }
}

/**
 * Record the chosen host for one scope, or clear it when the choice is removed. Other
 * scopes are preserved: one workspace's choice never disturbs another's.
 */
export function writeSelfHostedHostPreference(
  source: PreferenceStorageSource,
  scope: SelfHostedHostPreferenceScope,
  hostId: string | undefined
): void {
  const storage = resolveStorage(source)
  if (!storage) return
  try {
    const key = selfHostedHostScopeKey(scope)
    const current = readSelfHostedHostPreference(storage, scope)
    if (hostId === undefined) {
      if (current === undefined) return
      const raw = storage.getItem(SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY)
      const record =
        raw === null
          ? defaultSelfHostedHostPreference
          : normalizeSelfHostedHostPreference(JSON.parse(raw)).value
      const { [key]: _removed, ...rest } = record.chosen
      storage.setItem(
        SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY,
        JSON.stringify({ version: 1, chosen: rest } satisfies SelfHostedHostPreference)
      )
      return
    }
    const raw = storage.getItem(SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY)
    const record =
      raw === null
        ? defaultSelfHostedHostPreference
        : normalizeSelfHostedHostPreference(JSON.parse(raw)).value
    storage.setItem(
      SELF_HOSTED_HOST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        chosen: { ...record.chosen, [key]: hostId },
      } satisfies SelfHostedHostPreference)
    )
  } catch {
    // A stored choice is a convenience. A storage failure never blocks the view.
  }
}
