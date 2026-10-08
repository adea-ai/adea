import { expect, test } from 'bun:test'
import type { ApiLeadTurnProgressResponse, ApiLeadTurnStatus } from '@adea-ai/api-client'
import type { ApiModelFundingView } from '@adea-ai/api-client/model-connections'

import {
  createLeadTurnViewController,
  type LeadTurnPort,
  type LeadTurnScope,
} from '../../src/lead-turn-state'

const now = Date.parse('2026-10-08T10:00:00Z')
const admitted = (): ApiLeadTurnStatus => ({
  schemaVersion: 'adea-lead-turn/v1',
  intentId: 'a0000000-0000-4000-8000-000000000001',
  messageId: 'b0000000-0000-4000-8000-000000000001',
  state: 'prepared',
  availability: 'available',
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  selectionRef: `msel_${'a'.repeat(32)}`,
  selectionRevision: 1,
  preparationRef: `prep_${'c'.repeat(32)}`,
  preparationExpiresAt: '2026-10-08T10:30:00Z',
})
const running = (): ApiLeadTurnStatus => ({
  ...admitted(),
  dispatchId: `dispatch_${'b'.repeat(32)}`,
  runtimeSessionId: `ses_${'0'.repeat(26)}`,
  state: 'running',
})
const funded = (): Extract<ApiModelFundingView, { state: 'ready' }> => ({
  schemaVersion: 'model-funding-display/v1',
  workspaceId: 'workspace',
  executionId: admitted().executionId!,
  attemptId: admitted().attemptId!,
  selectionRef: admitted().selectionRef!,
  selectionRevision: 1,
  state: 'ready',
  provider: 'provider',
  providerModel: 'model',
  accountRef: 'account',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  fundingOwner: {
    ownerRef: 'payer',
    kind: 'provider_account',
    displayName: 'Recorded payer',
    revision: 1,
  },
  authorityRevision: 1,
  expiresAt: '2026-10-08T11:00:00Z',
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(initial: ApiLeadTurnStatus | null = admitted()) {
  let scope: LeadTurnScope = { workspaceId: 'workspace', channelId: 'channel', audienceEpoch: 0 }
  let currentTime = now
  const calls: string[] = []
  const cursors: number[] = []
  const drafts = new Map([
    ['channel', 'Unsent independent draft'],
    ['other-topic', 'Other draft'],
  ])
  const overrides: Partial<LeadTurnPort> = {}
  const port: LeadTurnPort = {
    latest: async (...args) => {
      calls.push('latest')
      return overrides.latest?.(...args) ?? { leadTurn: initial }
    },
    status: async (...args) => {
      calls.push('status')
      return overrides.status?.(...args) ?? { leadTurn: initial! }
    },
    progress: async (...args) => {
      calls.push('progress')
      cursors.push(args[2])
      return (
        overrides.progress?.(...args) ?? { leadTurn: initial!, events: [], nextSequence: args[2] }
      )
    },
    funding: async (...args) => {
      calls.push('funding')
      return overrides.funding?.(...args) ?? { funding: funded() }
    },
    prepare: async (...args) => {
      calls.push('prepare')
      return overrides.prepare?.(...args) ?? { leadTurn: admitted() }
    },
    start: async (...args) => {
      calls.push('start')
      return overrides.start?.(...args) ?? { leadTurn: running() }
    },
    cancel: async (...args) => {
      calls.push('cancel')
      return overrides.cancel?.(...args) ?? { leadTurn: { ...running(), state: 'cancelling' } }
    },
  }
  const controller = createLeadTurnViewController({
    scope: () => scope,
    port,
    now: () => currentTime,
    changed: () => {},
  })
  controller.reset(initial)
  return {
    controller,
    overrides,
    calls,
    cursors,
    drafts,
    advanceTime: (time: number) => {
      currentTime = time
    },
    changeScope: (patch: Partial<LeadTurnScope>) => {
      scope = { ...scope, ...patch }
      controller.reset()
    },
  }
}

test('preparation expiring during the funding recheck cannot start an accepted attempt', async () => {
  const h = fixture()
  const pendingFunding = deferred<{ funding: ApiModelFundingView }>()
  h.overrides.funding = () => pendingFunding.promise
  const starting = h.controller.start(funded())
  expect(h.calls).toEqual(['funding'])
  h.advanceTime(Date.parse(admitted().preparationExpiresAt!))
  pendingFunding.resolve({ funding: funded() })
  await starting
  expect(h.calls).toEqual(['funding'])
  expect(h.controller.view.turn).toEqual(admitted())
  expect(h.controller.view.turn?.dispatchId).toBeUndefined()
})

test('only explicit start rechecks the exact recorded payer before dispatch', async () => {
  const h = fixture()
  await h.controller.refresh()
  expect(h.calls).toEqual(['status', 'funding'])
  await h.controller.start(funded())
  expect(h.calls).toEqual(['status', 'funding', 'funding', 'start'])
  expect(h.controller.view.turn).toMatchObject({
    state: 'running',
    runtimeSessionId: running().runtimeSessionId,
  })
  expect([...h.drafts]).toEqual([
    ['channel', 'Unsent independent draft'],
    ['other-topic', 'Other draft'],
  ])
})

test('latest, status and progress reads never prepare or start inference', async () => {
  const h = fixture(null)
  h.overrides.latest = async () => ({ leadTurn: running() })
  h.overrides.status = async () => ({ leadTurn: running() })
  h.overrides.progress = async () => ({ leadTurn: running(), events: [], nextSequence: 0 })
  await h.controller.refresh()
  await h.controller.refresh()
  expect(h.calls).toEqual([
    'latest',
    'status',
    'progress',
    'funding',
    'status',
    'progress',
    'funding',
  ])
  expect(h.calls).not.toContain('start')
  expect(h.calls).not.toContain('prepare')
})

for (const key of [
  'workspaceId',
  'executionId',
  'attemptId',
  'selectionRef',
  'selectionRevision',
] as const) {
  test(`start rejects a disclosure bound to another ${key}`, async () => {
    const h = fixture()
    const invalid = { ...funded(), [key]: key === 'selectionRevision' ? 2 : 'other' }
    await h.controller.start(invalid as ApiModelFundingView)
    expect(h.calls).toEqual([])
    expect(h.controller.view.turn?.state).toBe('prepared')
  })
}

for (const expiresAt of ['2026-10-08T09:59:59Z', '2026-10-08T10:00:00Z', 'invalid']) {
  test(`expired or invalid disclosure cannot start: ${expiresAt}`, async () => {
    const h = fixture()
    await h.controller.start({ ...funded(), expiresAt })
    expect(h.calls).toEqual([])
  })
}

for (const change of [
  { fundingOwner: { ...funded().fundingOwner, ownerRef: 'new-payer' } },
  { fundingOwner: { ...funded().fundingOwner, revision: 2 } },
  { authorityRevision: 2 },
  { providerModel: 'new-model' },
]) {
  test(`changed current funding cannot renew the same accepted attempt: ${JSON.stringify(change)}`, async () => {
    const h = fixture()
    const fresh = { ...funded(), ...change }
    h.overrides.funding = async () => ({ funding: fresh })
    await h.controller.start(funded())
    expect(h.calls).toEqual(['funding'])
    expect(h.controller.view.funding).toEqual(fresh)
    expect(h.controller.view.notice).toContain('changed')
    await h.controller.start(fresh)
    expect(h.calls).toEqual(['funding'])
    await h.controller.refresh()
    expect(h.calls).toEqual(['funding', 'status', 'funding'])
    await h.controller.start(fresh)
    expect(h.calls).toEqual(['funding', 'status', 'funding'])
    expect(h.controller.view.turn).toEqual(admitted())
    expect(h.calls).not.toContain('prepare')
    expect(h.calls).not.toContain('start')
  })
}

for (const patch of [
  { preparationRef: undefined },
  { preparationRef: '' },
  { preparationRef: 'prep_invalid' },
  { preparationExpiresAt: undefined },
  { preparationExpiresAt: 'invalid' },
  { preparationExpiresAt: '2026-11-31T10:30:00Z' },
  { preparationExpiresAt: '2026-10-08T09:59:59Z' },
  { preparationExpiresAt: '2026-10-08T10:00:00Z' },
]) {
  test(`already-prepared attempt cannot renew missing, invalid or expired preparation: ${JSON.stringify(patch)}`, async () => {
    const turn = { ...admitted(), ...patch }
    const h = fixture(turn)
    await h.controller.prepare()
    expect(h.calls).toEqual([])
    expect(h.controller.view.turn).toEqual(turn)
    expect(h.controller.view.funding).toBeNull()
  })
  test(`missing, invalid or expired preparation rejects explicit start: ${JSON.stringify(patch)}`, async () => {
    const turn = { ...admitted(), ...patch }
    const h = fixture(turn)
    await h.controller.start(funded())
    expect(h.calls).toEqual([])
    expect(h.controller.view.turn).toEqual(turn)
    expect(h.controller.view.funding).toBeNull()
  })
  test(`missing, invalid or expired preparation cannot disclose funding or start: ${JSON.stringify(patch)}`, async () => {
    const turn = { ...admitted(), ...patch }
    const h = fixture(turn)
    await h.controller.refresh()
    expect(h.calls).toEqual(['status'])
    expect(h.controller.view.funding).toBeNull()
    await h.controller.start(funded())
    expect(h.calls).toEqual(['status'])
    expect(h.controller.view.turn).toEqual(turn)
    expect(h.calls).not.toContain('prepare')
    expect(h.calls).not.toContain('start')
  })
}

test('first explicit preparation remains allowed for a blocked saved message without preparation', async () => {
  const h = fixture({
    ...admitted(),
    state: 'blocked',
    availability: 'unavailable',
    preparationRef: undefined,
    preparationExpiresAt: undefined,
  })
  h.overrides.status = async () => ({ leadTurn: admitted() })
  await h.controller.prepare()
  expect(h.calls).toEqual(['prepare', 'status', 'funding'])
  expect(h.controller.view.turn).toEqual(admitted())
  expect(h.controller.view.funding?.state).toBe('ready')
  expect(h.calls).not.toContain('start')
})

test('revoked or expired funding at confirmation time never dispatches', async () => {
  for (const funding of [
    { ...funded(), expiresAt: '2026-10-08T10:00:00Z' },
    {
      schemaVersion: 'model-funding-display/v1',
      workspaceId: 'workspace',
      executionId: admitted().executionId!,
      attemptId: admitted().attemptId!,
      selectionRef: admitted().selectionRef!,
      selectionRevision: 1,
      state: 'blocked',
      reasonCode: 'CONNECTION_REVOKED',
    } as const,
  ]) {
    const h = fixture()
    h.overrides.funding = async () => ({ funding })
    await h.controller.start(funded())
    expect(h.calls).toEqual(['funding'])
    expect(h.controller.view.funding?.state).toBe('blocked')
  }
})

test('saved blocked, already dispatched and terminal turns cannot implicitly start', async () => {
  for (const turn of [
    { ...admitted(), availability: 'unavailable' as const, state: 'blocked' as const },
    running(),
    { ...admitted(), state: 'completed' as const },
    { ...admitted(), selectionRef: undefined },
  ]) {
    const h = fixture(turn)
    await h.controller.start(funded())
    expect(h.calls).toEqual([])
  }
})

test('a blocked turn cannot start even with available transport and exact ready funding', async () => {
  const blocked = { ...admitted(), state: 'blocked' as const }
  const h = fixture(blocked)
  await h.controller.refresh()
  expect(h.controller.view.turn).toEqual(blocked)
  expect(h.controller.view.funding?.state).toBe('ready')
  expect(h.calls).toEqual(['status', 'funding'])
  await h.controller.start(funded())
  expect(h.calls).toEqual(['status', 'funding'])
  expect(h.controller.view.turn?.state).toBe('blocked')
  expect(h.controller.view.busy).toBe(false)
})

test('dispatch-pending is not an explicitly prepared state and cannot start again', async () => {
  const h = fixture({ ...admitted(), state: 'dispatch_pending' })
  await h.controller.start(funded())
  expect(h.calls).toEqual([])
  expect(h.controller.view.turn?.state).toBe('dispatch_pending')
})

for (const state of [
  'running',
  'dispatch_pending',
  'unknown',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const) {
  test(`preparation cannot readmit a ${state} record even without a dispatch reference`, async () => {
    const turn = { ...admitted(), state }
    const h = fixture(turn)
    await h.controller.refresh()
    expect(h.calls).toEqual(['status', 'funding'])
    expect(h.controller.view.turn?.state).toBe(state)
    await h.controller.prepare()
    expect(h.calls).toEqual(['status', 'funding'])
    expect(h.controller.view.turn).toEqual(turn)
  })
}

test('interrupted prepared recovery stays read-only until one explicit confirmed start', async () => {
  const h = fixture(null)
  h.overrides.latest = async () => ({ leadTurn: admitted() })
  h.overrides.status = async () => ({ leadTurn: admitted() })
  await h.controller.refresh()
  expect(h.calls).toEqual(['latest', 'status', 'funding'])
  expect(h.controller.view.turn?.state).toBe('prepared')
  expect(h.controller.view.funding?.state).toBe('ready')
  expect(h.calls).not.toContain('prepare')
  expect(h.calls).not.toContain('start')
  await h.controller.start(funded())
  await h.controller.start(funded())
  expect(h.calls).toEqual(['latest', 'status', 'funding', 'funding', 'start'])
  expect(h.controller.view.turn?.state).toBe('running')
  expect(h.calls.filter((call) => call === 'start')).toHaveLength(1)
})

test('cancel keeps the acknowledged cancelling state until observed termination', async () => {
  const h = fixture(running())
  expect(h.controller.canCancel()).toBe(true)
  await h.controller.cancel()
  expect(h.calls).toEqual(['cancel'])
  expect(h.controller.view.turn?.state).toBe('cancelling')
  expect(h.controller.view.turn?.state).not.toBe('cancelled')
  h.overrides.status = async () => ({ leadTurn: { ...running(), state: 'cancelled' } })
  h.overrides.progress = async () => ({
    leadTurn: { ...running(), state: 'cancelled' },
    events: [],
    nextSequence: 0,
  })
  await h.controller.refresh()
  expect(h.controller.view.turn?.state).toBe('cancelled')
  expect(h.controller.canCancel()).toBe(false)
})

test('progress passes the committed cursor forward and replay preserves that frontier', async () => {
  const h = fixture(running())
  let nextSequence = 3
  h.overrides.progress = async () => ({ leadTurn: running(), events: [], nextSequence })
  await h.controller.refresh()
  await h.controller.refresh()
  nextSequence = 5
  await h.controller.refresh()
  expect(h.cursors).toEqual([0, 3, 3])
  expect(h.controller.view.cursor).toBe(5)
})

for (const nextSequence of [
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
]) {
  test(`invalid progress cursor is rejected: ${nextSequence}`, async () => {
    const h = fixture(running())
    h.overrides.progress = async () => ({ leadTurn: running(), events: [], nextSequence })
    await h.controller.refresh()
    expect(h.controller.view.cursor).toBe(0)
    expect(h.controller.view.notice).toContain('unavailable')
  })
}

test('an older progress cursor cannot rewind or replace the committed turn', async () => {
  const h = fixture(running())
  h.overrides.progress = async () => ({ leadTurn: running(), events: [], nextSequence: 3 })
  await h.controller.refresh()
  h.overrides.progress = async () => ({
    leadTurn: { ...running(), state: 'completed' },
    events: [],
    nextSequence: 2,
  })
  await h.controller.refresh()
  expect(h.controller.view.cursor).toBe(3)
  expect(h.controller.view.turn?.state).toBe('running')
  expect(h.controller.view.notice).toContain('unavailable')
})

for (const patch of [
  { workspaceId: 'other' },
  { channelId: 'other-topic' },
  { audienceEpoch: 1 },
]) {
  test(`late read and start confirmation cannot cross scope: ${JSON.stringify(patch)}`, async () => {
    const h = fixture()
    const pendingStatus = deferred<{ leadTurn: ApiLeadTurnStatus }>()
    h.overrides.status = () => pendingStatus.promise
    const refresh = h.controller.refresh()
    h.changeScope(patch)
    pendingStatus.resolve({ leadTurn: admitted() })
    await refresh
    expect(h.controller.view.turn).toBeNull()
    expect(h.controller.view.funding).toBeNull()
    expect(h.calls).toEqual(['status'])

    const starter = fixture()
    const pendingFunding = deferred<{ funding: ApiModelFundingView }>()
    starter.overrides.funding = () => pendingFunding.promise
    const start = starter.controller.start(funded())
    starter.changeScope(patch)
    pendingFunding.resolve({ funding: funded() })
    await start
    expect(starter.calls).toEqual(['funding'])
    expect(starter.controller.view.turn).toBeNull()
    expect([...starter.drafts]).toEqual([
      ['channel', 'Unsent independent draft'],
      ['other-topic', 'Other draft'],
    ])
  })
}

test('late progress, start and cancel acknowledgements cannot repopulate a reset audience', async () => {
  const progress = fixture(running())
  const pendingProgress = deferred<ApiLeadTurnProgressResponse>()
  progress.overrides.progress = () => pendingProgress.promise
  const reading = progress.controller.refresh()
  await Promise.resolve()
  expect(progress.calls).toEqual(['status', 'progress'])
  progress.changeScope({ audienceEpoch: 1 })
  pendingProgress.resolve({ leadTurn: running(), events: [], nextSequence: 3 })
  await reading
  expect(progress.controller.view.turn).toBeNull()
  expect(progress.controller.view.cursor).toBe(0)

  const starter = fixture()
  const pendingStart = deferred<{ leadTurn: ApiLeadTurnStatus }>()
  starter.overrides.start = () => pendingStart.promise
  const starting = starter.controller.start(funded())
  await Promise.resolve()
  expect(starter.calls).toEqual(['funding', 'start'])
  starter.changeScope({ audienceEpoch: 1 })
  pendingStart.resolve({ leadTurn: running() })
  await starting
  expect(starter.controller.view.turn).toBeNull()

  const canceller = fixture(running())
  const pendingCancel = deferred<{ leadTurn: ApiLeadTurnStatus }>()
  canceller.overrides.cancel = () => pendingCancel.promise
  const cancelling = canceller.controller.cancel()
  expect(canceller.calls).toEqual(['cancel'])
  canceller.changeScope({ channelId: 'other' })
  pendingCancel.resolve({ leadTurn: { ...running(), state: 'cancelling' } })
  await cancelling
  expect(canceller.controller.view.turn).toBeNull()
})

test('latest recovery and preparation responses are ignored after the audience resets', async () => {
  const latest = fixture(null)
  const pendingLatest = deferred<{ leadTurn: ApiLeadTurnStatus | null }>()
  latest.overrides.latest = () => pendingLatest.promise
  const reading = latest.controller.refresh()
  latest.changeScope({ audienceEpoch: 1 })
  pendingLatest.resolve({ leadTurn: running() })
  await reading
  expect(latest.calls).toEqual(['latest'])
  expect(latest.controller.view.turn).toBeNull()

  const preparing = fixture({ ...admitted(), availability: 'unavailable', state: 'blocked' })
  const pendingPrepare = deferred<{ leadTurn: ApiLeadTurnStatus }>()
  preparing.overrides.prepare = () => pendingPrepare.promise
  const preparation = preparing.controller.prepare()
  preparing.changeScope({ channelId: 'other-topic' })
  pendingPrepare.resolve({ leadTurn: admitted() })
  await preparation
  expect(preparing.calls).toEqual(['prepare'])
  expect(preparing.controller.view.turn).toBeNull()
})

test('failed cancellation preserves observed runtime state and cannot claim completion', async () => {
  const h = fixture(running())
  h.overrides.cancel = async () => {
    throw new Error('Transport unavailable')
  }
  await h.controller.cancel()
  expect(h.controller.view.turn?.state).toBe('running')
  expect(h.controller.view.notice).toContain('unavailable')
  expect([...h.drafts]).toEqual([
    ['channel', 'Unsent independent draft'],
    ['other-topic', 'Other draft'],
  ])
})

test('disposing the view ignores a pending acknowledgement without further dispatch', async () => {
  const h = fixture()
  const pendingFunding = deferred<{ funding: ApiModelFundingView }>()
  h.overrides.funding = () => pendingFunding.promise
  const starting = h.controller.start(funded())
  h.controller.dispose()
  pendingFunding.resolve({ funding: funded() })
  await starting
  expect(h.calls).toEqual(['funding'])
  expect(h.controller.view.turn?.state).toBe('prepared')
})

test('response bound to another intent or canonical message is not adopted', async () => {
  for (const patch of [{ intentId: 'other' }, { messageId: 'other' }]) {
    const h = fixture()
    h.overrides.status = async () => ({ leadTurn: { ...admitted(), ...patch, state: 'completed' } })
    await h.controller.refresh()
    expect(h.controller.view.turn?.state).toBe('prepared')
    expect(h.controller.view.notice).toContain('unavailable')
    expect(h.calls).toEqual(['status'])
  }
})
