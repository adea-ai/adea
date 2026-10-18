// #1393: the existing M10 session capability admits every queue action. No UI
// callback, PTY readiness guess, or enqueue-time authority drives later sends.
import { createHash } from 'node:crypto'
import type { RuntimeSession, Scope } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import type { AcpLane } from './acp-lane'
import type { SessionEventLog } from './events'
import type { RunHistoryStore } from './runs'
import { RUN_ACTIVE_STATES } from './status'
import { createFollowUpQueue } from './follow-ups'

function queueSourceEventId(payload: {
  runtimeSessionId: string
  generation: number
  version: number
}): string {
  return `host:queue:${createHash('sha256')
    .update(JSON.stringify([payload.runtimeSessionId, payload.generation, payload.version]))
    .digest('hex')}`
}

export function registerFollowUpQueue(input: {
  authority: ChannelAuthority
  scope: Scope
  dataDir: string
  resolveSession: (id: string) => RuntimeSession | undefined
  runs: RunHistoryStore
  events: SessionEventLog
  lane: AcpLane
  structuredDelivery: boolean
}) {
  const queue = createFollowUpQueue({
    dataDir: input.dataDir,
    scope: input.scope,
    resolve: (id) => {
      const session = input.resolveSession(id)
      if (!session)
        throw { code: 'not_found', retryable: false, message: 'runtime session not found' }
      if (
        session.scope.accountId !== input.scope.accountId ||
        session.scope.workspaceId !== input.scope.workspaceId ||
        session.scope.runtimeNodeId !== input.scope.runtimeNodeId
      )
        throw {
          code: 'channel_unauthorized',
          retryable: false,
          message: 'follow-up session belongs to another scope',
        }
      const candidate = session.activeHarnessRunId
        ? input.runs.get(session.activeHarnessRunId)
        : undefined
      // Run and session generations advance independently. The canonical
      // active-run pointer binds them; the request fences the session below.
      const run =
        candidate &&
        candidate.runtimeSessionId === session.id &&
        candidate.scope.accountId === session.scope.accountId &&
        candidate.scope.workspaceId === session.scope.workspaceId &&
        candidate.scope.runtimeNodeId === session.scope.runtimeNodeId &&
        RUN_ACTIVE_STATES.includes(candidate.state)
          ? candidate
          : undefined
      const connection = input.lane.readyFor(id)
      return {
        generation: session.generation,
        archived: session.archived,
        ...(run ? { runId: run.id, runVersion: run.version, state: run.state } : {}),
        deliverySupported:
          input.structuredDelivery &&
          connection !== undefined &&
          run !== undefined &&
          connection.harnessInstallationId === run.installationId,
        ...(connection ? { deliveryBinding: `${connection.id}:${connection.generation}` } : {}),
      }
    },
    isPublished: (payload) =>
      input.events
        .events()
        .some(
          (event) =>
            event.runtimeSessionId === payload.runtimeSessionId &&
            event.generation === payload.generation &&
            event.source === 'host' &&
            event.kind === 'queue.updated' &&
            event.confidence === 'authoritative' &&
            event.classification === 'workspace_metadata' &&
            event.sourceEventId === queueSourceEventId(payload) &&
            JSON.stringify(event.payload) === JSON.stringify(payload)
        ),
    publish: (payload) => {
      input.events.append({
        runtimeSessionId: payload.runtimeSessionId,
        generation: payload.generation,
        kind: 'queue.updated',
        source: 'host',
        confidence: 'authoritative',
        classification: 'workspace_metadata',
        payload,
        sourceEventId: queueSourceEventId(payload),
      })
    },
    deliver: async ({ runtimeSessionId, generation, runId, text, signal, deliveryBinding }) => {
      if (signal.aborted) return { ok: false }
      const lane = input.lane.readyFor(runtimeSessionId)
      const run = input.runs.get(runId)
      const session = input.resolveSession(runtimeSessionId)
      if (
        !lane ||
        !input.structuredDelivery ||
        !run ||
        run.runtimeSessionId !== runtimeSessionId ||
        run.state !== 'awaiting_input' ||
        session?.activeHarnessRunId !== runId ||
        session.generation !== generation ||
        lane.harnessInstallationId !== run.installationId ||
        deliveryBinding !== `${lane.id}:${lane.generation}`
      )
        return { ok: false }
      const result = await input.lane.deliverPrompt({
        acpConnectionId: lane.id,
        expectedGeneration: lane.generation,
        runtimeSessionId,
        harnessRunId: runId,
        prompt: text,
        signal,
      })
      return { ok: result.ok && result.bytes === new TextEncoder().encode(text).byteLength }
    },
  })
  input.authority.registerCommandProvider('dev.session.followUps', (command, identity) => {
    if (
      command.scope.accountId !== input.scope.accountId ||
      command.scope.workspaceId !== input.scope.workspaceId ||
      command.scope.runtimeNodeId !== input.scope.runtimeNodeId
    )
      throw {
        code: 'channel_unauthorized',
        retryable: false,
        message: 'follow-up scope is not authorized',
      }
    // decodeDevCommand at the gate binds body session/generation to the
    // runtime_session resource; the queue repeats live generation after awaits.
    return queue.execute(command.body as Parameters<typeof queue.execute>[0], {
      idempotencyKey: command.idempotencyKey,
      authorize: () => input.authority.reauthorizeCommand(command, identity),
    })
  })
  return queue
}
