import {
  SIM_BRIDGE_CHANNEL,
  SIM_IDLE,
  SIM_LAUNCH_SCHEMA_VERSION,
  createBridgeId,
  createOriginAllowlist,
  describeSimAvailability,
  parseFrameMessage,
  parseSimLaunchGrant,
  parseSimLaunchRequest,
  postToFrame,
  reduceSimLaunch,
  type OriginAllowlist,
  type SimAvailabilityNotice,
  type SimFrameRequestMessage,
  type SimFrameStatusMessage,
  type SimLaunchEffect,
  type SimLaunchEvent,
  type SimLaunchRequest,
  type SimLaunchState,
  type SimMessageEventLike,
  type SimNavigateTarget,
  type SimPlatform,
  type SimSaveFailure,
  type SimSurface,
} from '@adea-ai/spatial/sim-bridge'

/**
 * Host side of the hosted Agent Sim frame, with every outside dependency injected.
 *
 * The controller owns the launch attempt: it asks the backend for a grant, hands the frame's
 * origin to the view, forwards the single-use code once the frame reports ready, and turns
 * everything the frame says into the pure `reduceSimLaunch` state. It has no DOM, network or timer
 * of its own, and it picks no sim origin: `frameOrigin` is an input, and an absent or invalid one
 * means "not configured" without a single request. Only a grant for an allowlisted origin, for the
 * surface that was asked for, inside the contract's lifetime, is ever acted on.
 */

export type HostedSimFrame = Readonly<{
  /** The allowlisted origin the frame must load from. */
  origin: string
  /** The per-attempt nonce the frame echoes in every message. */
  bridgeId: string
}>

export type HostedSimSnapshot = Readonly<{
  state: SimLaunchState
  /** Truthful copy for a failure or offline state; null while idle, loading or running. */
  notice: SimAvailabilityNotice | null
  /** Present while a frame should be on screen (awaiting, launching or running). */
  frame: HostedSimFrame | null
  /** The frame is up but has not reported `running` yet. */
  starting: boolean
}>

type PostTarget = Readonly<{ postMessage(message: unknown, targetOrigin: string): void }>

export type HostedSimNavigateRequest = Readonly<{ target: SimNavigateTarget; requestId: string }>
/**
 * What a save is about. `signal` aborts when the save times out or its attempt ends (disposal,
 * navigation, a new attempt, a workspace or surface change), and the identity names the launch it
 * belongs to. The app must check `signal.aborted` and write its canonical state in the same
 * synchronous step, so a save that was given up on can never land after a newer one.
 */
export type HostedSimSaveRequest = Readonly<{
  requestId: string
  signal: AbortSignal
  workspaceId: string
  surface: SimSurface
  /** The launch attempt's channel nonce. */
  bridgeId: string
  attempt: number
}>

export type HostedSimControllerOptions = Readonly<{
  /** The sim origin to embed. Absent or invalid means not configured; nothing is requested. */
  frameOrigin: string | null | undefined
  allowLoopbackHttp?: boolean
  workspaceId: string
  surface: SimSurface
  /** A hint for the entitlement source only; it never proves a desktop identity. */
  platform: SimPlatform
  /**
   * Character forwarded in `host.launch`. A function is read when the launch is posted, so the
   * app's canonical character can change (a save) without relaunching a running frame.
   */
  character?: string | (() => string | undefined)
  /** Asks the Adea backend for a launch. The reply is unvalidated and checked here. */
  requestGrant(request: SimLaunchRequest, signal: AbortSignal): Promise<unknown>
  /**
   * Whether the host currently believes it is online. Read when an attempt starts: offline starts
   * the attempt in the offline state without asking the backend. Absent means online.
   */
  isOnline?(): boolean
  /** The frame element's `contentWindow`, read each time it is needed. */
  frameWindow(): PostTarget | null
  /**
   * The frame asks to open another surface. The attempt has already ended and the frame has been
   * told to dispose when this runs; the callback changes the launch configuration so a fresh grant
   * is issued for `target`. Absent means requests are ignored and the attempt continues.
   */
  onNavigate?(request: HostedSimNavigateRequest): void
  /**
   * The frame asks to save a validated character value. Resolve `true` only once the app's
   * canonical state holds it. `false` answers `refused` and a rejection answers `failed`; absent
   * answers `refused`. Nothing is answered after the attempt ends. Only one save runs at a time:
   * a new one is refused until the previous callback has settled, even if it already timed out.
   */
  onCharacterSave?(character: string, request: HostedSimSaveRequest): Promise<boolean> | boolean
  onChange(snapshot: HostedSimSnapshot): void
  /** How long the backend may take to answer. Clamped to 1s..60s. */
  requestTimeoutMs?: number
  /** How long the frame may take to become ready and then to report running. Clamped to 1s..60s. */
  frameTimeoutMs?: number
  /** How long `onCharacterSave` may take before the frame is told `timeout`. Clamped to 1s..60s. */
  saveTimeoutMs?: number
  now?: () => number
  mintBridgeId?: () => string
  /** Schedules `run` after `ms` and returns a canceller. */
  schedule?: (run: () => void, ms: number) => () => void
}>

