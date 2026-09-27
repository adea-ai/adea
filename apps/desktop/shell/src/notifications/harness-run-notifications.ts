import {
  publishChatNotifications,
  type ChatNotification,
  type ChatNotificationInput,
  type DesktopNotificationSink,
} from '@adea-ai/dev-view/chat/notifications'

type HarnessRun = ChatNotificationInput['currentRuns'][number]

export type NativeNotificationRequest = Readonly<{
  title: string
  body: string
}>

export type NativeNotificationApi = Readonly<{
  showNotification?: (request: NativeNotificationRequest) => void
}>

/** A successful call means only that the host API call returned. */
export type NativeNotificationRequestStatus =
  | Readonly<{ status: 'requested' }>
  | Readonly<{ status: 'unavailable'; reason: 'api_missing' | 'request_failed' }>

export type RunNotificationPublisher = Readonly<{
  /** Establish the starting point after the host and its durable stores exist. */
  seed(): void
  /** Called by the host bus; only the wrapped durable run.status fact is observed. */
  onPublishedEvent(event: string, payload?: unknown): void
  /** Fences callbacks retained by an old host composition. */
  dispose(): void
}>

/**
 * Make a fixed, value-free OS request. The pure intent may contain a session
 * ID and a redacted title for in-app use, but none of those fields cross this
 * native boundary. Electrobun's void return confirms only that the call
 * returned; it is not a delivery receipt.
 */
export function requestNativeChatNotification(
  api: NativeNotificationApi | undefined,
  _intent: ChatNotification
): NativeNotificationRequestStatus {
  if (!api || typeof api.showNotification !== 'function')
    return { status: 'unavailable', reason: 'api_missing' }
  try {
    api.showNotification({ title: 'Adea', body: 'A conversation needs your attention.' })
    return { status: 'requested' }
  } catch {
    return { status: 'unavailable', reason: 'request_failed' }
  }
}

/**
 * Compares bounded durable HarnessRun snapshots on the shell publish path.
 * `RunHistoryStore.list()` already enforces its 200-run retention bound.
 */
export function createHarnessRunNotificationPublisher(input: {
  readRuns: () => readonly HarnessRun[]
  focusedSessionId: () => string | undefined
  windowFocused: () => boolean
  request: DesktopNotificationSink
}): RunNotificationPublisher {
  let previousRuns: readonly HarnessRun[] | undefined
  let disposed = false

  function snapshot(): readonly HarnessRun[] {
    return [...input.readRuns()]
  }

  function seed(): void {
    if (disposed) return
    try {
      previousRuns = snapshot()
    } catch {
      // A failed initial read must not turn persisted old runs into fresh alerts.
      previousRuns = undefined
    }
  }

  function onPublishedEvent(event: string, payload?: unknown): void {
    if (
      disposed ||
      event !== 'dev.harness.updated' ||
      !payload ||
      typeof payload !== 'object' ||
      !('kind' in payload) ||
      payload.kind !== 'run.status'
    )
      return

    let currentRuns: readonly HarnessRun[]
    try {
      currentRuns = snapshot()
    } catch {
      // Keep the last good baseline; the next durable event can retry the read.
      return
    }

    const before = previousRuns
    // Advance first, even when the model suppresses this transition or the
    // native request fails, so a later event cannot replay it as a new alert.
    previousRuns = currentRuns
    if (!before) return

    try {
      publishChatNotifications(
        {
          currentRuns,
          previousRuns: before,
          // Display names and other session metadata are unnecessary at the
          // host boundary; the native sink always discards intent text anyway.
          sessions: [],
          focusedSessionId: input.focusedSessionId(),
          windowFocused: input.windowFocused(),
        },
        (intent) => {
          try {
            input.request(intent)
          } catch {
            // Notification failures are intentionally silent and isolated from
            // the already-durable runtime transition.
          }
        }
      )
    } catch {
      // Presentation must never affect the host's command/event path.
    }
  }

  return {
    seed,
    onPublishedEvent,
    dispose() {
      disposed = true
      previousRuns = undefined
    },
  }
}
