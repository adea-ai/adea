import { createFileRoute } from '@tanstack/solid-router'
import {
  classifyWorkspaceEventsForUser,
  listWorkspaceEventsAfter,
  type WorkspaceEventView,
  markEventDispatchesNotified,
  prepareWorkspaceEventsAfter,
  workspaceEventWindow,
  WORKSPACE_EVENT_PAGE_LIMIT,
} from '@adea-ai/db'

import { keepAliveUntil } from '../../../../../../server/background-task'
import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  withDesktopWorkspaceCors,
} from '../../../../../../server/desktop-workspace'
import {
  decodeWorkspaceEventCursor,
  encodeWorkspaceEventCursor,
} from '../../../../../../server/event-cursor'
import { openRequestScope, type RequestScope } from '../../../../../../server/request-scope'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'
import {
  decideReplay,
  deliveryFrame,
  drainingFrame,
  heartbeatFrame,
  resyncFrame,
  revalidationOutcome,
  StreamConnections,
  type ResyncReason,
  STREAM_HEARTBEAT_MS,
  STREAM_POLL_MS,
  STREAM_REAUTHORIZE_MS,
  STREAM_RETRY_MS,
} from '../../../../../../server/workspace-event-stream'

/**
 * Authenticated durable workspace event stream.
 *
 * The stream is a delivery channel, not a store: every frame it emits is an
 * already-committed WorkspaceEvent read from the log in `workspace_sequence`
 * order, and a client that misses frames recovers by reconnecting with its
 * cursor. Authorization happens before the first byte, and the subscriber is
 * re-resolved and re-authorized while the stream is open, so a revoked session
 * or a removed membership stops delivery promptly.
 */

/** Longest a single stream stays open before the client is asked to reconnect. */
const STREAM_LIFETIME_MS = 30 * 60 * 1_000

// Instance-local: see StreamConnections. Bounds one client's reconnects, not a
// global quota, because a Worker isolate cannot see another isolate's streams.
const connections = new StreamConnections()

function streamUnavailableResponse(
  request: Request,
  status: number,
  code: string,
  message: string
) {
  return withDesktopWorkspaceCors(Response.json({ code, message }, { status }), request)
}

