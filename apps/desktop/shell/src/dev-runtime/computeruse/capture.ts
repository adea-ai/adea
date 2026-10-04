// Desktop frame publication for the computer-use lane (issue #624).
//
// The read direction of `desktop-frames-v1` publishes bounded screen frames
// through the same flow-control rules the browser lane proved (bounded FPS,
// dimensions, and queues; one in-flight plus the newest complete frame;
// stale-generation fencing) — the lane's screencast pacer is reused verbatim.
// What this lane adds is the permission fence: every publication tick
// re-derives authority from provider-owned state (lane generation, automation
// owner, live consent record, and the consent digest that binds the
// screen-recording grant), and a captured frame is classified before it may
// leave the host. When capture is not proven — the preflight probe denied,
// unanswered, or missing — the stream closes typed and NO frame is ever
// fabricated: a publisher without permission has nothing to send, and an
// empty stream or placeholder pixels would be a lie.
//
// Frames inherit the data classification of the surface they capture: the
// full desktop is `restricted_local` (keychain/password prompts can appear),
// the provenance record says `redacted: false` because no pixel-level
// redaction exists in this lane, and egress rides only the authenticated
// channel bound to the consented lane (spec: "Data classification and
// redaction"; threat model TM-016).
import type {
  DevStreamFrame,
  DevStreamGrant,
} from '../../../../../../packages/types/src/dev-runtime'
import type { ComputerUseCapabilityRow } from '../../../../../../packages/types/src/dev-runtime'
import type { StreamCloseCode } from '../channel/wire'
import {
  createLaneScreencast,
  SCREENCAST_BUDGET_DEFAULTS,
  type ScreencastBudget,
} from '../browser/screencast'
import { CAPTURE_MISSING_PIECE } from './capability'
import type { ComputerUseEngine, DesktopFrame } from './engine'
import type { ComputerUseLaneRegistry } from './lane-registry'
import type { ComputerUseConsentGate } from './consent-gate'

/**
 * The classification record a frame must carry BEFORE it leaves the host.
 * The classification is derived, never negotiated: a frame that cannot be
 * fenced and classified is never sent.
 */
export type DesktopFrameEgress = Readonly<{
  laneId: string
  runtimeSessionId: string
  generation: number
  sequence: string
  classification: 'restricted_local'
  redacted: false
  byteLength: number
  observedAt: string
}>

/** The subset of the channel gateway's stream session this publisher uses. */
export type DesktopFrameSession = {
  grant: DevStreamGrant
  onFrame?: (frame: DevStreamFrame) => void
  /** Provider cleanup when the stream ends for any reason. */
  onClose?: () => void
  send: (frame: DevStreamFrame) => void
  close: (code: StreamCloseCode, reason?: string) => void
}

export type DesktopFrameAuditEntry = Readonly<{
  laneId: string
  generation: number
  decision: 'published' | 'throttled' | 'refused' | 'stopped'
  code?: string
  detail?: string
  egress?: DesktopFrameEgress
}>

export type DesktopFrameStreamDeps = Readonly<{
  lanes: ComputerUseLaneRegistry
  gate: Pick<ComputerUseConsentGate, 'verifyObservation'>
  /**
   * Fresh capture capability row; the publisher probes at attach and again
   * whenever the consent gate's freshness window elapses (the consent digest
   * binds the screen-recording state, so a moved grant refuses egress).
   */
  captureRow: () => Promise<ComputerUseCapabilityRow | undefined>
  engine: () => ComputerUseEngine | undefined
  /** Overrides the screencast budget (tests shrink it). */
  budget?: Partial<ScreencastBudget>
  /** Publication tick interval; defaults to one frame at the budget FPS. */
  tickMs?: number
  /** Bounded, secret-free audit of publication decisions. */
  audit?: (entry: DesktopFrameAuditEntry) => void
}>

export type DesktopFrameStreamControl = Readonly<{
  /** The gateway stream handler for the read direction. */
  handleSession: (session: DesktopFrameSession) => void
  /**
   * Synchronously stops every attached stream of a lane (takeover, kill
   * switch, crash): the very next interaction after revocation cannot
   * publish, instead of waiting one tick.
   */
  stopForLane: (laneId: string, code: StreamCloseCode, reason: string) => void
}>

