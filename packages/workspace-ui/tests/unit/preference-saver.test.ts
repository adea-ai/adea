// Overlapping Settings writes: the newest pick wins on screen, and an older
// save's response (success or failure) never rewrites it.
import { describe, expect, test } from 'bun:test'

import { createPreferenceSaver, type PreferenceSaveState } from '../../src/preference-saver'

type Prefs = Readonly<{ icon: 'white' | 'violet' | 'black' }>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness() {
  let shown: Prefs = { icon: 'white' }
  const states: PreferenceSaveState[] = []
  const writes = new Map<Prefs['icon'], ReturnType<typeof deferred<Prefs>>>()
  const saver = createPreferenceSaver<Prefs>({
    read: () => shown,
    write: (value) => {
      shown = value
    },
    persist: (value) => {
      const pending = deferred<Prefs>()
      writes.set(value.icon, pending)
      return pending.promise
    },
    state: (next) => void states.push(next),
  })
  const pick = (icon: Prefs['icon']) => saver.saveOrRevert((current) => ({ ...current, icon }))
  return { pick, saver, writes, states, shown: () => shown }
}

describe('preference saver', () => {
  test('a failed save puts back what was shown', async () => {
    const h = harness()
    const result = h.pick('violet')
    expect(h.shown().icon).toBe('violet')
    h.writes.get('violet')!.reject(new Error('disk full'))
    expect(await result).toBe(false)
    expect(h.shown().icon).toBe('white')
    expect(h.states).toEqual(['saving', 'error'])
  })

  test('an older failure does not restore a stale value over a newer pick that saved', async () => {
    const h = harness()
    const violet = h.pick('violet')
    const black = h.pick('black')
    h.writes.get('black')!.resolve({ icon: 'black' })
    expect(await black).toBe(true)
    h.writes.get('violet')!.reject(new Error('late failure'))
    expect(await violet).toBe(false)
    expect(h.shown().icon).toBe('black')
    expect(h.states.at(-1)).toBe('saved')
  })

  test('an older success does not overwrite a newer pick with its stored value', async () => {
    const h = harness()
    const violet = h.pick('violet')
    const black = h.pick('black')
    h.writes.get('violet')!.resolve({ icon: 'violet' })
    await violet
    expect(h.shown().icon).toBe('black')
    h.writes.get('black')!.resolve({ icon: 'black' })
    await black
    expect(h.shown().icon).toBe('black')
  })

  test('with nothing to persist to, a save reports false and keeps nothing', async () => {
    let shown: Prefs = { icon: 'white' }
    const saver = createPreferenceSaver<Prefs>({
      read: () => shown,
      write: (value) => {
        shown = value
      },
      persist: () => undefined,
      state: () => undefined,
    })
    expect(await saver.saveOrRevert((c) => ({ ...c, icon: 'violet' }))).toBe(false)
    expect(shown.icon).toBe('white')
  })
})
