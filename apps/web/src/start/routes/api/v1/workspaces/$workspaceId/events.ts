import { createFileRoute } from '@tanstack/react-router'
import {
  listWorkspaceEventsAfter,
  markEventDispatchesNotified,
  workspaceEventWindow,
  WORKSPACE_EVENT_PAGE_LIMIT,
} from '@adea-ai/db'

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
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'
import {
  decideReplay,
  drainingFrame,
  eventFrame,
  heartbeatFrame,
  resyncFrame,
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
 * cursor. Authorization happens before the first byte, and membership is
 * revalidated while the stream is open so a revoked subscriber stops receiving.
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

async function get(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected

  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)

  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.read',
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
  let released = false
  const release = () => {
    if (released) return
    released = true
    connections.release(workspaceId)
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: string) => controller.enqueue(encoder.encode(frame))
      const close = () => release()

      request.signal.addEventListener('abort', () => {
        release()
        try {
          controller.close()
        } catch {
          // Already closed by the client.
        }
      })

      try {
        send(`retry: ${STREAM_RETRY_MS}\n\n`)

        const window = await workspaceEventWindow(database, workspaceId)
        const decision = cursorRejection
          ? ({ mode: 'resync', reason: cursorRejection } as const)
          : decideReplay(requestedSequence, window)

        let lastSequence: number
        if (decision.mode === 'resync') {
          // Tell the client where to resume from, then continue live: replaying
          // an unprovable range would hand it a silent gap.
          const cursor = await encodeWorkspaceEventCursor({ sequence: window.latest, workspaceId })
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
            for (const event of page) {
              const cursor = await encodeWorkspaceEventCursor({
                sequence: event.workspaceSequence,
                workspaceId,
              })
              send(eventFrame(event, cursor ?? ''))
              lastSequence = event.workspaceSequence
            }
            await markEventDispatchesNotified(database, workspaceId, lastSequence)
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

        const startedAt = Date.now()
        let lastHeartbeat = Date.now()
        let lastReauthorize = Date.now()

        while (!request.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS))

          // Bounded catch-up reads are what keep delivery correct when a wake-up
          // is lost or delayed; the log is the source of truth.
          const events = await listWorkspaceEventsAfter(
            database,
            workspaceId,
            lastSequence,
            WORKSPACE_EVENT_PAGE_LIMIT
          )
          for (const event of events) {
            const cursor = await encodeWorkspaceEventCursor({
              sequence: event.workspaceSequence,
              workspaceId,
            })
            send(eventFrame(event, cursor ?? ''))
            lastSequence = event.workspaceSequence
          }
          if (events.length > 0) {
            await markEventDispatchesNotified(database, workspaceId, lastSequence)
          }

          const now = Date.now()
          if (now - lastHeartbeat >= STREAM_HEARTBEAT_MS) {
            lastHeartbeat = now
            send(heartbeatFrame())
          }

          // A revoked membership must stop delivery promptly, not at the next
          // reconnect: the subscriber is re-authorized while the stream is open.
          if (now - lastReauthorize >= STREAM_REAUTHORIZE_MS) {
            lastReauthorize = now
            const recheck = await authorizeWorkspace(
              resolution.principal,
              'workspace.read',
              workspaceId
            )
            if (!recheck.allowed) {
              send(drainingFrame())
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
        close()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      release()
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
        return get(request, { params: { workspaceId: params.workspaceId } })
      },
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