async function get(
  request: Request,
  { params }: { params: { workspaceId: string } },
  requestScope: RequestScope
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected

  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)

  // The stream is its own surface: it authorizes with the catalog's
  // `workspace.events.read`, which every role that can read the workspace holds.
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.events.read',
    workspaceId
  )
  // Unauthorized and unknown workspaces answer identically, so a subscriber
  // cannot probe for another workspace's existence.
  if (!authorization.allowed) return workspaceUnavailableResponse(request)

  if (!connections.acquire(workspaceId)) {
    return streamUnavailableResponse(
      request,
      429,
      'connection_limit',
      'Too many concurrent streams for this workspace'
    )
  }

  const url = new URL(request.url)
  const presentedCursor = url.searchParams.get('cursor') ?? request.headers.get('last-event-id')
  const database = applicationDatabase()

  let requestedSequence: number | null = null
  let cursorRejection: ResyncReason | null = null
  if (presentedCursor) {
    const decoded = await decodeWorkspaceEventCursor(presentedCursor, workspaceId)
    if (decoded.ok) requestedSequence = decoded.cursor.sequence
    else cursorRejection = `cursor-${decoded.reason}` as ResyncReason
  }

  const encoder = new TextEncoder()
  // Two different things end at two different moments. DELIVERY ends when the
  // client goes away or cancels: the connection slot frees at once and the
  // producer is told to stop. The producer's RESOURCES (the request's database
  // client) end only when the producer has actually unwound, because a read or
  // reauthorization may still be in flight on that client. The request scope
  // would close the client as soon as this handler returns the Response, so a
  // hold keeps it open until the producer's `finally`.
  let cancelled = false
  const stopped = () => cancelled || request.signal.aborted
  let slotReleased = false
  const releaseSlot = () => {
    if (slotReleased) return
    slotReleased = true
    connections.release(workspaceId)
  }
  let wake: (() => void) | undefined
  const cancelDelivery = () => {
    cancelled = true
    releaseSlot()
    wake?.()
  }
  // The poll interval ends early on cancellation instead of holding the
  // producer (and its database client) open for up to a second.
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopped()) return resolve()
      const done = () => {
        clearTimeout(timer)
        wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      wake = done
    })
  const releaseProducer = requestScope.retain()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: string) => {
        if (!stopped()) controller.enqueue(encoder.encode(frame))
      }

      request.signal.addEventListener('abort', () => {
        cancelDelivery()
        try {
          controller.close()
        } catch {
          // Already closed by the client.
        }
      })

      // Every page — replay and live — is classified against the subscriber's
      // current project access before it is framed, so a members-only project
      // never reaches someone who cannot see it, and a resumed cursor is
      // filtered exactly like live delivery. `false` means the subscriber is no
      // longer a member: the stream ends as a revoked membership. `stopped`
      // means the subscriber went away mid-page: nothing more is read or sent.
      const sendPage = async (
        page: readonly WorkspaceEventView[]
      ): Promise<'sent' | 'revoked' | 'stopped'> => {
        const deliveries = await classifyWorkspaceEventsForUser(
          database,
          workspaceId,
          resolution.principal.userId,
          page
        )
        if (stopped()) return 'stopped'
        if (!deliveries) return 'revoked'
        for (const [index, delivery] of deliveries.entries()) {
          const event = page[index]!
          const cursor = await encodeWorkspaceEventCursor({
            sequence: event.workspaceSequence,
            workspaceId,
          })
          if (stopped()) return 'stopped'
          send(deliveryFrame(delivery, cursor ?? ''))
        }
        return 'sent'
      }

      try {
        send(`retry: ${STREAM_RETRY_MS}\n\n`)

        const window = await workspaceEventWindow(database, workspaceId)
        if (stopped()) return
        const decision = cursorRejection
          ? ({ mode: 'resync', reason: cursorRejection } as const)
          : decideReplay(requestedSequence, window)

        let lastSequence: number
        if (decision.mode === 'resync') {
          // Tell the client where to resume from, then continue live: replaying
          // an unprovable range would hand it a silent gap.
          const cursor = await encodeWorkspaceEventCursor({ sequence: window.latest, workspaceId })
          if (stopped()) return
          send(resyncFrame(decision.reason, cursor ?? ''))
          lastSequence = window.latest
        } else {
          lastSequence = decision.from
          let page = await listWorkspaceEventsAfter(
            database,
            workspaceId,
            lastSequence,
            WORKSPACE_EVENT_PAGE_LIMIT
          )
          while (page.length > 0) {
            if (stopped()) return
            const sent = await sendPage(page)
            if (sent === 'stopped') return
            if (sent === 'revoked') {
              send(drainingFrame('membership-revoked'))
              return
            }
            lastSequence = page.at(-1)!.workspaceSequence
            await markEventDispatchesNotified(database, workspaceId, lastSequence)
            if (stopped()) return
            page =
              page.length < WORKSPACE_EVENT_PAGE_LIMIT
                ? []
                : await listWorkspaceEventsAfter(
                    database,
                    workspaceId,
                    lastSequence,
                    WORKSPACE_EVENT_PAGE_LIMIT
                  )
          }
        }

        // The poll below repeats the same read every second for the life of the
        // stream, so its query is built once here and only the cursor changes.
        const pollEventsAfter = prepareWorkspaceEventsAfter(
          database,
          workspaceId,
          WORKSPACE_EVENT_PAGE_LIMIT
        )
        const startedAt = Date.now()
        let lastHeartbeat = Date.now()
        let lastReauthorize = Date.now()

        while (!stopped()) {
          await pause(STREAM_POLL_MS)
          if (stopped()) break

          // Bounded catch-up reads are what keep delivery correct when a wake-up
          // is lost or delayed; the log is the source of truth.
          const events = await pollEventsAfter(lastSequence)
          if (stopped()) break
          if (events.length > 0) {
            const sent = await sendPage(events)
            if (sent === 'stopped') break
            if (sent === 'revoked') {
              send(drainingFrame('membership-revoked'))
              break
            }
            lastSequence = events.at(-1)!.workspaceSequence
            await markEventDispatchesNotified(database, workspaceId, lastSequence)
            if (stopped()) break
          }

          const now = Date.now()
          if (now - lastHeartbeat >= STREAM_HEARTBEAT_MS) {
            lastHeartbeat = now
            send(heartbeatFrame())
          }

          // A revoked session or membership must stop delivery promptly, not at
          // the next reconnect. The subscriber is re-resolved and re-authorized
          // while the stream is open, so a deleted credential counts too.
          if (now - lastReauthorize >= STREAM_REAUTHORIZE_MS) {
            lastReauthorize = now
            const current = await resolveWorkspacePrincipal(request)
            // A subscriber that left while the principal resolved gets no
            // further database work on its behalf.
            if (stopped()) break
            const recheck = current
              ? await authorizeWorkspace(current.principal, 'workspace.events.read', workspaceId)
              : { allowed: false }
            if (stopped()) break
            const outcome = revalidationOutcome(
              current ? { principalId: current.principal.userId } : null,
              resolution.principal.userId,
              recheck
            )
            if (outcome.state === 'terminate') {
              send(drainingFrame(outcome.reason))
              break
            }
          }

          if (now - startedAt >= STREAM_LIFETIME_MS) {
            // Long-lived streams end deliberately so the client reconnects with
            // a fresh cursor instead of holding a stale authorization forever.
            send(drainingFrame())
            break
          }
        }
      } catch {
        // The client went away or the database read failed: end the stream and
        // let the client reconnect with its cursor.
      } finally {
        releaseSlot()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
        // Last: the producer has unwound, so nothing is still using the
        // request's database client and the scope may close it.
        releaseProducer()
      }
    },
    cancel() {
      cancelDelivery()
    },
  })

  return withDesktopWorkspaceCors(
    new Response(body, {
      headers: {
        'cache-control': 'no-store, no-transform',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      },
    }),
    request
  )
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/events')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        if (!params?.workspaceId) return workspaceInvalidRequestResponse(request)
        const workspaceId = params.workspaceId
        const requestScope = openRequestScope()
        return requestScope
          .run(() => get(request, { params: { workspaceId } }, requestScope))
          .finally(async () => {
            await requestScope.end()
            // A stream's client closes after the handler returned; the runtime
            // keeps the isolate alive for that teardown.
            keepAliveUntil(requestScope.completion)
          })
      },
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
