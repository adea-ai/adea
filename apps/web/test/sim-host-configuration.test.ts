import { expect, test } from 'bun:test'
import { prepareSimHostDocument, readSimHostConfiguration } from '../src/lib/sim-host-configuration'

test('configuration keeps exact origins and removes the disposal listener after success', async () => {
  const lifecycle = new EventTarget()
  let signal: AbortSignal | undefined
  const result = await readSimHostConfiguration(lifecycle, async (input, init) => {
    expect(input).toBe('/configuration')
    expect(init.credentials).toBe('same-origin')
    expect(init.cache).toBe('no-store')
    signal = init.signal as AbortSignal
    return Response.json({ parentOrigins: ['https://app.example'] })
  })
  expect(result).toEqual({ parentOrigins: ['https://app.example'] })
  lifecycle.dispatchEvent(new Event('pagehide'))
  expect(signal!.aborted).toBe(false)
})

test('pagehide aborts a pending read without an unhandled rejection', async () => {
  const lifecycle = new EventTarget()
  const pending = readSimHostConfiguration(
    lifecycle,
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () =>
          reject(new DOMException('Disposed', 'AbortError'))
        )
      })
  )
  lifecycle.dispatchEvent(new Event('pagehide'))
  expect(await pending).toBeNull()
})

test('genuine configuration failures stay observable and release the listener', async () => {
  const lifecycle = new EventTarget()
  let signal: AbortSignal | undefined
  await expect(
    readSimHostConfiguration(lifecycle, async (_input, init) => {
      signal = init.signal as AbortSignal
      throw new Error('Configuration service failed')
    })
  ).rejects.toThrow('Configuration service failed')
  lifecycle.dispatchEvent(new Event('pagehide'))
  expect(signal!.aborted).toBe(false)
})

test('a destroyed native browsing context is discarded even without pagehide delivery', async () => {
  const lifecycle = Object.assign(new EventTarget(), { closed: false })
  const result = await readSimHostConfiguration(lifecycle, async () => {
    lifecycle.closed = true
    throw new TypeError('Failed to fetch')
  })
  expect(result).toBeNull()
  let requests = 0
  expect(
    await readSimHostConfiguration(lifecycle, async () => {
      requests++
      return Response.json({ parentOrigins: ['https://app.example'] })
    })
  ).toBeNull()
  expect(requests).toBe(0)
})

test('bootstrap waits until load and the next paint; discarded documents do not start work', async () => {
  let paint: FrameRequestCallback | undefined
  let cancelled = 0
  const lifecycle = Object.assign(new EventTarget(), {
    closed: false,
    document: { readyState: 'loading' },
    requestAnimationFrame(callback: FrameRequestCallback) {
      paint = callback
      return 17
    },
    cancelAnimationFrame(id: number) {
      expect(id).toBe(17)
      cancelled++
    },
    setTimeout() {
      return 19
    },
    clearTimeout(id: number) {
      expect(id).toBe(19)
    },
  })
  const pending = prepareSimHostDocument(lifecycle as unknown as Window)
  expect(paint).toBeUndefined()
  lifecycle.dispatchEvent(new Event('load'))
  expect(paint).toBeFunction()
  paint!(0)
  expect(await pending).toBe(true)
  expect(cancelled).toBe(1)
  paint = undefined
  const discarded = prepareSimHostDocument(lifecycle as unknown as Window)
  lifecycle.dispatchEvent(new Event('pagehide'))
  expect(await discarded).toBe(false)
  lifecycle.dispatchEvent(new Event('load'))
  expect(paint).toBeUndefined()
})

test('a suspended paint uses the next-task fallback, which disposal cancels before any read', async () => {
  let fallback: (() => void) | undefined
  let cancels = 0
  const lifecycle = Object.assign(new EventTarget(), {
    closed: false,
    document: { readyState: 'complete' },
    requestAnimationFrame() {
      return 17
    },
    cancelAnimationFrame(id: number) {
      expect(id).toBe(17)
      cancels++
    },
    setTimeout(callback: () => void, delay: number) {
      expect(delay).toBe(0)
      fallback = callback
      return 19
    },
    clearTimeout(id: number) {
      expect(id).toBe(19)
    },
  })
  const ready = prepareSimHostDocument(lifecycle as unknown as Window)
  fallback!()
  expect(await ready).toBe(true)
  let reads = 0
  const bootstrap = async () => {
    if (await prepareSimHostDocument(lifecycle as unknown as Window)) {
      reads++
      return readSimHostConfiguration(lifecycle, async () => Response.json({ parentOrigins: [] }))
    }
    return null
  }
  const disposed = bootstrap()
  const staleFallback = fallback!
  lifecycle.dispatchEvent(new Event('pagehide'))
  expect(await disposed).toBeNull()
  staleFallback()
  expect(reads).toBe(0)
  expect(cancels).toBe(2)
})