export function createDesktopFrameStream(deps: DesktopFrameStreamDeps): DesktopFrameStreamControl {
  const budget = { ...SCREENCAST_BUDGET_DEFAULTS, ...deps.budget }
  const tickMs = deps.tickMs ?? Math.max(1, Math.ceil(1000 / budget.maxFps))
  // Per-lane monotonic frame sequence, shared across reconnects within the
  // lane (mirrors the browser lane's lane-scoped counter; the wire layer
  // sequences the client's acks, the publisher owns the video sequence).
  const laneSequences = new Map<string, bigint>()
  /** laneId → live publisher stops, for synchronous revocation. */
  const attached = new Map<string, Set<(code: StreamCloseCode, reason: string) => void>>()

  const audit = (entry: DesktopFrameAuditEntry) => deps.audit?.(entry)

  function stopForLane(laneId: string, code: StreamCloseCode, reason: string): void {
    const stops = attached.get(laneId)
    if (!stops) return
    attached.delete(laneId)
    laneSequences.delete(laneId)
    // Snapshot before closing: each stop removes itself from the set.
    const pending = Array.from(stops)
    for (const stop of pending) stop(code, reason)
  }

  const handleSession = (session: DesktopFrameSession): void => {
    const grant = session.grant
    const laneId = grant.resource.id
    let lane
    try {
      lane = deps.lanes.get(laneId)
    } catch {
      session.close('revoked', 'computer-use lane is unknown')
      return
    }
    if (grant.resource.generation !== lane.generation) {
      session.close('stale_generation', 'computer-use lane generation changed')
      return
    }

    let closed = false
    let timer: ReturnType<typeof setInterval> | undefined
    let ticking = false
    // Delivery credit follows the browser lane: the grant's frame bound is
    // the initial credit, acks refresh it, and an unsendable frame is never
    // sent (the newest complete frame waits instead).
    let credit = grant.maxFrameBytes
    let pacer: ReturnType<typeof createLaneScreencast> | undefined

    function stop(code: StreamCloseCode, reason: string): void {
      if (closed) return
      closed = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      pacer?.close()
      const stops = attached.get(laneId)
      if (stops) {
        stops.delete(stop)
        if (stops.size === 0) {
          attached.delete(laneId)
          laneSequences.delete(laneId)
        }
      }
      audit({
        laneId,
        generation: grant.resource.generation,
        decision: 'stopped',
        code,
        detail: reason.slice(0, 160),
      })
      try {
        session.close(code, reason)
      } catch {
        // Already-closed socket.
      }
    }

    /**
     * One publication boundary: re-derive every fence from provider-owned
     * state, capture, classify, then publish through the pacer. Any refused
     * fence closes the stream typed — never a silent stall, never a
     * placeholder frame.
     */
    const tick = async (): Promise<void> => {
      if (closed || ticking || !pacer) return
      ticking = true
      try {
        let record
        try {
          record = deps.lanes.get(laneId)
        } catch {
          stop('revoked', 'computer-use lane is unknown')
          return
        }
        if (grant.resource.generation !== record.generation) {
          stop('stale_generation', 'computer-use lane generation changed')
          return
        }
        if (record.state === 'closed') {
          stop('revoked', 'computer-use lane is closed')
          return
        }
        if (record.state === 'crashed') {
          stop('incompatible', 'computer-use lane is crashed')
          return
        }
        try {
          deps.lanes.admit(record, {
            principal: 'agent',
            action: 'observe',
            generation: grant.resource.generation,
          })
        } catch (error) {
          stop(
            mapAdmissionRefusal(error),
            error instanceof Error ? error.message : 'lane refused observation'
          )
          return
        }
        if (!record.consent) {
          stop('revoked', 'observation requires a live consent record')
          return
        }
        try {
          // Self-throttled by the gate's freshness window; the digest it
          // verifies binds the screen-recording grant too, so a moved TCC
          // state stops frames at the next boundary after the window.
          // Observation never consumes the single-use consent record.
          await deps.gate.verifyObservation(record.consent.consentId)
        } catch (error) {
          stop(
            'revoked',
            error instanceof Error ? error.message : 'the consent behind this lane moved'
          )
          return
        }
        const engine = deps.engine()
        if (!engine) {
          stop('incompatible', 'no computer-use engine is attached for this lane')
          return
        }
        let frame: DesktopFrame
        try {
          frame = await engine.capture()
        } catch (error) {
          stop('incompatible', error instanceof Error ? error.message : 'the capture source failed')
          return
        }
        // Classification before egress: the frame is fenced, provenance is
        // derived, and only then does the pacer admit it.
        let sequence = laneSequences.get(laneId) ?? 0n
        sequence += 1n
        laneSequences.set(laneId, sequence)
        const egress: DesktopFrameEgress = {
          laneId,
          runtimeSessionId: record.runtimeSessionId,
          generation: grant.resource.generation,
          sequence: sequence.toString(10),
          classification: 'restricted_local',
          redacted: false,
          byteLength: frame.bytes.byteLength,
          observedAt: new Date().toISOString(),
        }
        const verdict = pacer.publish({
          sequence: egress.sequence,
          generation: egress.generation,
          viewportSequence: 0,
          width: frame.width,
          height: frame.height,
          keyframe: true,
          bytes: frame.bytes,
        })
        if (verdict === 'rejected') {
          audit({
            laneId,
            generation: egress.generation,
            decision: 'refused',
            code: 'frame_bounds',
            detail: `${frame.width}x${frame.height}, ${frame.bytes.byteLength}B`,
          })
          return
        }
        audit({
          laneId,
          generation: egress.generation,
          decision: verdict === 'published' ? 'published' : 'throttled',
          egress,
        })
      } finally {
        ticking = false
      }
    }

    /** Installs the pacer and starts the publication loop. */
    const beginPublishing = (): void => {
      if (closed) return
      pacer = createLaneScreencast({
        budget,
        onFrame: (frame) => {
          if (credit < frame.bytes.byteLength) return
          credit -= frame.bytes.byteLength
          try {
            session.send({
              type: 'video',
              sequence: frame.sequence,
              timestampMs: Date.now(),
              generation: frame.generation,
              viewportSequence: frame.viewportSequence,
              width: frame.width,
              height: frame.height,
              keyframe: frame.keyframe,
              bytes: frame.bytes,
            })
          } catch {
            stop('backpressure', 'the desktop-frames stream refused a frame')
          }
        },
      })
      session.onClose = () => stop('normal', 'stream detached')
      session.onFrame = (frame: DevStreamFrame) => {
        if (frame.type !== 'ack' || closed) return
        credit = frame.availableCreditBytes
        pacer?.ack(frame.throughSequence, credit > 0 ? 1 : 0)
      }
      // Registration order matters for synchronous revocation: the stop hook
      // must be live before the first tick can run.
      let stops = attached.get(laneId)
      if (!stops) {
        stops = new Set()
        attached.set(laneId, stops)
      }
      stops.add(stop)
      timer = setInterval(() => void tick(), tickMs)
      timer.unref?.()
      void tick()
    }

    // The attach-time capture gate: a FRESH preflight answer must prove the
    // Screen Recording grant before any publisher exists. This fence cannot
    // be delegated to the capture tool — `/usr/sbin/screencapture` exits 0
    // and produces wallpaper-only frames on an unpermitted host, so the
    // probe is the only honest answer about what the frames would contain.
    // Denied and unanswered both refuse typed; no frame is fabricated.
    void (async () => {
      const row = await deps.captureRow()
      if (closed) return
      if (!row || row.state !== 'available') {
        const refusal = captureRefusalClose(row)
        audit({
          laneId,
          generation: grant.resource.generation,
          decision: 'refused',
          code: refusal.code,
          detail: refusal.reason.slice(0, 160),
        })
        stop(refusal.code, refusal.reason)
        return
      }
      // The probe was async: re-derive the lane before publishing anything.
      try {
        const current = deps.lanes.get(laneId)
        if (grant.resource.generation !== current.generation) {
          stop('stale_generation', 'computer-use lane generation changed')
          return
        }
        if (!current.consent) {
          stop('revoked', 'observation requires a live consent record')
          return
        }
      } catch {
        stop('revoked', 'computer-use lane is unknown')
        return
      }
      beginPublishing()
    })().catch(() => {
      stop('incompatible', 'the capture gate did not answer')
    })
  }

  return { handleSession, stopForLane }
}

/** Maps a lane-registry admission refusal to a stream close code. */
function mapAdmissionRefusal(error: unknown): StreamCloseCode {
  const code = (error as { code?: string }).code
  if (code === 'stale_generation') return 'stale_generation'
  if (code === 'invalid_state') return 'incompatible'
  return 'revoked'
}

/** The typed close for an attach whose capture row does not prove available. */
export function captureRefusalClose(row: ComputerUseCapabilityRow | undefined): {
  code: StreamCloseCode
  reason: string
} {
  if (!row || row.state === 'unavailable') {
    return {
      code: 'incompatible',
      reason: row?.missingPiece ?? CAPTURE_MISSING_PIECE,
    }
  }
  if (row.state === 'not_determined') {
    return {
      code: 'revoked',
      reason:
        'screen capture is refused: the screen-recording consent prompt has not been answered; ' +
        'grant it in System Settings, then re-attach',
    }
  }
  return {
    code: 'revoked',
    reason:
      'screen capture is refused: the screen-recording permission is not granted; repair it in ' +
      'System Settings (Privacy & Security → Screen Recording)',
  }
}
