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
  transcriptWindow,
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

  test('attaches by walking legal session list pages without an id filter', async () => {
    const target = session({ id: '00000000-0000-4000-8000-000000000012' })
    const other = session({ id: '00000000-0000-4000-8000-000000000013' })
    const listBodies: Array<Record<string, unknown>> = []
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      if (command.operation === 'dev.session.list') {
        listBodies.push(command.body)
        return command.body.cursor === 'page-2'
          ? ok(command.operation, { items: [target], observedAt: '2026-09-22T10:00:00Z' })
          : ok(command.operation, {
              items: [other],
              nextCursor: 'page-2',
              observedAt: '2026-09-22T10:00:00Z',
            })
      }
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)

    await expect(model.attach(target.id)).resolves.toMatchObject({
      runtimeSessionId: target.id,
    })
    expect(listBodies).toEqual([{ limit: 500 }, { cursor: 'page-2', limit: 500 }])
    expect(listBodies.every((body) => !('runtimeSessionId' in body))).toBe(true)
  })

  test('rejects a partial agent profile before creating a durable session', async () => {
    const calls: string[] = []
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      calls.push(command.operation)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)

    await expect(
      model.create({
        projectId: 'project-1',
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        agentProfileId: 'profile-1',
      })
    ).rejects.toMatchObject({ code: 'invalid_state' })
    expect(calls).toEqual([])
  })

  test('ignores events belonging to another runtime session', async () => {
    const current = session()
    const other = session({ id: '00000000-0000-4000-8000-000000000014' })
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [current], observedAt: '2026-09-22T10:00:00Z' })
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(current.id)

    model.remember(current, [event({ runtimeSessionId: other.id })])
    expect(model.project().conversations[0]?.events).toEqual([])
  })

  test('bounds remembered session events to canonical retention', async () => {
    const current = session()
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [current], observedAt: '2026-09-22T10:00:00Z' })
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(current.id)
    const retained = Array.from({ length: 1_001 }, (_, index) =>
      event({
        eventId: `event-${index}`,
        sourceEventId: `source-${index}`,
        seq: String(index),
      })
    )

    model.remember(current, retained)
    const conversation = model.project().conversations[0]!
    expect(conversation.events).toHaveLength(1_000)
    expect(conversation.events[0]?.seq).toBe('1')
    expect(conversation.events.at(-1)?.seq).toBe('1000')
  })

  test('retains the current generation when sequence numbers restart', async () => {
    const current = session({ generation: 2 })
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [current], observedAt: '2026-09-22T10:00:00Z' })
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(current.id)
    const retained = [
      ...Array.from({ length: 1_000 }, (_, index) =>
        event({
          eventId: `generation-1-${index}`,
          sourceEventId: `generation-1-${index}`,
          generation: 1,
          seq: String(index),
        })
      ),
      ...Array.from({ length: 100 }, (_, index) =>
        event({
          eventId: `generation-2-${index}`,
          sourceEventId: `generation-2-${index}`,
          generation: 2,
          seq: String(index),
        })
      ),
    ]

    model.remember(current, retained)
    const conversation = model.project().conversations[0]!
    expect(conversation.events).toHaveLength(1_000)
    expect(conversation.events.filter((item) => item.generation === 2)).toHaveLength(100)
    expect(conversation.events.find((item) => item.generation === 2)?.seq).toBe('0')
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

  test('Dev↔Chat repeated switching preserves the canonical session, draft, sequence, and scrollback', async () => {
    const current = session({ displayName: 'Shared Dev session' })
    const scrollback = [
      event({
        runtimeSessionId: current.id,
        eventId: 'event-0',
        sourceEventId: 'source-0',
        seq: '0',
        kind: 'turn.user_input',
        payload: { text: 'Keep this draft while switching views' },
      }),
      event({
        runtimeSessionId: current.id,
        eventId: 'event-1',
        seq: '1',
        kind: 'turn.assistant_message',
        payload: { text: 'The same runtime session remains attached.' },
      }),
    ]
    const calls: string[] = []
    const service = fakeService(async (command) => {
      calls.push(command.operation)
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      if (command.operation === 'dev.session.list')
        return ok(command.operation, { items: [current], observedAt: '2026-09-22T10:00:00Z' })
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE)
    await model.list()
    model.remember(current, scrollback)
    model.setDraft(current.id, 'unfinished composer draft')

    const snapshot = () => {
      const conversation = model.project().conversations[0]
      if (!conversation) throw new Error('conversation disappeared during switch proof')
      return {
        runtimeSessionId: conversation.runtimeSessionId,
        generation: conversation.generation,
        eventSequence: conversation.events.map((item) => item.seq),
        eventIds: conversation.events.map((item) => item.eventId),
        draft: conversation.draft,
      }
    }
    const expected = snapshot()

    for (let cycle = 0; cycle < 3; cycle += 1) {
      model.switchTo(current.id)
      expect(snapshot()).toEqual(expected)
      await model.attach(current.id)
      expect(snapshot()).toEqual(expected)
    }

    expect(calls.filter((operation) => operation.startsWith('dev.session.'))).toEqual([
      'dev.session.list',
      'dev.session.list',
      'dev.session.list',
      'dev.session.list',
    ])
    expect(calls.some((operation) => operation.includes('launch'))).toBe(false)
    expect(calls.some((operation) => operation === 'dev.session.create')).toBe(false)
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

  test('expires create fingerprints after the seven-day replay window', async () => {
    const created = session({ lifecycle: 'ready' })
    let currentTime = Date.parse('2026-09-22T10:00:00.000Z')
    let createCalls = 0
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      if (command.operation === 'dev.session.create') {
        createCalls += 1
        return ok(command.operation, created)
      }
      if (command.operation === 'dev.session.launchDefault')
        return ok(command.operation, {
          id: `run-${createCalls}`,
          runtimeSessionId: created.id,
          state: 'starting',
        })
      if (command.operation === 'dev.session.get') return ok(command.operation, created)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE, {
      now: () => new Date(currentTime),
    })
    const input = {
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 1,
      initialPrompt: 'First prompt',
      idempotencyKey: 'expiring-key',
    }

    await model.create(input)
    currentTime += 7 * 24 * 60 * 60 * 1_000 + 1
    await expect(model.create({ ...input, initialPrompt: 'Second prompt' })).resolves.toBeDefined()
    expect(createCalls).toBe(2)
  })

  test('expires an indefinitely pending create before retrying the host key', async () => {
    const created = session({ lifecycle: 'ready' })
    let currentTime = Date.parse('2026-09-22T10:00:00.000Z')
    let createCalls = 0
    let launchCalls = 0
    let resolveFirstCreate: ((reply: DevReply) => void) | undefined
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      if (command.operation === 'dev.session.create') {
        createCalls += 1
        if (createCalls === 1)
          return await new Promise<DevReply>((resolve) => {
            resolveFirstCreate = resolve
          })
        return ok(command.operation, created)
      }
      if (command.operation === 'dev.session.launchDefault') {
        launchCalls += 1
        return ok(command.operation, {
          id: 'run-1',
          runtimeSessionId: created.id,
          state: 'starting',
        })
      }
      if (command.operation === 'dev.session.get') return ok(command.operation, created)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE, {
      now: () => new Date(currentTime),
    })
    const input = {
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 1,
      initialPrompt: 'Retain this only through the retry window',
      idempotencyKey: 'pending-expiring-key',
    }

    const first = model.create(input)
    await Promise.resolve()
    currentTime += 8 * 24 * 60 * 60 * 1_000
    await expect(model.create(input)).resolves.toMatchObject({ runtimeSessionId: created.id })
    expect(createCalls).toBe(2)
    expect(launchCalls).toBe(1)

    resolveFirstCreate!(ok('dev.session.create', created))
    await expect(first).resolves.toMatchObject({ runtimeSessionId: created.id })
    // The expired request may finish after its safe host retry, but it must
    // not launch the same session a second time.
    expect(launchCalls).toBe(1)
  })

  test('does not let a late expired create overwrite a newer canonical projection', async () => {
    const stale = session({ lifecycle: 'preparing', version: 1 })
    const retried = session({ lifecycle: 'ready', version: 2, activeHarnessRunId: 'run-2' })
    let currentTime = Date.parse('2026-09-22T10:00:00.000Z')
    let createCalls = 0
    let launchCalls = 0
    let resolveFirstCreate: ((reply: DevReply) => void) | undefined
    const service = fakeService(async (command) => {
      const hierarchy = hierarchyReply(command.operation)
      if (hierarchy) return hierarchy
      if (command.operation === 'dev.session.create') {
        createCalls += 1
        if (createCalls === 1)
          return await new Promise<DevReply>((resolve) => {
            resolveFirstCreate = resolve
          })
        return ok(command.operation, retried)
      }
      if (command.operation === 'dev.session.launchDefault') {
        launchCalls += 1
        return ok(command.operation, {
          id: 'run-2',
          runtimeSessionId: retried.id,
          state: 'starting',
        })
      }
      if (command.operation === 'dev.session.get') return ok(command.operation, retried)
      throw new Error(`unexpected ${command.operation}`)
    })
    const model = createChatConversationModel(service, SCOPE, {
      now: () => new Date(currentTime),
    })
    const input = {
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 1,
      initialPrompt: 'Do not regress the newer session state',
      idempotencyKey: 'late-projection-key',
    }

    const first = model.create(input)
    await Promise.resolve()
    currentTime += 8 * 24 * 60 * 60 * 1_000
    await expect(model.create(input)).resolves.toMatchObject({
      runtimeSessionId: retried.id,
      version: 2,
      activeHarnessRunId: 'run-2',
    })
    expect(launchCalls).toBe(1)

    resolveFirstCreate!(ok('dev.session.create', stale))
    await expect(first).resolves.toMatchObject({ runtimeSessionId: stale.id })
    expect(model.project().conversations[0]).toMatchObject({
      runtimeSessionId: retried.id,
      status: 'ready',
      version: 2,
      activeHarnessRunId: 'run-2',
    })
    expect(launchCalls).toBe(1)
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

  test('does not acknowledge data for another session or generation', async () => {
    const current = session()
    const bytes = [
      encodeCbor(event({ seq: '0' })),
      encodeCbor(event({ seq: '1', runtimeSessionId: '00000000-0000-4000-8000-000000000015' })),
      encodeCbor(event({ seq: '2', generation: 2 })),
    ]
    const sent: Array<{ type: string; throughSequence?: string }> = []
    const service: DevRuntimeService = {
      ...fakeService(async (command) => {
        const hierarchy = hierarchyReply(command.operation)
        if (hierarchy) return hierarchy
        if (command.operation === 'dev.session.list')
          return ok(command.operation, { items: [current], observedAt: '2026-09-22T10:00:00Z' })
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
          handlers.onFrame({ type: 'data', sequence: '0', bytes: bytes[0]! })
          handlers.onFrame({ type: 'data', sequence: '1', bytes: bytes[1]! })
          handlers.onFrame({ type: 'data', sequence: '2', bytes: bytes[2]! })
          return {
            open: true,
            send: (frame) => {
              if (frame.type === 'ack') sent.push(frame)
            },
            close: () => undefined,
          }
        },
      }),
    }
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(current.id)
    await model.openTranscript(current.id)

    expect(sent).toEqual([
      { type: 'ack', throughSequence: '0', availableCreditBytes: bytes[0]!.byteLength },
    ])
  })

  // The transcript surface re-renders from a subscription, not a timer. A
  // poller would wake the UI thread for the whole time the surface was open,
  // including while nothing streamed, and would still render up to a tick
  // stale; a subscriber is told when a frame is accepted and stops when the
  // handle closes.
  test('subscribers are notified per accepted frame and released on close', async () => {
    const current = session()
    let handlers:
      | {
          onFrame: (frame: { type: string; sequence?: string; bytes?: Uint8Array }) => void
          onClose: (code: string, reason: string) => void
        }
      | undefined
    let closed = false
    const service: DevRuntimeService = {
      ...fakeService(async (command) => {
        const hierarchy = hierarchyReply(command.operation)
        if (hierarchy) return hierarchy
        if (command.operation === 'dev.session.list')
          return ok(command.operation, { items: [current], observedAt: '2026-09-22T10:00:00Z' })
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
        connect: (_grant, next) => {
          handlers = next as never
          next.onFrame({
            type: 'opened',
            protocol: 'runtime-events-v1',
            generation: 1,
            nextSequence: '0',
          })
          return {
            open: true,
            send: () => undefined,
            close: () => {
              closed = true
            },
          }
        },
      }),
    }
    const model = createChatConversationModel(service, SCOPE)
    await model.attach(current.id)
    const transcript = await model.openTranscript(current.id)
    const seen: number[] = []
    const unsubscribe = transcript.subscribe((state) => seen.push(state.events.length))

    handlers!.onFrame({
      type: 'data',
      sequence: '0',
      bytes: encodeCbor(event({ seq: '0', eventId: 'event-0', sourceEventId: 'source-0' })),
    })
    handlers!.onFrame({
      type: 'data',
      sequence: '1',
      bytes: encodeCbor(event({ seq: '1', eventId: 'event-1', sourceEventId: 'source-1' })),
    })
    expect(seen).toEqual([1, 2])

    // Unsubscribing stops delivery; closing the handle releases the rest and
    // tells the socket to close exactly once.
    unsubscribe()
    handlers!.onFrame({
      type: 'data',
      sequence: '2',
      bytes: encodeCbor(event({ seq: '2', eventId: 'event-2', sourceEventId: 'source-2' })),
    })
    expect(seen).toEqual([1, 2])
    expect(transcript.state().events).toHaveLength(3)

    transcript.close()
    expect(closed).toBe(true)
  })
})

