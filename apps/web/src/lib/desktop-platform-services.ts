// Desktop platform services for the single web UI: the shell-backed
// capabilities, preferences, and dictation providers. Everything here is
// browser-safe and only resolves through the injected `window.__adeaDesktop`
// bridge, so the web lane never constructs them.
import type {
  CapabilityProvider,
  CapabilitySnapshot,
  TranscriptionProvider,
  TranscriptionSession,
  WorkspacePreferences,
  WorkspaceSettingsProvider,
} from '@adea-ai/workspace-ui'

import { Channel, invoke } from './desktop-bridge'

/**
 * Local capability health as the native shell reports it. The shell caches the
 * snapshot behind a re-probe floor, so `force` is a user-visible refresh rather
 * than something a poll should pass.
 */
export const desktopCapabilityProvider: CapabilityProvider = Object.freeze({
  snapshot(options) {
    return invoke<CapabilitySnapshot>('capability_snapshot', { force: options?.force ?? false })
  },
})

export const desktopSettingsProvider: WorkspaceSettingsProvider = Object.freeze({
  load() {
    return invoke<WorkspacePreferences>('desktop_preferences_load')
  },
  save(preferences) {
    return invoke<WorkspacePreferences>('desktop_preferences_save', { preferences })
  },
})

type NativeTranscriptionEvent =
  | Readonly<{ type: 'complete'; text: string }>
  | Readonly<{ type: 'error'; code: string }>

type NativeTranscriptionDependencies = Readonly<{
  cancel(sessionId: string): Promise<void>
  createEventChannel(onEvent: (event: NativeTranscriptionEvent) => void): unknown
  getLocale(): Promise<string>
  language: string
  requestPermission(): Promise<'denied' | 'granted' | 'unavailable'>
  start(locale: string, events: unknown): Promise<string>
}>

function nativeError(code: string) {
  if (code === 'permissionDenied')
    return new DOMException('System dictation permission is denied', 'NotAllowedError')
  return new DOMException('System dictation failed', 'OperationError')
}

export function createNativeTranscriptionProvider(
  dependencies: NativeTranscriptionDependencies
): TranscriptionProvider {
  return Object.freeze({
    id: 'macos-speech-framework',
    label: 'macOS system dictation',
    requestPermission: dependencies.requestPermission,
    async start(input = {}) {
      let settled = false
      let sessionId: string | null = null
      let rejectCompletion: (reason?: unknown) => void = () => undefined
      let resolveCompletion: (result: Readonly<{ text: string }>) => void = () => undefined
      const completion = new Promise<Readonly<{ text: string }>>((resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
      })
      const channel = dependencies.createEventChannel((event) => {
        if (settled) return
        settled = true
        if (event.type === 'complete') resolveCompletion({ text: event.text })
        else rejectCompletion(nativeError(event.code))
      })
      const configuredLocale = await dependencies.getLocale().catch(() => '')
      sessionId = await dependencies.start(
        input.locale ?? (configuredLocale || dependencies.language),
        channel
      )
      const session: TranscriptionSession = Object.freeze({
        cancel() {
          if (settled) return
          settled = true
          if (sessionId) void dependencies.cancel(sessionId).catch(() => undefined)
          rejectCompletion(new DOMException('Dictation cancelled', 'AbortError'))
        },
        completion,
      })
      return session
    },
  })
}

export const systemTranscriptionProvider = createNativeTranscriptionProvider({
  cancel: (sessionId) => invoke('desktop_transcription_cancel', { sessionId }),
  createEventChannel(onEvent) {
    return new Channel<NativeTranscriptionEvent>(onEvent)
  },
  getLocale: async () => (await desktopSettingsProvider.load()).dictationLocale,
  language: typeof navigator === 'undefined' ? 'en-US' : navigator.language,
  requestPermission: () => invoke('desktop_transcription_permission'),
  start: (locale, events) => invoke('desktop_transcription_start', { events, locale }),
})
