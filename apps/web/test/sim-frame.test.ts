import { expect, test } from 'bun:test'
import { startSimFrame } from '../src/lib/sim-frame'

const parentOrigin = 'https://app.example'
const bridgeId = 'bridge_nonce_123456789'
const launch = {
  code: 'c'.repeat(43),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  surface: 'hq',
}

function fixture(
  options: {
    exchange?: () => Promise<boolean>
    mount?: Parameters<typeof startSimFrame>[0]['mount']
  } = {}
) {
  const listeners = new Map<string, (event: unknown) => unknown>()
  const posts: unknown[] = []
  let mounted = 0
  let unmounted = 0
  const parent = {
    postMessage(value: unknown, origin: string) {
      posts.push({ value, origin })
    },
  }
  const window = {
    parent,
    location: {
      hash: '#' + new URLSearchParams({ parentOrigin, bridgeId, scene: 'work' }),
      pathname: '/frame',
    },
    history: { replaceState() {} },
    addEventListener(type: string, listener: (event: unknown) => unknown) {
      listeners.set(type, listener)
    },
    removeEventListener(type: string) {
      listeners.delete(type)
    },
  } as unknown as Window
  const stop = startSimFrame({
    window,
    parentOrigins: [parentOrigin],
    exchange: options.exchange ?? (async () => true),
    mount:
      options.mount ??
      (async (_, scene) => {
        expect(scene).toBe('work')
        mounted++
        return {
          unmount() {
            unmounted++
          },
        }
      }),
  })
  const message = (
    type: string,
    payload: unknown = {},
    origin = parentOrigin,
    source: unknown = parent
  ) =>
    listeners.get('message')?.({
      origin,
      source,
      data: { channel: 'adea.agent-sim.bridge', version: 1, bridgeId, type, payload },
    })
  return { message, stop, posts, mounted: () => mounted, unmounted: () => unmounted }
}

test('frame ignores foreign hosts and duplicates; successful mount is disposed once', async () => {
  const f = fixture()
  await f.message('host.launch', launch, 'https://foreign.example')
  expect(f.mounted()).toBe(0)
  await f.message('host.launch', launch)
  await f.message('host.launch', launch)
  expect(f.mounted()).toBe(1)
  await f.message('host.dispose')
  f.stop()
  expect(f.unmounted()).toBe(1)
})

test('failed exchange never requests private runtime bytes', async () => {
  const f = fixture({ exchange: async () => false })
  await f.message('host.launch', launch)
  expect(f.mounted()).toBe(0)
  expect(f.posts).toContainEqual({
    origin: parentOrigin,
    value: {
      channel: 'adea.agent-sim.bridge',
      version: 1,
      bridgeId,
      type: 'frame.error',
      payload: { code: 'launch_rejected' },
    },
  })
})

test('dispose fences a pending mount and unmounts its late result', async () => {
  let finish!: (handle: { unmount(): void }) => void
  let unmounted = 0
  const f = fixture({
    mount: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const pending = f.message('host.launch', launch)
  await Promise.resolve()
  f.stop()
  finish({
    unmount() {
      unmounted++
    },
  })
  await pending
  expect(unmounted).toBe(1)
  expect(f.posts).toHaveLength(1)
})

test('frame save waits for the exact authenticated host result and disposal fails an open save', async () => {
  let actions!: Parameters<Parameters<typeof startSimFrame>[0]['mount']>[3]
  const f = fixture({
    mount: async (_, __, ___, next) => {
      actions = next
      return { unmount() {} }
    },
  })
  await f.message('host.launch', { ...launch, surface: 'character-designer' })
  const pending = actions.saveCharacter('avatar-id')
  expect(f.posts.at(-1)).toMatchObject({
    value: {
      type: 'frame.character.save',
      payload: { requestId: 'save1', character: 'avatar-id' },
    },
  })
  await f.message(
    'host.character.save.result',
    { requestId: 'save1', saved: true },
    'https://foreign.example'
  )
  await f.message('host.character.save.result', { requestId: 'different', saved: true })
  await f.message('host.character.save.result', { requestId: 'save1', saved: true })
  expect(await pending).toBe(true)
  const abandoned = actions.saveCharacter('avatar-two')
  f.stop()
  expect(await abandoned).toBe(false)
  expect(await actions.saveCharacter('avatar-three')).toBe(false)
})

test('HQ requests a host designer transition without changing its own URL', async () => {
  let actions!: Parameters<Parameters<typeof startSimFrame>[0]['mount']>[3]
  const f = fixture({
    mount: async (_, __, ___, next) => {
      actions = next
      return { unmount() {} }
    },
  })
  await f.message('host.launch', launch)
  actions.navigate('character-designer')
  expect(f.posts.at(-1)).toMatchObject({
    value: {
      type: 'frame.navigate',
      payload: { target: 'character-designer', requestId: 'navigate1' },
    },
  })
})
