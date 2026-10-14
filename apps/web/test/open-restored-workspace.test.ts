import { describe, expect, test } from 'bun:test'

import { createRestoredWorkspaceOpener } from '../src/lib/open-restored-workspace'

type Workspace = { id: string }

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Lets an open reach its switch, which starts a few microtasks after the call. */
const started = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(overrides: { loaded?: Workspace[]; refetch?: () => Promise<Workspace[]> } = {}) {
  const switched: string[] = []
  const opened: string[] = []
  const authorize = gate<void>()
  const opener = createRestoredWorkspaceOpener<Workspace>({
    loaded: () => overrides.loaded ?? [],
    refetch: overrides.refetch ?? (async () => []),
    async switchTo(workspace, isCurrent) {
      await authorize.promise
      if (!isCurrent()) return false
      switched.push(workspace.id)
      return true
    },
    onOpened: () => opened.push('closed'),
  })
  return { opener, switched, opened, authorize }
}

describe('opening a restored workspace', () => {
  test('a loaded workspace opens and closes the dialog', async () => {
    const { opener, switched, opened, authorize } = setup({ loaded: [{ id: 'w1' }] })
    authorize.resolve()
    expect(await opener.open('w1', () => true)).toBe(true)
    expect(switched).toEqual(['w1'])
    expect(opened).toHaveLength(1)
  })

  test('a failed list refresh recovers by asking again', async () => {
    const { opener, switched, authorize } = setup({ refetch: async () => [{ id: 'w1' }] })
    authorize.resolve()
    expect(await opener.open('w1', () => true)).toBe(true)
    expect(switched).toEqual(['w1'])
  })

  test('a workspace that never shows up leaves the dialog open', async () => {
    const { opener, switched, opened } = setup()
    expect(await opener.open('missing', () => true)).toBe(false)
    expect(switched).toEqual([])
    expect(opened).toEqual([])
  })

  test('closing the dialog while the list refreshes means nothing is opened', async () => {
    const refresh = gate<Workspace[]>()
    const { opener, switched, opened, authorize } = setup({ refetch: () => refresh.promise })
    authorize.resolve()
    const pending = opener.open('w1', () => true)
    opener.cancel()
    refresh.resolve([{ id: 'w1' }])
    expect(await pending).toBe(false)
    expect(switched).toEqual([])
    expect(opened).toEqual([])
  })

  test('closing the dialog while the switch is authorised means nothing is opened', async () => {
    const { opener, switched, opened, authorize } = setup({ loaded: [{ id: 'w1' }] })
    const pending = opener.open('w1', () => true)
    opener.cancel()
    authorize.resolve()
    expect(await pending).toBe(false)
    expect(switched).toEqual([])
    expect(opened).toEqual([])
  })

  test('leaving the workspace the dialog belonged to makes the open stale', async () => {
    const refresh = gate<Workspace[]>()
    const { opener, switched, authorize } = setup({ refetch: () => refresh.promise })
    authorize.resolve()
    let asking = true
    const pending = opener.open('w1', () => asking)
    asking = false
    refresh.resolve([{ id: 'w1' }])
    expect(await pending).toBe(false)
    expect(switched).toEqual([])
  })

  test('a newer open retires an older one that is still waiting', async () => {
    const refresh = gate<Workspace[]>()
    const { opener, switched, authorize } = setup({ refetch: () => refresh.promise })
    authorize.resolve()
    const first = opener.open('w1', () => true)
    const second = opener.open('w2', () => true)
    refresh.resolve([{ id: 'w1' }, { id: 'w2' }])
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(switched).toEqual(['w2'])
  })

  test('a switch dropped after authorising hands control back', async () => {
    const retired: string[] = []
    const authorize = gate<void>()
    const opener = createRestoredWorkspaceOpener<Workspace>({
      loaded: () => [{ id: 'w1' }],
      refetch: async () => [],
      async switchTo(_workspace, isCurrent) {
        await authorize.promise
        return isCurrent()
      },
      onOpened: () => {},
      onRetired: () => void retired.push('restored scope'),
    })
    const pending = opener.open('w1', () => true)
    await started()
    opener.cancel()
    authorize.resolve()
    expect(await pending).toBe(false)
    expect(retired).toEqual(['restored scope'])
  })

  test('a switch that lands, or one that never started, hands nothing back', async () => {
    const retired: string[] = []
    const opener = createRestoredWorkspaceOpener<Workspace>({
      loaded: () => [{ id: 'w1' }],
      refetch: async () => [],
      switchTo: async () => true,
      onOpened: () => {},
      onRetired: () => void retired.push('restored scope'),
    })
    expect(await opener.open('w1', () => true)).toBe(true)
    const stale = opener.open('w1', () => false)
    expect(await stale).toBe(false)
    expect(retired).toEqual([])
  })

  test('asking again after the dialog was reopened waits for the retired switch to finish', async () => {
    // The real switch holds one in-flight slot and refuses a second while it is taken.
    let busy = false
    const switched: string[] = []
    const authorize = gate<void>()
    const opened: string[] = []
    const opener = createRestoredWorkspaceOpener<Workspace>({
      loaded: () => [{ id: 'w1' }],
      refetch: async () => [],
      async switchTo(workspace, isCurrent) {
        if (busy) return false
        busy = true
        try {
          await authorize.promise
          if (!isCurrent()) return false
          switched.push(workspace.id)
          return true
        } finally {
          busy = false
        }
      },
      onOpened: () => opened.push('closed'),
    })
    const first = opener.open('w1', () => true)
    await started()
    opener.cancel() // the dialog closed while the first switch was being authorised
    const second = opener.open('w1', () => true) // reopened, and the person asks again
    authorize.resolve()
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(switched).toEqual(['w1'])
    expect(opened).toHaveLength(1)
  })

  test.each([
    [
      'throws synchronously',
      () => {
        throw new Error('shell refused')
      },
    ],
    ['rejects', () => Promise.reject(new Error('shell refused'))],
  ] as const)('a scope hand-back that %s never fails the open', async (_how, onRetired) => {
    const authorize = gate<void>()
    let hitRetired = false
    const opener = createRestoredWorkspaceOpener<Workspace>({
      loaded: () => [{ id: 'w1' }],
      refetch: async () => [],
      async switchTo(_workspace, isCurrent) {
        await authorize.promise
        return isCurrent()
      },
      onOpened: () => {},
      onRetired: () => {
        hitRetired = true
        return onRetired()
      },
    })
    // The person leaves while the switch is being authorised, so the switch is dropped after it started.
    let asking = true
    const pending = opener.open('w1', () => asking)
    await started()
    asking = false
    authorize.resolve()
    expect(await pending).toBe(false)
    expect(hitRetired).toBe(true)
  })
})
