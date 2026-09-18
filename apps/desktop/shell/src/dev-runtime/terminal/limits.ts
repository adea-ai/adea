// The terminal limits the Dev Runtime spec fixes as M12 initial defaults
// ("Output and replay", "Consolidated limits registry", "Event model"). Every
// bound here is normative: exhaustion returns a typed error or a resync, it
// never truncates silently or allocates an unbounded fallback. An
// implementation may tighten a value; relaxing one requires a spec change.
export const TERMINAL_LIMITS = {
  /** Maximum source chunk before splitting (64 KiB). */
  maxChunkBytes: 64 * 1024,
  /** Memory ring: 4 MiB and 10,000 chunks/session, whichever comes first. */
  ringMaxBytes: 4 * 1024 * 1024,
  ringMaxChunks: 10_000,
  /** Subscribers: 8/session. */
  maxSubscribers: 8,
  /** Queued input: 1 MiB/session, then `backpressure`. */
  inputQueueMaxBytes: 1024 * 1024,
  /** Per-subscriber high-water; above it the subscriber gets a resync. */
  subscriberHighWaterBytes: 1024 * 1024,
  /** Heartbeat every 15 seconds; unhealthy after 45 seconds. */
  heartbeatIntervalMs: 15_000,
  heartbeatUnhealthyAfterMs: 45_000,
  /** Reconnect backoff: 250 ms exponential with jitter, capped at 30 s. */
  reconnectBackoffBaseMs: 250,
  reconnectBackoffMaxMs: 30_000,
  /** Checkpoint at most every 5 seconds and at least every 1 MiB while active. */
  checkpointIntervalMs: 5_000,
  checkpointIntervalBytes: 1024 * 1024,
  /** Durable terminal data: 256 MiB/session, 2 GiB/workspace. */
  durableMaxBytesPerSession: 256 * 1024 * 1024,
  durableMaxBytesPerWorkspace: 2 * 1024 ** 3,
  /** OSC payload maximum 2 KiB; authenticated hook frame maximum 8 KiB. */
  oscPayloadMaxBytes: 2 * 1024,
  hookFrameMaxBytes: 8 * 1024,
  /** Parser rate maximum 1,000 frames/second/session before degradation. */
  maxHookFramesPerSecond: 1_000,
  /** Session input/output dimensions accepted by the registry. */
  maxCols: 1000,
  maxRows: 1000,
} as const
