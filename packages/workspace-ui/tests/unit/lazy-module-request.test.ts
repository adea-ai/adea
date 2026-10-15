import { expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import { createLazyModule } from '../../src/lazy-module'
import { createLazyModuleRequest } from '../../src/lazy-module-request'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  // Also flush the shared import's cache/reset continuation.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function mount(load: () => Promise<string>) {
  const loaded: string[] = []
  const failed: (string | undefined)[] = []
  const owner = createRoot((dispose) => {
    const [request, select] = createSignal<string | undefined>('edit:first')
    const [current, setCurrent] = createSignal<string>()
    createLazyModuleRequest({
      request,
      current,
      load,
      onLoad: (module) => {
        loaded.push(module)
        setCurrent(module)
      },
      onError: () => {
        failed.push(request())
        select(undefined)
      },
    })
    return { dispose, request, select }
  })
  return { ...owner, loaded, failed }
}

for (const outcome of ['resolve', 'reject'] as const) {
  test(`a panel import that ${outcome}s after board unmount cannot change the new selection`, async () => {
    const pending = deferred<string>()
    const board = mount(() => pending.promise)
    board.dispose()
    board.select('edit:another-board')
    if (outcome === 'resolve') pending.resolve('panel')
    else pending.reject(new Error('offline'))
    await flush()
    expect(board.request()).toBe('edit:another-board')
    expect(board.loaded).toEqual([])
    expect(board.failed).toEqual([])
  })

  test(`a superseded panel import that ${outcome}s cannot affect the pending replacement`, async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let calls = 0
    const board = mount(() => (++calls === 1 ? first.promise : second.promise))
    try {
      board.select('edit:second')
      expect(calls).toBe(2)
      if (outcome === 'resolve') first.resolve('obsolete panel')
      else first.reject(new Error('offline'))
      await flush()
      expect(board.request()).toBe('edit:second')
      expect(board.loaded).toEqual([])
      expect(board.failed).toEqual([])
      second.resolve('current panel')
      await flush()
      expect(board.loaded).toEqual(['current panel'])
    } finally {
      board.dispose()
    }
  })
}

test('changing A to B to A cannot revive the first request', async () => {
  const requests = [deferred<string>(), deferred<string>(), deferred<string>()]
  let calls = 0
  const board = mount(() => requests[calls++]!.promise)
  try {
    board.select('edit:second')
    board.select('edit:first')
    requests[0]!.reject(new Error('old failure'))
    requests[1]!.resolve('old panel')
    await flush()
    expect(board.request()).toBe('edit:first')
    expect(board.failed).toEqual([])
    expect(board.loaded).toEqual([])
    requests[2]!.resolve('latest panel')
    await flush()
    expect(board.loaded).toEqual(['latest panel'])
  } finally {
    board.dispose()
  }
})

test('clearing selection cancels the pending failure callback', async () => {
  const pending = deferred<string>()
  const board = mount(() => pending.promise)
  try {
    board.select(undefined)
    pending.reject(new Error('offline'))
    await flush()
    expect(board.failed).toEqual([])
    expect(board.loaded).toEqual([])
  } finally {
    board.dispose()
  }
})

test('a shared import failure reports only for the current selection and a new request retries', async () => {
  const pending = deferred<string>()
  let calls = 0
  const module = createLazyModule(() =>
    ++calls === 1 ? pending.promise : Promise.resolve('panel')
  )
  const board = mount(module.load)
  try {
    board.select('edit:second')
    expect(calls).toBe(1)
    pending.reject(new Error('offline'))
    await flush()
    expect(board.failed).toEqual(['edit:second'])
    expect(board.request()).toBeUndefined()
    board.select('create')
    await flush()
    expect(calls).toBe(2)
    expect(board.loaded).toEqual(['panel'])
    expect(board.request()).toBe('create')
  } finally {
    board.dispose()
  }
})
