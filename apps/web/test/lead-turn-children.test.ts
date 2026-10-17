import { expect, test } from 'bun:test'
import {
  createLeadTurnRuntime,
  type LeadRuntimeAdapter,
  type LeadRuntimeStore,
} from '../src/server/lead-turn-runtime'
import {
  parseLeadTurnChildrenQuery,
  projectLeadTurnChildrenPage,
} from '../src/server/lead-turn-children'

const intentId = '65a15864-a6b7-4c9c-9be3-cde31d9b3b8d'
const scope = { workspaceId: 'workspace', intentId, userId: 'owner' }
const authority = {
  ...scope,
  messageId: 'message',
  controlPlaneWorkspaceId: `wsp_${'0'.repeat(26)}`,
  originalActorRef: `user:${intentId}` as const,
}
const receipt = {
  schemaVersion: 'pi-lead-dispatch/v1',
  intentId,
  dispatchId: `dispatch_${'a'.repeat(32)}`,
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  runtimeSessionId: `ses_${'0'.repeat(26)}`,
}
const child = (index = 0) => ({
  delegationId: `dlg_${String(index).padStart(26, '0')}`,
  childExecutionId: `exe_${'1'.repeat(26)}`,
  childAttemptId: `att_${'1'.repeat(26)}`,
  role: 'researcher',
  state: 'completed' as const,
  awaitingInput: false,
  stopRequested: false,
  acceptedAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-17T00:01:00Z',
  revision: 1,
  outcome: {
    state: 'completed',
    resultRef: `art_${'0'.repeat(26)}`,
    publication: { status: 'published' },
  },
})
const page = (children = [child()]) => ({
  ...receipt,
  children,
  totalChildren: children.length,
  complete: true,
})
function fixture() {
  const reads: string[] = []
  const effects: string[] = []
  let allowed = true
  let currentAuthority = { ...authority }
  let stored: Record<string, unknown> | undefined = {
    ...receipt,
    messageId: 'message',
    state: 'completed',
  }
  let readChildren = async (_dispatchId: string, _query: unknown): Promise<unknown> => {
    reads.push('child-result')
    return page()
  }
  const effect = async () => {
    effects.push('effect')
    throw new Error('unexpected effect')
  }
  const store: LeadRuntimeStore = {
    async authorize(_scope, purpose) {
      reads.push(purpose)
      if (!allowed) throw new Error('denied')
      return currentAuthority
    },
    async read() {
      if (!allowed) throw new Error('denied')
      return stored as never
    },
    prepare: effect,
    pending: effect,
    observe: effect,
    recover: effect,
    cancelRequested: effect,
    publish: effect,
  }
  const adapter: LeadRuntimeAdapter = {
    dispatch: effect,
    status: effect,
    progress: effect,
    cancel: effect,
    async children(_authority, dispatchId, query) {
      reads.push('children')
      return readChildren(dispatchId, query)
    },
  }
  return {
    service: createLeadTurnRuntime({ store, adapter }),
    store,
    adapter,
    effects,
    reads,
    setReader: (reader: typeof readChildren) => {
      readChildren = reader
    },
    setStored: (value: typeof stored) => {
      stored = value
    },
    deny: () => {
      allowed = false
    },
    remap: () => {
      currentAuthority = { ...currentAuthority, controlPlaneWorkspaceId: `wsp_${'1'.repeat(26)}` }
    },
  }
}

test('child reads preserve completed lead and separate retained child outcome; no effect is invoked', async () => {
  const f = fixture()
  const raw = page()
  f.setReader(async (dispatchId, query) => {
    expect(dispatchId).toBe(receipt.dispatchId)
    expect(query).toEqual({})
    return raw
  })
  const result = await f.service.children(scope)
  expect(result.leadTurn.state).toBe('completed')
  expect(result.childObservations).toMatchObject({
    availability: 'available',
    totalChildren: 1,
    complete: true,
    children: [child()],
  })
  expect(f.effects).toEqual([])
  expect(
    f.reads.every((value) => value === 'read' || value === 'children' || value === 'child-result')
  ).toBe(true)
  raw.children[0]!.outcome.resultRef = `art_${'1'.repeat(26)}`
  expect(JSON.stringify(result.childObservations)).toContain(`art_${'0'.repeat(26)}`)
})

test('unobserved children are unavailable, never an empty or complete set', async () => {
  const f = fixture()
  f.setStored(undefined)
  expect((await f.service.children(scope)).childObservations).toEqual({
    availability: 'unavailable',
    reasonCode: 'NOT_DISPATCHED',
  })
  expect(f.reads).not.toContain('children')
  f.setStored({ ...receipt, state: 'running' })
  delete f.adapter.children
  expect((await f.service.children(scope)).childObservations).toEqual({
    availability: 'unavailable',
    reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE',
  })
  expect(f.effects).toEqual([])
})

test('CP not configured or refused reads disclose no empty set or private errors', async () => {
  const f = fixture()
  f.setReader(async () => {
    throw new Error('PI_LEAD_NOT_CONFIGURED private-provider-detail')
  })
  const result = await f.service.children(scope)
  expect(result.childObservations).toEqual({
    availability: 'unavailable',
    reasonCode: 'RUNTIME_UNAVAILABLE',
  })
  expect(JSON.stringify(result)).not.toContain('private-provider')
  expect(f.effects).toEqual([])
})

test('a successful zero-child observation explicitly proves an empty complete page', async () => {
  const f = fixture()
  f.setReader(async () => page([]))
  expect((await f.service.children(scope)).childObservations).toEqual({
    availability: 'available',
    children: [],
    totalChildren: 0,
    complete: true,
  })
})

