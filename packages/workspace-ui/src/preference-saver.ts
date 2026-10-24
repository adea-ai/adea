export type PreferenceSaveState = 'saving' | 'saved' | 'error'

/**
 * Serialises what the Settings dialog shows while preference writes overlap.
 * Every save shows its value at once; only the newest save may report back, so
 * an older response (success or failure) can never overwrite a newer pick.
 */
export function createPreferenceSaver<T>(options: {
  read(): T
  write(value: T): void
  /** Persists the value and resolves what was stored; undefined when nothing can persist. */
  persist(value: T): Promise<T> | undefined
  state(next: PreferenceSaveState): void
}) {
  let latest = 0

  /** Resolves true only when the value was persisted. */
  const save = async (next: T): Promise<boolean> => {
    const mine = ++latest
    options.write(next)
    const request = options.persist(next)
    if (!request) return false
    options.state('saving')
    try {
      const stored = await request
      if (mine === latest) {
        options.write(stored)
        options.state('saved')
      }
      return true
    } catch {
      if (mine === latest) options.state('error')
      return false
    }
  }

  /** Like `save`, but a failed save puts back what was shown unless a newer save has begun. */
  const saveOrRevert = async (change: (current: T) => T): Promise<boolean> => {
    const previous = options.read()
    const mine = latest + 1
    const persisted = await save(change(previous))
    if (!persisted && mine === latest) options.write(previous)
    return persisted
  }

  return { save, saveOrRevert }
}
