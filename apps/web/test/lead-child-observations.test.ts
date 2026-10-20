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