test('257 children walk in bounded pages with unchanged cursor and total; no truncation', async () => {
  const f = fixture()
  const children = Array.from({ length: 257 }, (_, index) => child(index))
  const cursor = {
    acceptedAt: children[255]!.acceptedAt,
    delegationId: children[255]!.delegationId,
  }
  f.setReader(async (_dispatchId, query) => {
    if (Reflect.get(query as object, 'after')) {
      expect(query).toEqual({ limit: 256, after: cursor })
      return { ...page(children.slice(256)), totalChildren: 257 }
    }
    return { ...page(children.slice(0, 256)), totalChildren: 257, complete: false, next: cursor }
  })
  const first = (await f.service.children(scope, { limit: 256 })).childObservations
  expect(first.availability).toBe('available')
  if (first.availability !== 'available') throw new Error('missing first page')
  expect(first.children).toHaveLength(256)
  expect(first.complete).toBe(false)
  expect(first.next).toEqual(cursor)
  const last = (await f.service.children(scope, { limit: 256, after: first.next }))
    .childObservations
  expect(last).toMatchObject({
    availability: 'available',
    totalChildren: 257,
    complete: true,
    children: [children[256]],
  })
  expect(last).not.toHaveProperty('next')
  expect(f.effects).toEqual([])
})

test('a waiting child and pending stop do not change completed lead state or grant approval controls', async () => {
  const f = fixture()
  f.setReader(async () => ({
    ...page(),
    children: [
      {
        ...child(),
        state: 'awaiting_input',
        awaitingInput: true,
        stopRequested: true,
        outcome: undefined,
      },
    ],
  }))
  const result = await f.service.children(scope)
  expect(result.leadTurn.state).toBe('completed')
  expect(result.childObservations).toMatchObject({
    availability: 'available',
    children: [{ state: 'awaiting_input', awaitingInput: true, stopRequested: true }],
  })
  expect(f.effects).toEqual([])
})

test('changed canonical receipt pins and malformed pages disclose no child data', async () => {
  for (const patch of [
    { intentId: crypto.randomUUID() },
    { dispatchId: `dispatch_${'b'.repeat(32)}` },
    { executionId: `exe_${'1'.repeat(26)}` },
    { attemptId: `att_${'1'.repeat(26)}` },
    { runtimeSessionId: `ses_${'1'.repeat(26)}` },
    { children: [{ ...child(), objective: 'private' }] },
    { children: [child(), child()], totalChildren: 2 },
    { children: [child(), { ...child(), acceptedAt: '2026-10-17T00:02:00Z' }], totalChildren: 2 },
    { totalChildren: 2 },
    { complete: false },
    {
      complete: false,
      totalChildren: 2,
      next: { acceptedAt: child().acceptedAt, delegationId: child(2).delegationId },
    },
    { children: Array.from({ length: 257 }, (_, index) => child(index)), totalChildren: 257 },
  ]) {
    const f = fixture()
    f.setReader(async () => ({ ...page(), ...patch }))
    expect((await f.service.children(scope)).childObservations).toEqual({
      availability: 'unavailable',
      reasonCode: 'RUNTIME_RESPONSE_INVALID',
    })
  }
})

test('revocation before or during the CP read rejects disclosure and never mutates', async () => {
  for (const during of [false, true]) {
    const f = fixture()
    if (!during) f.deny()
    f.setReader(async () => {
      f.deny()
      return page()
    })
    await expect(f.service.children(scope)).rejects.toThrow('denied')
    if (!during) expect(f.reads).not.toContain('children')
    expect(f.effects).toEqual([])
  }
})

test('mapping or retained lineage change during a read withholds the page', async () => {
  for (const remap of [true, false]) {
    const f = fixture()
    f.setReader(async () => {
      if (remap) f.remap()
      else f.setStored({ ...receipt, dispatchId: `dispatch_${'b'.repeat(32)}`, state: 'running' })
      return page()
    })
    expect((await f.service.children(scope)).childObservations).toEqual({
      availability: 'unavailable',
      reasonCode: 'RUNTIME_RESPONSE_INVALID',
    })
  }
})

test('cursor/query parser accepts only one complete bounded page selector', () => {
  const cursor = { acceptedAt: child().acceptedAt, delegationId: child().delegationId }
  expect(parseLeadTurnChildrenQuery(new URLSearchParams())).toEqual({})
  expect(
    parseLeadTurnChildrenQuery(
      new URLSearchParams({
        limit: '256',
        afterAcceptedAt: cursor.acceptedAt,
        afterDelegationId: cursor.delegationId,
      })
    )
  ).toEqual({ limit: 256, after: cursor })
  for (const query of [
    'limit=0',
    'limit=257',
    'limit=1.5',
    'limit=01',
    'limit=1&limit=2',
    'afterSequence=1',
    'dispatchId=x',
    'afterAcceptedAt=2026-10-17T00:00:00Z',
    'afterDelegationId=bad',
    'afterAcceptedAt=bad&afterDelegationId=bad',
  ])
    expect(parseLeadTurnChildrenQuery(new URLSearchParams(query))).toBeNull()
})

test('page decoder refuses repeat cursors, out-of-order pages, and excess requested page size', () => {
  const cursor = { acceptedAt: child().acceptedAt, delegationId: child().delegationId }
  expect(() => projectLeadTurnChildrenPage(page(), { after: cursor })).toThrow()
  expect(() => projectLeadTurnChildrenPage(page([child(1), child(0)]), {})).toThrow()
  expect(() => projectLeadTurnChildrenPage(page([child(0), child(1)]), { limit: 1 })).toThrow()
})
