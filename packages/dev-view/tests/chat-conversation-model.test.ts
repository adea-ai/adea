import { describe, expect, test } from 'bun:test'

import {
  encodeCbor,
  type DevReply,
  type RuntimeEvent,
  type RuntimeSession,
  type Scope,
} from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService, DevStreamTransportSocket } from '../src/platform'
import {
  createChatConversationModel,
  projectChatConversations,
  type ChatUserInput,
} from '../src/chat/model'
import {
  acceptRuntimeEvent,
  acceptRuntimeStreamFrame,
  createTranscriptAccumulator,
  type TranscriptAccumulator,
} from '../src/chat/model/transcript'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    scope: SCOPE,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    lifecycle: 'active',
    archived: false,
    projection: 'structured',
    generation: 1,
    version: 1,
    ...overrides,
  }
}

function event(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: session().id,
    generation: 1,
    seq: '1',
    occurredAt: '2026-09-22T10:00:00.000Z',
    receivedAt: '2026-09-22T10:00:00.000Z',
    source: 'host',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'session.created',
    payload: {},
    ...overrides,
  }
}

function ok<T>(operation: DevReply['operation'], value: T, requestId = 'request-1'): DevReply {
  return {
    schemaVersion: 1,
    operation,
    requestId,
    ok: true,
    value,
    observedAt: '2026-09-22T10:00:00.000Z',
  } as DevReply
}

function hierarchyReply(operation: DevReply['operation']): DevReply | undefined {
  if (operation === 'dev.project.list')
    return ok(operation, {
      items: [
        {
          id: 'project-1',
          scope: SCOPE,
          name: 'Canonical project',
          groupIds: [],
          repoIds: ['repo-1'],
          lifecycle: 'ready',
          version: 1,
        },
      ],
      observedAt: '2026-09-22T10:00:00Z',
    })
  if (operation === 'dev.group.list')
    return ok(operation, { items: [], observedAt: '2026-09-22T10:00:00Z' })
  return undefined
}

describe('projectChatConversations', () => {
  test('projects groups and sessions with no chat-owned identity and canonical title', () => {
    const first = session({ displayName: 'Runtime label' })
    const second = session({
      id: '00000000-0000-4000-8000-000000000011',
      lifecycle: 'completed',
      projectId: 'project-2',
    })
    const projected = projectChatConversations({
      scope: SCOPE,
      groups: [
        {
          id: 'group-1',
          scope: SCOPE,
          name: 'Work',
          projectIds: ['project-1'],
          sortKey: 'a',
          version: 1,
        },
      ],
      projects: [
        {
          id: 'project-1',
          scope: SCOPE,
          name: 'Adea',
          groupIds: ['group-1'],
          repoIds: ['repo-1'],
          lifecycle: 'ready',
          version: 1,
        },
        {
          id: 'project-2',
          scope: SCOPE,
          name: 'Other',
          groupIds: [],
          repoIds: ['repo-1'],
          lifecycle: 'ready',
          version: 1,
        },
      ],
      sessions: [first, second],
      events: new Map([
        [
          first.id,
          [
            event({
              runtimeSessionId: first.id,
              kind: 'turn.user_input',
              payload: { text: '  Fix the login flow  ' },
            }),
          ],
        ],
      ]),
    })

    expect(projected.conversations).toHaveLength(2)
    expect(projected.conversations[0]).toMatchObject({
      runtimeSessionId: first.id,
      title: 'Fix the login flow',
      status: 'active',
      groupIds: ['group-1'],
      retention: { complete: false },
    })
    expect(projected.conversations[1]).toMatchObject({
      runtimeSessionId: second.id,
      title: 'New conversation',
      status: 'completed',
    })
    expect('conversationId' in projected.conversations[0]!).toBe(false)
    expect(
      projectChatConversations({
        scope: SCOPE,
        groups: [],
        projects: [],
        sessions: [first],
      }).conversations
    ).toHaveLength(0)
  })
})

