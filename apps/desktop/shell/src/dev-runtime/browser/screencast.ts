// Lane screencast flow control. The publisher keeps one in-flight frame plus
// the newest complete frame — never an incremental backlog — and the input
// path is fenced by lane generation and viewport sequence with a hard rate
// cap. Frame budget defaults come from the Dev Runtime spec's consolidated
// limits (15 FPS default/30 max, 4096×4096, 8 MiB/frame, 240 inputs/s); the
// newest-frame-under-backpressure shape follows Buzz's bounded
// publication/subscription lesson (Apache-2.0, revision
// eed74bde2f4797714335ac10c56c0b0244c1def4) and Orca's frame pacer (MIT,
// revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7), with Adea's
// generation/sequence authorization added on top.
export type ScreencastFrame = Readonly<{
  sequence: string
  generation: number
  viewportSequence: number
  keyframe: boolean
  bytes: Uint8Array
}>

export type ScreencastBudget = Readonly<{
  /** Frames per second ceiling; the spec default is 15, hard limit 30. */
  maxFps: number
  maxFrameBytes: number
  maxWidth: number
  maxHeight: number
  /** Maximum admitted input events per second (spec: 240). */
  maxInputPerSecond: number
}>

export const SCREENCAST_BUDGET_DEFAULTS: ScreencastBudget = Object.freeze({
  maxFps: 15,
  maxFrameBytes: 8 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 4096,
  maxInputPerSecond: 240,
})

export type ScreencastInputEvent = Readonly<{
  sequence: string
  generation: number
  viewportSequence: number
  bytes: Uint8Array
}>

export type ScreencastAdmission =
  | Readonly<{ accepted: true }>
  | Readonly<
      | { rejected: 'stale_generation' }
      | { rejected: 'stale_viewport' }
      | { rejected: 'rate_limited' }
      | { rejected: 'limit_exceeded' }
      | { rejected: 'backpressure' }
    >

export function createLaneScreencast(
  options: Readonly<{
    budget?: Partial<ScreencastBudget>
    /** Delivery sink wired to the authenticated stream by the provider. */
    onFrame?: (frame: ScreencastFrame) => void
  }> = {}
) {
  const budget: ScreencastBudget = { ...SCREENCAST_BUDGET_DEFAULTS, ...options.budget }
  if (budget.maxFps > 30) throw new Error('screencast FPS ceiling is 30')
  const minFrameIntervalMs = 1000 / budget.maxFps

  let inFlight = false
  let newest: ScreencastFrame | undefined
  let lastSentAt = 0
  let throttledTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let pendingViewportSequence = 0

  // Input fencing state: per-subscription monotonic sequence and a sliding
  // one-second window of admitted timestamps.
  let inputWindow: number[] = []

  function flush(frame: ScreencastFrame): void {
    inFlight = true
    lastSentAt = Date.now()
    options.onFrame?.(frame)
    // The frame is "in flight" only until the consumer acks or the next tick
    // runs; the publisher never holds a queue longer than one newest frame.
    queueMicrotask(() => {
      inFlight = false
      drainThrottled()
    })
  }

  function drainThrottled(): void {
    const pending = newest
    newest = undefined
    if (pending) flush(pending)
  }

  return {
    budget,

    close(): void {
      closed = true
      if (throttledTimer) clearTimeout(throttledTimer)
      newest = undefined
    },

    get isClosed(): boolean {
      return closed
    },

    /**
     * Publishes one captured frame. Oversized frames are refused outright;
     * frames faster than the budget replace the pending newest frame instead
     * of queueing, so a slow consumer can only ever lose sharpness, never
     * build latency.
     */
    publish(frame: ScreencastFrame): 'published' | 'throttled' | 'rejected' {
      if (closed) return 'rejected'
      if (frame.generation <= 0) return 'rejected'
      if (frame.bytes.byteLength === 0) return 'rejected'
      if (frame.bytes.byteLength > budget.maxFrameBytes) return 'rejected'
      if (frame.viewportSequence < pendingViewportSequence) return 'rejected'
      pendingViewportSequence = frame.viewportSequence

      const now = Date.now()
      const elapsed = now - lastSentAt
      if (!inFlight && elapsed >= minFrameIntervalMs) {
        flush(frame)
        return 'published'
      }
      // Keep only the newest complete frame; drop whatever was pending.
      newest = frame
      if (!throttledTimer) {
        throttledTimer = setTimeout(
          () => {
            throttledTimer = undefined
            drainThrottled()
          },
          Math.max(0, minFrameIntervalMs - elapsed)
        )
      }
      return 'throttled'
    },

    /** The consumer acks the last frame it rendered; credit gates delivery. */
    ack(_throughSequence: string, availableCreditFrames: number): void {
      inFlight = availableCreditFrames <= 0
      if (!inFlight) drainThrottled()
    },

    /**
     * Admits one input event. Stale generations and stale viewport sequences
     * are inert (dropped, never errors), matching the spec's stale-input
     * rule; only rate and size violations are reportable backpressure.
     */
    admitInput(event: ScreencastInputEvent, laneGeneration: number): ScreencastAdmission {
      if (closed) return { rejected: 'backpressure' }
      if (event.generation !== laneGeneration) return { rejected: 'stale_generation' }
      if (event.viewportSequence < pendingViewportSequence) return { rejected: 'stale_viewport' }
      if (event.bytes.byteLength > 4096) return { rejected: 'limit_exceeded' }
      const now = Date.now()
      inputWindow = inputWindow.filter((at) => now - at < 1000)
      if (inputWindow.length >= budget.maxInputPerSecond) return { rejected: 'rate_limited' }
      inputWindow.push(now)
      pendingViewportSequence = event.viewportSequence
      return { accepted: true }
    },
  }
}

export type LaneScreencast = ReturnType<typeof createLaneScreencast>
