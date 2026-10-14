import { expect, test } from 'bun:test'
import {
  createLeadTurnRuntime,
  type LeadRuntimeAdapter,
  type LeadRuntimeAuthorityPurpose,
  type LeadRuntimeStore,
} from '../src/server/lead-turn-runtime'

// Each runtime path asks the store for the authority its semantics allow. Only prepare and dispatch
// are new effects. Status, progress and recovery reconcile existing evidence. Cancel is actor-only
// and never admits new work, so it cannot redispatch a fenced or archived admission.
const intentId = '65a15864-a6b7-4c9c-9be3-cde31d9b3b8d'
const scope = { workspaceId: 'adea-workspace', intentId, userId: 'owner' }
const authority = {
  intentId,
  messageId: 'message',
  workspaceId: 'adea-workspace',
  controlPlaneWorkspaceId: `wsp_${'0'.repeat(26)}`,
  originalActorRef: 'user:owner' as const,
}
const binding = {
  schemaVersion: 'pi-lead-dispatch/v1',
  intentId,
  dispatchId: `dispatch_${'a'.repeat(32)}`,
  executionId: `exe_${'0'.repeat(26)}`,
  attemptId: `att_${'0'.repeat(26)}`,
  runtimeSessionId: `ses_${'0'.repeat(26)}`,
}
const selection = {
  workspaceId: authority.controlPlaneWorkspaceId,
  intentId,
  executionId: binding.executionId,
  attemptId: binding.attemptId,
  selectionRef: `msel_${'a'.repeat(32)}`,
  selectionRevision: 1,
  preparationRef: `prep_${'a'.repeat(32)}`,
  expiresAt: '2100-01-01T00:00:00Z',
}

test('each runtime path requests the authority purpose its semantics allow', async () => {
  const purposes: LeadRuntimeAuthorityPurpose[] = []
  let observed: Record<string, unknown> | undefined
  const store: LeadRuntimeStore = {
    async authorize(_scope, purpose) {
      purposes.push(purpose)
      return authority
    },
    async read() {
      return observed as never
    },
    async prepare(_scope, pin) {
      observed ??= {
        ...authority,
        ...pin,
        workspaceId: authority.workspaceId,
        state: 'prepared',
        preparationExpiresAt: pin.expiresAt,
      }
    },
    async pending() {
      observed = { ...observed, state: 'dispatch_pending' }
    },
    async observe(_scope, value) {
      observed = { ...observed, ...value } as never
      return observed as never
    },
    async recover(_scope, value) {
      observed = { ...observed, ...value } as never
      return observed as never
    },
    async cancelRequested() {},
    async publish() {
      return 'agent-message'
    },
  }
  const adapter: LeadRuntimeAdapter = {
    async prepare() {
      return selection
    },
    async dispatch() {
      return { ...binding, state: 'running', replayed: false }
    },
    async status() {
      return { ...binding, state: 'running', status: { observedAt: '2026-10-08T00:00:00Z' } }
    },
    async progress() {
      return { ...binding, events: [], nextSequence: 0 }
    },
    async cancel() {
      return { ...binding, state: 'cancelling', status: { observedAt: '2026-10-08T00:00:00Z' } }
    },
    async assertPublicationCurrent() {},
  }
  const service = createLeadTurnRuntime({
    store,
    adapter,
    authorizeConfirmedStart: async () => selection,
  })

  // A path may also request `read` for its projection. The invariant is which purposes it may request.
  const requestedBy = async (run: () => Promise<unknown>) => {
    const before = purposes.length
    await run()
    return new Set<LeadRuntimeAuthorityPurpose>(purposes.slice(before))
  }

  const admitting = await requestedBy(() => service.prepare(scope))
  expect(admitting.has('effect')).toBe(true)
  expect(admitting.has('cancel')).toBe(false)
  const dispatching = await requestedBy(() => service.dispatch(scope))
  expect(dispatching.has('effect')).toBe(true)
  expect(dispatching.has('cancel')).toBe(false)

  for (const reconciling of [
    await requestedBy(() => service.status(scope)),
    await requestedBy(() => service.progress(scope, 0)),
  ]) {
    expect(reconciling.has('read')).toBe(true)
    expect(reconciling.has('effect')).toBe(false)
    expect(reconciling.has('cancel')).toBe(false)
  }

  const cancelling = await requestedBy(() => service.cancel(scope))
  expect(cancelling.has('cancel')).toBe(true)
  expect(cancelling.has('effect')).toBe(false)
})