describe('ChatConversationModel', () => {
  test('remember refuses a session without a canonical project record', () => {
    const model = createChatConversationModel(
      fakeService(async () => {
        throw new Error('unexpected transport')
      }),
      SCOPE
    )
    expect(() => model.remember(session())).toThrow(
      'The canonical project registry has not resolved this session.'
    )
    expect(model.project().conversations).toHaveLength(0)
  })

  test('list projects canonical sessions and hierarchy and drops removed sessions', async () => {
    let listedSessions: RuntimeSession[] = [session()]
    const service = fakeService(async (command) => {
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: listedSessions, observedAt: '2026-09-22T10:00:00Z' })
      if (command.operation === 'dev.project.list')
        return ok(command.operation, {
          items: [
            {
              id: 'project-1',
              scope: SCOPE,
              name: 'Canonical project',
              groupIds: ['group-1'],
              repoIds: ['repo-1'],
              lifecycle: 'ready',
              version: 1,
            },
          ],
          observedAt: '2026-09-22T10:00:00Z',
        })
      if (command.operation === 'dev.group.list')
        return ok(command.operation, {
          items: [
            {
              id: 'group-1',
              scope: SCOPE,
              name: 'Canonical group',
              projectIds: ['project-1'],
              sortKey: 'a',
              version: 1,
            },
          ],
          observedAt: '2026-09-22T10:00:00Z',
        })
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    expect(await model.list()).toHaveLength(1)
    expect(model.project().projects[0]).toMatchObject({
      name: 'Canonical project',
      groupIds: ['group-1'],
    })
    expect(model.project().groups[0]).toMatchObject({ name: 'Canonical group' })

    listedSessions = []
    expect(await model.list()).toHaveLength(0)
    expect(model.project().conversations).toHaveLength(0)
  })

  test('create is staged and idempotent, with one session, run, and prompt', async () => {
    const calls: Array<{
      operation: string
      idempotencyKey?: string
      body: Record<string, unknown>
    }> = []
    const created = session({ lifecycle: 'ready' })
    const run = {
      id: 'run-1',
      runtimeSessionId: created.id,
      generation: 1,
      state: 'starting',
    }
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      calls.push({
        operation: command.operation,
        idempotencyKey: command.idempotencyKey,
        body: command.body,
      })
      if (command.operation === 'dev.session.create') return ok(command.operation, created)
      if (command.operation === 'dev.session.launchDefault') return ok(command.operation, run)
      if (command.operation === 'dev.session.get') return ok(command.operation, created)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)

    const first = await model.create({
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 1,
      initialPrompt: 'Fix the login flow',
      idempotencyKey: 'chat-create-1',
    })
    const retry = await model.create({
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 1,
      initialPrompt: 'Fix the login flow',
      idempotencyKey: 'chat-create-1',
    })

    expect(retry.runtimeSessionId).toBe(first.runtimeSessionId)
    expect(calls.map((call) => call.operation)).toEqual([
      'dev.session.create',
      'dev.session.launchDefault',
      'dev.session.get',
    ])
    expect(
      calls
        .filter((call) => call.operation !== 'dev.session.get')
        .every((call) => call.idempotencyKey === 'chat-create-1')
    ).toBe(true)
    expect(calls[1]?.body).toMatchObject({
      runtimeSessionId: created.id,
      initialPrompt: 'Fix the login flow',
    })
  })

  test('retries a rejected create with the same key after a transport loss', async () => {
    const created = session({ lifecycle: 'ready' })
    const calls: string[] = []
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      calls.push(command.operation)
      if (command.operation === 'dev.session.create') {
        expect(command.idempotencyKey).toBe('retry-key')
        if (calls.filter((operation) => operation === 'dev.session.create').length === 1)
          throw new Error('transport lost after host committed the session')
        return ok(command.operation, created)
      }
      if (command.operation === 'dev.session.launchDefault')
        return ok(command.operation, {
          id: 'run-1',
          runtimeSessionId: created.id,
          state: 'starting',
        })
      if (command.operation === 'dev.session.get') return ok(command.operation, created)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    const input = {
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 1,
      initialPrompt: 'Start here',
      idempotencyKey: 'retry-key',
    }

    await expect(model.create(input)).rejects.toThrow('transport lost')
    await expect(model.create({ ...input, initialPrompt: 'Different prompt' })).rejects.toThrow(
      'idempotency key'
    )
    expect((await model.create(input)).runtimeSessionId).toBe(created.id)
    expect(calls).toEqual([
      'dev.session.create',
      'dev.session.create',
      'dev.session.launchDefault',
      'dev.session.get',
    ])
  })

  test('resume, cancel, archive, and explicit input preserve the canonical session', async () => {
    const current = session({ activeHarnessRunId: 'run-1' })
    const calls: string[] = []
    const inputs: ChatUserInput[] = []
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      calls.push(command.operation)
      if (command.operation === 'dev.session.resumeHarness')
        return ok(command.operation, {
          id: 'run-2',
          runtimeSessionId: current.id,
          generation: 2,
          state: 'starting',
        })
      if (command.operation === 'dev.session.cancelHarness')
        return ok(command.operation, {
          id: 'run-2',
          runtimeSessionId: current.id,
          generation: 2,
          state: 'cancelled',
        })
      if (command.operation === 'dev.session.archive')
        return ok(command.operation, {
          id: 'archive-1',
          scope: SCOPE,
          runtimeSessionId: current.id,
          worktreeId: current.worktreeId,
          state: 'archived',
          archivedAt: '2026-09-22T10:00:00.000Z',
          archivedBy: 'owner',
          generation: 2,
        })
      if (command.operation === 'dev.session.list')
        return ok(command.operation, {
          items: [current],
          observedAt: '2026-09-22T10:00:00Z',
        })
      if (command.operation === 'dev.session.get')
        return ok(command.operation, {
          ...current,
          generation: 2,
          archived: command.body.runtimeSessionId === current.id,
        })
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE, {
      sendInput: async (input) => inputs.push(input),
    })
    await model.attach(current.id)
    calls.length = 0

    const resumed = await model.resume(current.id, 'run-1')
    expect(resumed.generation).toBe(2)
    await model.cancel(current.id, 'run-2')
    await model.archive(current.id, 'archive me')
    await expect(model.send(current.id, 'hello')).rejects.toMatchObject({ code: 'invalid_state' })
    expect(calls).toEqual([
      'dev.session.resumeHarness',
      'dev.session.get',
      'dev.session.cancelHarness',
      'dev.session.get',
      'dev.session.archive',
      'dev.session.get',
    ])
    expect(inputs).toEqual([])

    const live = session({
      archived: false,
      generation: 2,
      lifecycle: 'active',
      activeHarnessRunId: 'run-2',
    })
    model.remember(live)
    await model.send(live.id, 'hello')
    expect(inputs[0]).toMatchObject({
      runtimeSessionId: live.id,
      generation: 2,
      source: 'chat_user',
      text: 'hello',
    })
  })

  test('runtime event stream returns credit even when replay arrives during attach', async () => {
    const current = session()
    const firstEvent = event({ seq: '0' })
    const bytes = encodeCbor(firstEvent)
    const sent: Array<{ type: string; throughSequence?: string; availableCreditBytes?: number }> =
      []
    const service: DevRuntimeService = {
      ...fakeService(async (command) => {
        const hierarchy = hierarchyReply(command.operation)
        if (hierarchy) return hierarchy
        if (command.operation === 'dev.session.list')
          return ok(command.operation, {
            items: [current],
            observedAt: '2026-09-22T10:00:00Z',
          })
        if (command.operation === 'dev.session.events')
          return ok(command.operation, {
            schemaVersion: 1,
            grantId: 'grant-1',
            protocol: 'runtime-events-v1',
            channelId: 'channel-1',
            scope: SCOPE,
            resource: { kind: 'runtime_session', id: current.id, generation: 1 },
            direction: 'read',
            fromSequence: '0',
            expiresAt: '2026-09-22T10:01:00Z',
            maxFrameBytes: 1_024,
          })
        throw new Error(`unexpected ${command.operation}`)
      }),
      streams: () => ({
        connect: (_grant, handlers) => {
          handlers.onFrame({
            type: 'opened',
            protocol: 'runtime-events-v1',
            generation: 1,
            nextSequence: '0',
          })
          handlers.onFrame({ type: 'data', sequence: '0', bytes })
          return {
            open: true,
            send: (frame) => sent.push(frame),
            close: () => undefined,
          }
        },
      }),
    }
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(current.id)
    const transcript = await model.openTranscript(current.id)
    expect(transcript.state().events).toHaveLength(1)
    expect(sent).toEqual([
      { type: 'ack', throughSequence: '0', availableCreditBytes: bytes.byteLength },
    ])
  })
})

