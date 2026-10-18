import { describe, expect, test } from 'bun:test'

import {
  createHistoryControl,
  type HistoryControlState,
  type HistorySource,
} from '../src/chat/model/history-control'

function control() {
  const states: HistoryControlState[] = []
  const history = createHistoryControl((state) => states.push(state))
  return { history, states, last: () => states.at(-1) }
}

function source(overrides: Partial<{ older: boolean; load: () => Promise<void> }> = {}) {
  let older = overrides.older ?? true
  const stream: HistorySource & { setOlder: (value: boolean) => void; loads: number } = {
    loads: 0,
    setOlder: (value) => {
      older = value
    },
    hasOlder: () => older,
    loadOlder: () => {
      stream.loads += 1
      return overrides.load ? overrides.load() : Promise.resolve()
    },
  }
  return stream
}

describe('chat history control', () => {
  test('a stream with no loadOlder offers no earlier turns', () => {
    const { history, last } = control()
    history.attach({ hasOlder: () => true })
    expect(last()).toBeUndefined()
    history.attach(source())
    expect(last()).toEqual({ hasOlder: true, loading: false, failed: false })
    history.attach({ hasOlder: () => true })
    expect(last()?.hasOlder).toBe(false)
  })

  test('a load reports loading, then re-reads whether more remain', async () => {
    const { history, states, last } = control()
    const stream = source()
    history.attach(stream)
    const run = history.load()
    expect(last()).toEqual({ hasOlder: true, loading: true, failed: false })
    stream.setOlder(false)
    await run
    expect(last()).toEqual({ hasOlder: false, loading: false, failed: false })
    expect(stream.loads).toBe(1)
    expect(states.length).toBeGreaterThan(1)
  })

  test('asking again while a load runs joins it instead of starting another', async () => {
    const { history } = control()
    let finish!: () => void
    const stream = source({ load: () => new Promise<void>((resolve) => (finish = resolve)) })
    history.attach(stream)
    const first = history.load()
    const second = history.load()
    expect(second).toBe(first)
    finish()
    await first
    expect(stream.loads).toBe(1)
  })

  test('a failure keeps the control for a retry and the retry clears it', async () => {
    const { history, last } = control()
    let fail = true
    const stream = source({
      load: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve()),
    })
    history.attach(stream)
    await history.load()
    expect(last()).toEqual({ hasOlder: true, loading: false, failed: true })
    fail = false
    const retry = history.load()
    expect(last()).toEqual({ hasOlder: true, loading: true, failed: false })
    await retry
    expect(last()).toEqual({ hasOlder: true, loading: false, failed: false })
    expect(stream.loads).toBe(2)
  })

  test('a cancelled load is not a failure', async () => {
    const { history, last } = control()
    history.attach(
      source({ load: () => Promise.reject(new DOMException('cancelled', 'AbortError')) })
    )
    await history.load()
    expect(last()).toEqual({ hasOlder: true, loading: false, failed: false })
  })

  test('a load that finishes after the stream changed touches nothing of the new one', async () => {
    const { history, last } = control()
    let finish!: () => void
    let fail!: (error: Error) => void
    history.attach(
      source({
        load: () =>
          new Promise<void>((resolve, reject) => {
            finish = resolve
            fail = reject
          }),
      })
    )
    const stale = history.load()
    history.attach(source({ older: true }))
    expect(last()).toEqual({ hasOlder: true, loading: false, failed: false })
    fail(new Error('late failure from the old conversation'))
    await stale
    expect(last()).toEqual({ hasOlder: true, loading: false, failed: false })
    finish()
  })

  test('detaching clears everything', () => {
    const { history, last } = control()
    history.attach(source())
    history.detach()
    expect(last()).toEqual({ hasOlder: false, loading: false, failed: false })
  })

  test('there is nothing to load when the stream says none remains', async () => {
    const { history } = control()
    const stream = source({ older: false })
    history.attach(stream)
    await history.load()
    expect(stream.loads).toBe(0)
  })
})
