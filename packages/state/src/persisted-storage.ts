// The browser-persistence boundary (#302 audit).
//
// Before this, six storage keys across four modules each hand-rolled their own
// read/write: rail preferences quarantined malformed text and normalized legacy
// shapes, the conventional-workspace restore deleted the key outright, the two
// plugin caches parsed and shape-checked inline, and the sidebar width read a
// bare `Number`. Three disciplines for one problem.
//
// This module owns the discipline:
//
//   - a parse failure is CORRUPTION: the raw text is moved to a quarantine key
//     so it survives for diagnostics and manual recovery instead of being
//     deleted;
//   - a validation failure is STALE (an old shape, an expired entry): the value
//     is dropped without quarantining, because that is the expected lifecycle;
//   - storage that throws (private modes, full quotas, disabled storage) is
//     best-effort: reads degrade to "nothing persisted", writes are swallowed.
//
// Callers keep their own schema and their own key; they no longer keep their
// own failure policy.

/** The storage surface these helpers need; `Storage` satisfies it. */
export type PersistedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type PersistedRead<T> = Readonly<{
  /** The validated value, absent when nothing valid was stored. */
  value?: T
  /** True when malformed text was found and preserved under the quarantine key. */
  quarantined: boolean
}>

/**
 * The browser's storage, or `undefined` where there is none (SSR, tests, an
 * environment without a DOM). Reading `window.localStorage` directly throws
 * outside a browser, which is why every caller goes through this.
 */
export function browserStorage(): PersistedStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    // Access can throw when storage is disabled by policy.
    return undefined
  }
}

/** Where corrupt text for `key` is preserved. Versioned like the data keys. */
export function quarantineKeyFor(key: string): string {
  return `${key}:quarantine:v1`
}

/**
 * Reads and validates one persisted value. `validate` receives the parsed JSON
 * and returns the value to use, or `undefined` when the stored shape is stale
 * or unacceptable (that is not corruption — nothing is quarantined).
 */
export function readPersisted<T>(
  storage: PersistedStorage | undefined,
  key: string,
  validate: (parsed: unknown) => T | undefined
): PersistedRead<T> {
  if (!storage) return { quarantined: false }
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return { quarantined: false }
  }
  if (raw === null) return { quarantined: false }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corruption: keep the exact bytes for recovery, never delete them.
    try {
      storage.setItem(quarantineKeyFor(key), raw)
    } catch {
      /* storage is unavailable; the read still fails closed */
    }
    return { quarantined: true }
  }

  try {
    const value = validate(parsed)
    return value === undefined ? { quarantined: false } : { value, quarantined: false }
  } catch {
    // A validator that throws is a programming error in the caller, but the
    // read must still fail closed rather than break the surface.
    return { quarantined: false }
  }
}

/**
 * Writes one persisted value. Returns whether it landed; callers that must know
 * can report it, everything else ignores the result the way it ignored the
 * try/catch it used to carry.
 */
export function writePersisted(
  storage: PersistedStorage | undefined,
  key: string,
  value: unknown
): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    // Private browsing or storage pressure must not break the surface.
    return false
  }
}
