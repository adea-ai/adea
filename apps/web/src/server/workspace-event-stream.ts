/**
 * No `server-only` marker: this module is imported by Bun-run unit tests, where
 * that package's default entry throws. The client-boundary guard keeps it out of
 * browser bundles instead.
 */
import type { WorkspaceEventView } from '@adea-ai/db'

/**
 * Wire format and delivery decisions for the authenticated workspace event
 * stream. Kept apart from the route so the parts that must be deterministic —
 * what goes on the wire, when to replay, when to demand a resync, how many
 * streams one workspace may hold — are unit-testable without a server.
 */

/** Comment frame the server emits on an idle connection. */
export function heartbeatFrame(): string {
  return ': heartbeat\n\n'
}

/** One durable event. `id` is the opaque cursor, never the raw sequence. */
export function eventFrame(event: WorkspaceEventView, cursor: string): string {
  const payload = {
    aggregateId: event.aggregateId,
    aggregateType: event.aggregateType,
    actor: event.actor,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
    schemaVersion: event.schemaVersion,
    workspaceSequence: event.workspaceSequence,
  }
  return [
    `id: ${cursor}`,
    'event: workspace.event',
    `data: ${JSON.stringify(payload)}`,
    '',
    '',
  ].join('\n')
}

export type ResyncReason =
  | 'cursor-expired'
  | 'cursor-foreign-workspace'
  | 'cursor-malformed'
  | 'cursor-unavailable'
  | 'cursor-ahead-of-head'
  | 'cursor-behind-retained-window'

export function resyncFrame(reason: ResyncReason, cursor: string): string {
  return [
    `id: ${cursor}`,
    'event: resync_required',
    `data: ${JSON.stringify({ reason })}`,
    '',
    '',
  ].join('\n')
}

/**
 * Why an open stream is ending. A revoked subscriber is told which authorization
 * changed, so a client can distinguish "reconnect" from "stop retrying".
 */
export type StreamEndReason = 'draining' | 'membership-revoked' | 'session-revoked'

export function drainingFrame(reason: StreamEndReason = 'draining'): string {
  return ['event: stream_unavailable', `data: ${JSON.stringify({ reason })}`, '', ''].join('\n')
}

/**
 * Whether an open stream may keep delivering.
 *
 * Re-resolving the subscriber — not just re-authorizing — is what makes a
 * revoked session or device end the stream at the next check: a membership
 * lookup keyed on the principal captured at connect time would otherwise keep
 * serving a credential that no longer exists.
 */
export type StreamRevalidation =
  | Readonly<{ state: 'allowed' }>
  | Readonly<{ state: 'terminate'; reason: Exclude<StreamEndReason, 'draining'> }>

export function revalidationOutcome(
  resolution: Readonly<{ principalId: string }> | null,
  expectedPrincipalId: string,
  authorization: Readonly<{ allowed: boolean }>
): StreamRevalidation {
  if (!resolution || resolution.principalId !== expectedPrincipalId) {
    return { state: 'terminate', reason: 'session-revoked' }
  }
  if (!authorization.allowed) return { state: 'terminate', reason: 'membership-revoked' }
  return { state: 'allowed' }
}

/** Retry guidance in milliseconds: the client starts here and backs off itself. */
export const STREAM_RETRY_MS = 1_000
export const STREAM_HEARTBEAT_MS = 15_000
export const STREAM_POLL_MS = 1_000
/** How often the stream revalidates that the subscriber is still a member. */
export const STREAM_REAUTHORIZE_MS = 30_000
/** Concurrent streams one workspace may hold, per server instance. */
export const STREAM_CONNECTION_LIMIT = 8

export type ReplayDecision =
  | Readonly<{ mode: 'live-from-head'; from: number }>
  | Readonly<{ mode: 'replay'; from: number }>
  | Readonly<{ mode: 'resync'; reason: ResyncReason }>

/**
 * Decide where a subscriber starts.
 *
 * - no cursor: the client is opening fresh, so it gets current state (its own
 *   refetch) plus live events from the head, not the whole history;
 * - a cursor inside the retained window: replay everything after it, in order;
 * - a cursor outside it: replay cannot be proven continuous, so the client is
 *   told to resync instead of being handed a silent gap.
 */
export function decideReplay(
  requestedSequence: number | null,
  window: Readonly<{ earliest: number | null; latest: number }>
): ReplayDecision {
  if (requestedSequence === null) return { mode: 'live-from-head', from: window.latest }
  if (requestedSequence > window.latest) {
    return { mode: 'resync', reason: 'cursor-ahead-of-head' }
  }
  if (window.earliest !== null && requestedSequence < window.earliest - 1) {
    return { mode: 'resync', reason: 'cursor-behind-retained-window' }
  }
  return { mode: 'replay', from: requestedSequence }
}

/**
 * Per-workspace stream counter. Plainly instance-local: a Worker isolate cannot
 * see streams held by another isolate, so this bounds runaway reconnects from
 * one client rather than enforcing a global quota. A global limit would need
 * shared state (a Durable Object) rather than pretending this is one.
 */
export class StreamConnections {
  private readonly byWorkspace = new Map<string, number>()

  acquire(workspaceId: string): boolean {
    const open = this.byWorkspace.get(workspaceId) ?? 0
    if (open >= STREAM_CONNECTION_LIMIT) return false
    this.byWorkspace.set(workspaceId, open + 1)
    return true
  }

  release(workspaceId: string): void {
    const open = (this.byWorkspace.get(workspaceId) ?? 1) - 1
    if (open <= 0) this.byWorkspace.delete(workspaceId)
    else this.byWorkspace.set(workspaceId, open)
  }

  open(workspaceId: string): number {
    return this.byWorkspace.get(workspaceId) ?? 0
  }
}
