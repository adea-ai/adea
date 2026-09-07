import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import { createNativeTranscriptionProvider } from '../../src/transcription'

type Event =
  | Readonly<{ type: 'complete'; text: string }>
  | Readonly<{ type: 'error'; code: string }>

function harness(permission: 'denied' | 'granted' | 'unavailable' = 'granted') {
  let handler: (event: Event) => void = () => undefined
  const cancelled: string[] = []
  const starts: Array<Readonly<{ events: unknown; locale: string }>> = []
  const provider = createNativeTranscriptionProvider({
    async cancel(sessionId) {
      cancelled.push(sessionId)
    },
    createEventChannel(onEvent) {
      handler = onEvent
      return 'event-channel'
    },
    getLocale: async () => 'es-PR',
    language: 'en-US',
    requestPermission: async () => permission,
    async start(locale, events) {
      starts.push({ events, locale })
      return 'session-1'
    },
  })
  return { cancelled, emit: (event: Event) => handler(event), provider, starts }
}

describe('desktop native transcription provider', () => {
  test('limits native commands to the bundled window and declares both macOS usages', async () => {
    const capability = JSON.parse(
      await readFile(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8')
    ) as { permissions: string[]; windows: string[] }
    const permission = await readFile(
      new URL('../../src-tauri/permissions/transcription.toml', import.meta.url),
      'utf8'
    )
    const info = await readFile(new URL('../../src-tauri/Info.plist', import.meta.url), 'utf8')

    expect(capability.windows).toEqual(['main'])
    expect(capability.permissions).toContain('allow-desktop-transcription')
    expect(permission).toContain('desktop_transcription_permission')
    expect(permission).toContain('desktop_transcription_start')
    expect(permission).toContain('desktop_transcription_cancel')
    expect(info).toContain('NSMicrophoneUsageDescription')
    expect(info).toContain('NSSpeechRecognitionUsageDescription')
  })

  test('reports the native permission result', async () => {
    await expect(harness('granted').provider.requestPermission()).resolves.toBe('granted')
    await expect(harness('denied').provider.requestPermission()).resolves.toBe('denied')
    await expect(harness('unavailable').provider.requestPermission()).resolves.toBe('unavailable')
  })

  test('streams recognized text through the provider-neutral session', async () => {
    const native = harness()
    const session = await native.provider.start()
    expect(native.starts).toEqual([{ events: 'event-channel', locale: 'es-PR' }])
    native.emit({ text: 'editable text', type: 'complete' })
    await expect(session.completion).resolves.toEqual({ text: 'editable text' })
  })

  test('cancels by opaque session id without producing text', async () => {
    const native = harness()
    const session = await native.provider.start()
    session.cancel()
    await expect(session.completion).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(native.cancelled).toEqual(['session-1'])
  })

  test('maps native recognition failure without exposing provider details', async () => {
    const native = harness()
    const session = await native.provider.start({ locale: 'en-US' })
    expect(native.starts[0]?.locale).toBe('en-US')
    native.emit({ code: 'recognitionFailed', type: 'error' })
    await expect(session.completion).rejects.toMatchObject({ name: 'OperationError' })
  })
})