describe('runtime-events-v1 transcript projection', () => {
  test('requires an explicit checkpoint before accepting a bounded replay floor', () => {
    let state = createTranscriptAccumulator({
      runtimeSessionId: session().id,
      generation: 1,
      fromSequence: '0',
    })
    state = acceptRuntimeStreamFrame(
      state,
      { type: 'opened', protocol: 'runtime-events-v1', generation: 1, nextSequence: '0' },
      'host'
    )
    state = acceptRuntimeStreamFrame(
      state,
      { type: 'data', sequence: '502', bytes: encodeCbor(event({ seq: '502' })) },
      'host'
    )
    expect(state.availability).toMatchObject({ status: 'resync_required', reason: 'sequence_gap' })

    state = createTranscriptAccumulator({
      runtimeSessionId: session().id,
      generation: 1,
      fromSequence: '500',
    })
    state = acceptRuntimeStreamFrame(
      state,
      { type: 'opened', protocol: 'runtime-events-v1', generation: 1, nextSequence: '500' },
      'host'
    )
    state = acceptRuntimeStreamFrame(
      state,
      { type: 'resync', reason: 'checkpoint_required', checkpointSequence: '502' },
      'host'
    )
    state = acceptRuntimeStreamFrame(
      state,
      {
        type: 'data',
        sequence: '502',
        bytes: encodeCbor(event({ seq: '502', sourceEventId: 'source-502' })),
      },
      'host'
    )
    expect(state.availability).toMatchObject({ status: 'bounded', reason: 'checkpoint_required' })
    expect(state.expectedSequence).toBe('503')

    state = acceptRuntimeStreamFrame(
      state,
      {
        type: 'data',
        sequence: '504',
        bytes: encodeCbor(event({ seq: '504', sourceEventId: 'source-504' })),
      },
      'host'
    )
    expect(state.availability).toMatchObject({ status: 'resync_required', reason: 'sequence_gap' })
  })

  test('starts a bounded window at the requested sequence', () => {
    const events = Array.from({ length: 1_000 }, (_, index) =>
      event({
        eventId: `event-${index}`,
        sourceEventId: `source-${index}`,
        seq: String(index),
      })
    )
    const state = transcriptWindow(events, {
      runtimeSessionId: session().id,
      generation: 1,
      fromSequence: '500',
      limit: 500,
    })

    expect(state.events).toHaveLength(500)
    expect(state.events[0]?.seq).toBe('500')
    expect(state.events.at(-1)?.seq).toBe('999')
    expect(state.availability).toMatchObject({ status: 'available' })
  })

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
