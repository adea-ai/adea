import { expect, test } from 'bun:test'
import type { ApiLeadTurnChild } from '@adea-ai/api-client'
import { readLeadChildObservations } from '../src/lib/lead-child-observations'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const dispatchId = `dispatch_${'a'.repeat(32)}`
const child = (n: number) => ({
  delegationId: `dlg_${String(n).padStart(26, '0')}`,
  childExecutionId: `exe_${String(n).padStart(26, '0')}`,
  role: 'research',
  state: 'completed' as const,
  awaitingInput: false,
  stopRequested: false,
  acceptedAt: new Date(Date.UTC(2026, 9, 20, 1, 0, n)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 20, 1, 1, n)).toISOString(),
  revision: 1,
  outcome: { state: 'completed' as const, publication: { status: 'published' as const } },
})
const childAt = (n: number, acceptedAt: string) => ({
  ...child(n),
  acceptedAt,
  updatedAt: acceptedAt,
})
const available = (
  children: readonly ApiLeadTurnChild[],
  totalChildren: number,
  next?: ReturnType<typeof child>
) => ({
  leadTurn: { intentId, dispatchId },
  childObservations: {
    availability: 'available' as const,
    children,
    totalChildren,
    complete: next === undefined,
    ...(next ? { next: { acceptedAt: next.acceptedAt, delegationId: next.delegationId } } : {}),
  },
})
const reader = (pages: readonly unknown[]) => {
  let index = 0
  return {
    async getLeadTurnChildren() {
      const next = pages[index++]
      if (next instanceof Error) throw next
      return next
    },
    get count() {
      return index
    },
  }
}

test('a retained child outcome is mapped once for the mounted handoff evidence', async () => {
  const port = reader([available([child(1)], 1)])
  const result = await readLeadChildObservations(port as never, workspaceId, intentId, dispatchId)
  expect(result).toMatchObject({
    availability: 'available',
    totalChildren: 1,
    complete: true,
    children: [
      {
        delegationId: child(1).delegationId,
        state: 'completed',
        outcome: { state: 'completed', publication: 'published' },
      },
    ],
  })
  expect(port.count).toBe(1)
})

test('failed and cancelled children preserve their distinct retained outcomes', async () => {
  const failed = {
    ...child(1),
    state: 'failed' as const,
    outcome: {
      state: 'failed' as const,
      failureCode: 'PROVIDER_FAILED',
      publication: { status: 'pending' as const },
    },
  }
  const cancelled = {
    ...child(2),
    state: 'cancelled' as const,
    stopRequested: true,
    outcome: { state: 'cancelled' as const, publication: { status: 'published' as const } },
  }
  const result = await readLeadChildObservations(
    reader([available([failed, cancelled], 2)]) as never,
    workspaceId,
    intentId,
    dispatchId
  )
  expect(result).toMatchObject({
    availability: 'available',
    complete: true,
    children: [
      {
        state: 'failed',
        outcome: { state: 'failed', failureCode: 'PROVIDER_FAILED', publication: 'pending' },
      },
      { state: 'cancelled', stopRequested: true, outcome: { state: 'cancelled' } },
    ],
  })
})

test('pages are joined in acceptance order without treating a last page alone as the full set', async () => {
  const first = child(1)
  const second = child(2)
  const port = reader([available([first], 2, first), available([second], 2)])
  const result = await readLeadChildObservations(port as never, workspaceId, intentId, dispatchId)
  expect(result).toMatchObject({ availability: 'available', totalChildren: 2, complete: true })
  if (result.availability === 'available')
    expect(result.children.map((item) => item.delegationId)).toEqual([
      first.delegationId,
      second.delegationId,
    ])
  expect(port.count).toBe(2)
})

test('duplicate, out-of-order, and changing-count pages stay visibly partial', async () => {
  const first = child(1)
  for (const second of [first, child(0)]) {
    const port = reader([available([first], 2, first), available([second], 2)])
    expect(
      await readLeadChildObservations(port as never, workspaceId, intentId, dispatchId)
    ).toMatchObject({ availability: 'available', totalChildren: 2, complete: false })
  }
  const changing = reader([available([first], 2, first), available([child(2)], 3)])
  expect(
    await readLeadChildObservations(changing as never, workspaceId, intentId, dispatchId)
  ).toMatchObject({ availability: 'available', totalChildren: 2, complete: false })
})

