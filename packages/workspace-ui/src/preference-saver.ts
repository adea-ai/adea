export type PreferenceSaveState = 'saving' | 'saved' | 'error'

/**
 * Serialises what the Settings dialog shows while preference writes overlap.
 * Every save shows its value at once. Only the newest save may report back its
 * stored value or state, so an older response never overwrites a newer pick.
 * The last value known to be persisted is tracked separately: when the newest
 * pick is a revertable one that failed, the screen returns to that value once
 * every write has settled, whichever order the writes failed in.
 */
export function createPreferenceSaver<T>(options: {
  read(): T
  write(value: T): void
  /** Persists the value and resolves what was stored; undefined when nothing can persist. */
  persist(value: T): Promise<T> | undefined
  state(next: PreferenceSaveState): void
}) {
  let latest = 0
  let pending = 0
  let failed = false
  let confirmed: T

  const run = async (next: T, revertable: boolean): Promise<boolean> => {
    const mine = ++latest
    // With nothing in flight, what is shown is the last settled value.
    if (!pending) confirmed = options.read()
    failed = false
    options.write(next)
    const request = options.persist(next)
    if (!request) {
      if (revertable) options.write(confirmed)
      return false
    }
    options.state('saving')
    pending++
    let persisted = false
    try {
      confirmed = await request
      persisted = true
      if (mine === latest) {
        options.write(confirmed)
        options.state('saved')
      }
    } catch {
      if (mine === latest) {
        options.state('error')
        failed = revertable
      }
    }
    if (!--pending && failed) {
      failed = false
      options.write(confirmed)
    }
    return persisted
  }

  return {
    /** Resolves true only when the value was persisted. */
    save: (next: T) => run(next, false),
    /**
     * Like `save`, but when the newest pick fails the screen returns to the last
     * value known to be persisted, once no write is still in flight.
     */
    saveOrRevert: (change: (current: T) => T) => run(change(options.read()), true),
  }
}
