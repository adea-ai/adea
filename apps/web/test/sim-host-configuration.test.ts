import { expect, test } from 'bun:test'
import { readSimHostConfiguration } from '../src/lib/sim-host-configuration'

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
