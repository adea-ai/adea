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
})