test('wrong dispatch and failed reads never become an empty complete set', async () => {
  const wrong = reader([
    { ...available([], 0), leadTurn: { intentId, dispatchId: `dispatch_${'b'.repeat(32)}` } },
  ])
  expect(
    await readLeadChildObservations(wrong as never, workspaceId, intentId, dispatchId)
  ).toEqual({
    availability: 'unavailable',
    reasonCode: 'RUNTIME_RESPONSE_INVALID',
  })
  const failed = reader([new Error('offline')])
  expect(
    await readLeadChildObservations(failed as never, workspaceId, intentId, dispatchId)
  ).toEqual({
    availability: 'unavailable',
    reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE',
  })
})

test('children accepted at the same instant are ordered by the instant, not by its spelling', async () => {
  // The control plane orders children by the instant they were accepted and by
  // delegation id within one instant. The same instant spelled with a
  // different precision is still the same instant, so a complete page must not
  // read as a regression.
  const first = childAt(1, '2026-10-20T01:00:00Z')
  const second = childAt(2, '2026-10-20T01:00:00.000Z')
  const port = reader([available([first, second], 2)])
  const result = await readLeadChildObservations(port as never, workspaceId, intentId, dispatchId)
  expect(result).toMatchObject({ availability: 'available', totalChildren: 2, complete: true })
  if (result.availability === 'available')
    expect(result.children.map((item) => item.delegationId)).toEqual([
      first.delegationId,
      second.delegationId,
    ])
})

test('the control plane reason for an unavailable read is not replaced by an invalid response', async () => {
  // A lead that was never dispatched answers with no dispatch and its own
  // reason. That is not an unusable response, and the mounted chat has to say
  // which one it was.
  const notDispatched = reader([
    {
      leadTurn: { intentId },
      childObservations: {
        availability: 'unavailable' as const,
        reasonCode: 'NOT_DISPATCHED' as const,
      },
    },
  ])
  expect(
    await readLeadChildObservations(notDispatched as never, workspaceId, intentId, dispatchId)
  ).toEqual({ availability: 'unavailable', reasonCode: 'NOT_DISPATCHED' })
})

test('the bounded read stops at its page cap and reports a partial read', async () => {
  const pages = []
  for (let n = 0; n < 20; n++) {
    const item = childAt(n, `2026-10-20T01:00:${String(n).padStart(2, '0')}Z`)
    pages.push(available([item], 20, item))
  }
  const port = reader(pages)
  const result = await readLeadChildObservations(port as never, workspaceId, intentId, dispatchId)
  expect(port.count).toBe(16)
  expect(result).toMatchObject({ availability: 'available', totalChildren: 20, complete: false })
})

test('an unbounded role or failure code is not carried into the mounted evidence', async () => {
  const unbounded = {
    ...child(1),
    role: `research${'er'.repeat(500)}`,
    outcome: {
      state: 'failed' as const,
      failureCode: `E_${'X'.repeat(500)}`,
      publication: { status: 'published' as const },
    },
  }
  const result = await readLeadChildObservations(
    reader([available([unbounded], 1)]) as never,
    workspaceId,
    intentId,
    dispatchId
  )
  expect(result).toMatchObject({ availability: 'available', complete: true })
  if (result.availability === 'available') {
    expect(result.children[0]!.role).toBe('unknown')
    expect(result.children[0]!.outcome).toEqual({ state: 'failed', publication: 'published' })
  }
})

test('a bounded failure code is carried into the mounted evidence', async () => {
  const bounded = {
    ...child(1),
    outcome: {
      state: 'failed' as const,
      failureCode: 'PROVIDER_FAILED',
      publication: { status: 'published' as const },
    },
  }
  const result = await readLeadChildObservations(
    reader([available([bounded], 1)]) as never,
    workspaceId,
    intentId,
    dispatchId
  )
  if (result.availability === 'available')
    expect(result.children[0]!.outcome).toEqual({
      state: 'failed',
      failureCode: 'PROVIDER_FAILED',
      publication: 'published',
    })
})