export type HostedSimController = Readonly<{
  snapshot(): HostedSimSnapshot
  /**
   * Begins a new attempt from idle, unavailable or offline; does nothing mid-attempt. While
   * `isOnline()` is false the attempt is recorded as offline and no grant is requested.
   */
  start(): void
  /** Feeds a `window` `message` event in; anything not from the exact frame is dropped. */
  handleMessage(event: SimMessageEventLike): void
  setOffline(): void
  /** The host came back online: an offline surface starts a new attempt on its own. */
  setOnline(): void
  dispose(): void
}>

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_FRAME_TIMEOUT_MS = 15_000
const DEFAULT_SAVE_TIMEOUT_MS = 5_000

function clampTimeout(value: number | undefined, fallback: number): number {
  const wanted = value ?? fallback
  return Math.min(Math.max(Number.isFinite(wanted) ? wanted : fallback, 1_000), 60_000)
}

/** Whether a message names this bridge's channel and the current attempt's nonce, read without running getters. */
function carriesCurrentChannel(data: unknown, bridgeId: string): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const field = (name: string) => Object.getOwnPropertyDescriptor(data, name)?.value
  return field('channel') === SIM_BRIDGE_CHANNEL && field('bridgeId') === bridgeId
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const id = setTimeout(run, ms)
  return () => clearTimeout(id)
}

function configuredAllowlist(options: HostedSimControllerOptions): OriginAllowlist | null {
  if (options.frameOrigin == null) return null
  try {
    return createOriginAllowlist([options.frameOrigin], {
      allowLoopbackHttp: options.allowLoopbackHttp === true,
    })
  } catch {
    return null
  }
}