describe('runtime-events-v1 transcript projection', () => {
  test('dedupes canonical duplicate delivery and reports a sequence gap', () => {
    let state = createTranscriptAccumulator({ runtimeSessionId: session().id, generation: 1 })
    state = acceptRuntimeEvent(state, event())
    state = acceptRuntimeEvent(state, event())
    expect(state.events).toHaveLength(1)
    state = acceptRuntimeEvent(
      state,
      event({ seq: '3', eventId: 'event-3', sourceEventId: 'source-3' })
    )
    expect(state.availability).toMatchObject({ status: 'resync_required', reason: 'sequence_gap' })
    expect(state.events).toHaveLength(1)
  })

  test('decodes CBOR frames, keeps stale generation explicit, and surfaces retention bounds', () => {
    let state: TranscriptAccumulator = createTranscriptAccumulator({
      runtimeSessionId: session().id,
      generation: 1,
      fromSequence: '0',
    })
    state = acceptRuntimeStreamFrame(
      state,
      { type: 'opened', protocol: 'runtime-events-v1', generation: 1, nextSequence: '5' },
      'host'
    )
    state = acceptRuntimeStreamFrame(
      state,
      { type: 'data', sequence: '5', bytes: encodeCbor(event({ seq: '5' })) },
      'host'
    )
    expect(state.availability).toMatchObject({
      status: 'bounded',
      reason: 'retention',
      oldestSequence: '5',
    })
    state = acceptRuntimeStreamFrame(
      state,
      { type: 'close', code: 'stale_generation', reason: 'resumed' },
      'host'
    )
    expect(state.availability).toMatchObject({ status: 'stale_generation' })
  })
})

function fakeService(execute: DevRuntimeService['execute']): DevRuntimeService {
  return {
    state: () => ({ status: 'ready' }),
    capabilitySnapshot: async () => ({
      scope: SCOPE,
      granted: [],
      unavailable: [],
      channelGeneration: 1,
      observedAt: '',
    }),
    execute,
  }
}

void (null as unknown as DevStreamTransportSocket)