export function createHostedSimController(
  options: HostedSimControllerOptions
): HostedSimController {
  const origins = configuredAllowlist(options)
  const now = options.now ?? (() => Date.now())
  const mint = options.mintBridgeId ?? (() => createBridgeId())
  const schedule = options.schedule ?? defaultSchedule
  const requestTimeoutMs = clampTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
  const frameTimeoutMs = clampTimeout(options.frameTimeoutMs, DEFAULT_FRAME_TIMEOUT_MS)
  const saveTimeoutMs = clampTimeout(options.saveTimeoutMs, DEFAULT_SAVE_TIMEOUT_MS)

  let state: SimLaunchState = SIM_IDLE
  let bridgeId = ''
  let frame: HostedSimFrame | null = null
  let cancelTimer: (() => void) | null = null
  let abortRequest: AbortController | null = null
  let disposed = false
  // The frame asked to move to another surface: this attempt is over and hears nothing more.
  let navigated = false
  // The one character save in flight for this attempt, and the clock that bounds it.
  let pendingSave: { requestId: string; abort: AbortController } | null = null
  let cancelSave: (() => void) | null = null
  // The callback still running for this attempt, which outlives a timed-out answer.
  let runningSave: object | null = null
  let current: HostedSimSnapshot = build()

  function build(): HostedSimSnapshot {
    const phase = state.phase
    const live = phase === 'awaiting_frame' || phase === 'launching' || phase === 'running'
    return {
      state,
      notice: describeSimAvailability(state),
      frame: live ? frame : null,
      starting: phase === 'requesting' || phase === 'awaiting_frame' || phase === 'launching',
    }
  }

  // `apply` reassigns `state`, which narrowing cannot see across the call.
  function phaseNow(): SimLaunchState['phase'] {
    return state.phase
  }

  function online(): boolean {
    try {
      return options.isOnline?.() !== false
    } catch {
      return true
    }
  }

  function clearTimer() {
    cancelTimer?.()
    cancelTimer = null
  }

  function armTimer(ms: number, run: () => void) {
    clearTimer()
    cancelTimer = schedule(run, ms)
  }

  function emit() {
    const phase = state.phase
    // Only the three loading phases are on a clock; anything else has nothing left to wait for.
    if (phase !== 'requesting' && phase !== 'awaiting_frame' && phase !== 'launching') clearTimer()
    if (phase !== 'requesting') {
      abortRequest?.abort()
      abortRequest = null
    }
    if (phase === 'idle' || phase === 'unavailable' || phase === 'offline') frame = null
    // A save only lives while the frame can hear the answer.
    if (phase !== 'launching' && phase !== 'running') clearSave()
    current = build()
    options.onChange(current)
  }

  function clearSave(abort = true) {
    cancelSave?.()
    cancelSave = null
    // A save that is given up on (timeout, disposal, a new attempt) can no longer commit.
    if (abort) pendingSave?.abort.abort()
    pendingSave = null
  }

  function apply(event: SimLaunchEvent) {
    if (disposed && event.type !== 'dispose') return
    const step = reduceSimLaunch(state, event)
    state = step.state
    // The goodbye goes out while the frame is still on screen; once the snapshot drops it, the
    // view removes the element and there is no window left to post to.
    if (step.effect?.type === 'dispose_frame') runEffect(step.effect)
    emit()
    if (step.effect && step.effect.type !== 'dispose_frame') runEffect(step.effect)
  }

  function runEffect(effect: SimLaunchEffect) {
    switch (effect.type) {
      case 'request_grant':
        return requestGrant(effect.attempt)
      case 'post_launch':
        return postLaunch(effect)
      case 'dispose_frame':
        return disposeFrame()
    }
  }

  function requestGrant(attempt: number) {
    bridgeId = mint()
    frame = null
    navigated = false
    clearSave()
    runningSave = null
    if (!origins) {
      apply({
        type: 'grant',
        attempt,
        grant: { status: 'unavailable', reason: 'not_configured' },
      })
      return
    }
    const request = parseSimLaunchRequest({
      schemaVersion: SIM_LAUNCH_SCHEMA_VERSION,
      workspaceId: options.workspaceId,
      surface: options.surface,
      platform: options.platform,
      bridgeId,
    })
    if (!request) {
      apply({ type: 'grant', attempt, grant: null })
      return
    }
    const controller = new AbortController()
    abortRequest = controller
    const settle = (reply: unknown) => {
      if (state.attempt !== attempt || phaseNow() !== 'requesting') return
      const grant = parseSimLaunchGrant(reply, { origins, now: now(), surface: options.surface })
      if (grant?.status === 'granted') frame = { origin: grant.frameOrigin, bridgeId }
      apply({ type: 'grant', attempt, grant })
      if (state.attempt === attempt && phaseNow() === 'awaiting_frame')
        armTimer(frameTimeoutMs, () => apply({ type: 'timeout', attempt }))
    }
    armTimer(requestTimeoutMs, () => {
      controller.abort()
      settle(null)
    })
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(options.requestGrant(request, controller.signal))
    } catch {
      pending = Promise.resolve(null)
    }
    void pending.then(settle, () => settle(null))
  }

  function postLaunch(effect: Extract<SimLaunchEffect, { type: 'post_launch' }>) {
    const { attempt, grant } = effect
    const target = options.frameWindow()
    const wanted = options.character
    const character = typeof wanted === 'function' ? wanted() : wanted
    try {
      if (!origins || !target) throw new Error('no frame to launch')
      postToFrame(target, grant.frameOrigin, origins, bridgeId, {
        type: 'host.launch',
        payload: {
          code: grant.code,
          expiresAt: grant.expiresAt,
          surface: grant.surface,
          ...(character ? { character } : {}),
        },
      })
    } catch {
      apply({
        type: 'frame',
        attempt,
        message: { type: 'frame.error', payload: { code: 'launch_rejected' } },
        now: now(),
      })
      return
    }
    // The frame now has its own window to report running in.
    armTimer(frameTimeoutMs, () => apply({ type: 'timeout', attempt }))
  }

  function disposeFrame() {
    clearTimer()
    clearSave()
    abortRequest?.abort()
    abortRequest = null
    const target = options.frameWindow()
    if (!origins || !frame || !target) return
    try {
      postToFrame(target, frame.origin, origins, bridgeId, { type: 'host.dispose', payload: {} })
    } catch {
      // The frame is going away either way.
    }
  }

  function answerSave(
    attempt: number,
    requestId: string,
    answer: { saved: true } | { saved: false; reason: SimSaveFailure }
  ) {
    const target = options.frameWindow()
    if (disposed || navigated || !origins || !frame || !target) return
    if (state.attempt !== attempt || (phaseNow() !== 'launching' && phaseNow() !== 'running'))
      return
    try {
      postToFrame(target, frame.origin, origins, bridgeId, {
        type: 'host.character.save.result',
        payload: { requestId, ...answer },
      })
    } catch {
      // The frame is gone; its own timeout fails the save.
    }
  }

  function handleNavigate(request: HostedSimNavigateRequest) {
    // Only a different designer than the one on screen; a frame cannot re-launch itself.
    if (!options.onNavigate || request.target === options.surface || navigated) return
    navigated = true
    disposeFrame()
    apply({
      type: 'frame',
      attempt: state.attempt,
      message: { type: 'frame.close', payload: {} },
      now: now(),
    })
    try {
      options.onNavigate(request)
    } catch {
      // The app's router failing leaves this attempt closed; the view offers the way back.
    }
  }

  function handleSave(character: string, requestId: string) {
    const attempt = state.attempt
    if (pendingSave || runningSave || !options.onCharacterSave) {
      answerSave(attempt, requestId, { saved: false, reason: 'refused' })
      return
    }
    const mine = { requestId, abort: new AbortController() }
    const run = {}
    pendingSave = mine
    runningSave = run
    const settle = (
      answer: { saved: true } | { saved: false; reason: SimSaveFailure },
      abort: boolean
    ) => {
      // A late answer for a request that timed out, or for an attempt that has ended, is dropped.
      if (pendingSave !== mine) return
      clearSave(abort)
      answerSave(attempt, requestId, answer)
    }
    const finish = () => {
      if (runningSave === run) runningSave = null
    }
    cancelSave = schedule(() => settle({ saved: false, reason: 'timeout' }, true), saveTimeoutMs)
    let saving: Promise<boolean>
    try {
      saving = Promise.resolve(
        options.onCharacterSave(character, {
          requestId,
          signal: mine.abort.signal,
          workspaceId: options.workspaceId,
          surface: options.surface,
          bridgeId,
          attempt,
        })
      )
    } catch {
      saving = Promise.reject(new Error('save failed'))
    }
    void saving.then(
      (saved) => {
        finish()
        settle(saved === true ? { saved: true } : { saved: false, reason: 'refused' }, false)
      },
      () => {
        finish()
        settle({ saved: false, reason: 'failed' }, false)
      }
    )
  }

  function handleRequest(message: SimFrameRequestMessage) {
    const phase = phaseNow()
    // Requests are for a frame that was launched and has not been told to leave.
    if (navigated || (phase !== 'launching' && phase !== 'running')) return
    if (message.type === 'frame.navigate') handleNavigate(message.payload)
    else handleSave(message.payload.character, message.payload.requestId)
  }

  return {
    snapshot: () => current,
    start: () => apply({ type: 'start', online: online() }),
    setOffline: () => apply({ type: 'offline' }),
    setOnline() {
      if (phaseNow() === 'offline') apply({ type: 'start', online: online() })
    },
    dispose() {
      if (disposed) return
      apply({ type: 'dispose' })
      disposed = true
      clearTimer()
    },
    handleMessage(event) {
      const phase = state.phase
      if (disposed || !origins || !frame) return
      if (phase !== 'awaiting_frame' && phase !== 'launching' && phase !== 'running') return
      const parsed = parseFrameMessage(event, {
        origins,
        frameWindow: options.frameWindow(),
        bridgeId,
      })
      let message: SimFrameStatusMessage
      if (parsed.ok) {
        if (
          parsed.message.type === 'frame.navigate' ||
          parsed.message.type === 'frame.character.save'
        ) {
          handleRequest(parsed.message)
          return
        }
        message = parsed.message
      }
      // Origin and window matched the frame, but the envelope checks the version before the
      // channel nonce, so this may be a stale or foreign message. It counts as the current frame
      // speaking a protocol version this host does not understand only when it also carries the
      // current attempt's channel and bridge id; otherwise it is noise like any other mismatch.
      else if (
        parsed.reason === 'version_unsupported' &&
        carriesCurrentChannel(event.data, bridgeId)
      )
        message = { type: 'frame.error', payload: { code: 'bridge_incompatible' } }
      // Anything else is noise, or an attacker; it must not be able to fail a healthy attempt.
      else return
      apply({ type: 'frame', attempt: state.attempt, message, now: now() })
    },
  }
}
