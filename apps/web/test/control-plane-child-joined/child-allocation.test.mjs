// Opt-in joined backend proof. CP runs in its own pinned Bun/compiler context.
// Scope/account/tool policy/provider ports are scripted, never live qualification.
// The lead plan's child allowance is stated only on the pinned profile version (CP fixture
// childAllowanceSource 'profile'), so every allowance assertion below follows the profile.
import { beforeAll, afterAll, test, expect } from 'bun:test'
import { startHarness, pin, originalFetch } from './harness.mjs'
let harness, control, intentId, prepared, choices, assertion, reader
let deniedReads = 0
beforeAll(async () => {
  harness = await startHarness({
    allowanceSource: 'profile',
    title: '1211 connected child source proof',
  })
  ;({ control, intentId, choices, assertion, reader } = harness)
}, 30000)
afterAll(async () => {
  await harness?.stop()
}, 15000)

test('signed product reads reject another host workspace', async () => {
  const response = await originalFetch(
    new URL('/api/internal/pi-durable/lead-product/current', reader.url),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${assertion}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
        intentId,
        principalId: 'svc_agent-hq',
      }),
    }
  )
  expect(response.status).toBe(404)
  deniedReads++
})
test('Adea canonical requested roles reach CP production preparation without inference', async () => {
  const result = await control('prepare')
  prepared = result.prepared
  expect(prepared.selectionRef).toBe(choices.requestedModelSelections.lead.selectionRef)
  expect(prepared.selectionRevision).toBe(choices.requestedModelSelections.lead.selectionRevision)
  expect(prepared.selectionRef).not.toBe(choices.requestedModelSelections.child.selectionRef)
  expect(result.canonical).toMatchObject({ executions: 1, attempts: 1, budgets: 1 })
  expect(result.physicalSends).toBe(0)
  expect(result.secretResolutions).toBe(0)
  expect(result.productReads + deniedReads).toBe(harness.productRequests())
}, 20000)
test('child location refusal and revoked payer block without fallback', async () => {
  const result = await control('constraints')
  expect(result.locationDenied).toBe(true)
  expect(result.fundingState).toBe('blocked')
  expect(result.physicalSends).toBe(0)
  expect(result.secretResolutions).toBe(0)
  expect(result.canonical).toMatchObject({ executions: 1, attempts: 1, budgets: 1 })
}, 20000)
let dispatched, allocation
const logBlocker = (result) =>
  console.error(
    JSON.stringify({
      schemaVersion: 'adea-child-allocation-blocker/v1',
      cpHead: pin.revision,
      ...result,
      childRuntimeProven: false,
      candidateManifestQualified: false,
    })
  )
test('revoked and quota-blocked authority admit no child and dispatch nothing', async () => {
  dispatched = await control('dispatch')
  expect(dispatched.ok).toBe(true)
  expect(dispatched.physicalSends).toBe(0)
  try {
    for (const [mode, code] of [
      ['workspace-revoked', 'CHILD_AUTHORITY_EXPANSION'],
      ['quota-exhausted', 'CHILD_ADMISSION_DENIED'],
    ]) {
      await control('authority', { mode })
      const denied = await control('allocate')
      expect(denied.ok).toBe(false)
      // Authority is rechecked before any funding is touched.
      expect(denied.code).toBe(code)
      expect(denied.persistedChild).toBe(false)
      expect(denied.after.canonical).toEqual(dispatched.canonical)
      expect(denied.after.parent).toEqual(dispatched.parent)
      expect(denied.after.child).toBeUndefined()
      expect(denied.after.runtime).toEqual({
        startCalls: 0,
        distinctStarts: 0,
        childAttemptReservations: 0,
      })
      expect(denied.after.physicalSends).toBe(0)
      expect(denied.after.secretResolutions).toBe(0)
    }
  } finally {
    await control('authority', { mode: 'current' })
  }
}, 30000)
test('the lead allowance is stated only on the pinned profile version and the plan follows it', async () => {
  const provenance = await control('provenance')
  expect(provenance.source).toBe('profile')
  // The profile version CP's catalog holds for this plan is the published one the Adea pin
  // resolved to, at the digest the plan pinned.
  expect(provenance.catalogVersion).toMatchObject({
    profileVersionId: provenance.planProfile.profileVersionId,
    contentDigest: provenance.planProfile.contentDigest,
    lifecycle: 'published',
  })
  // The request supplied none: the allowance on the plan can only have come from the profile.
  expect(provenance.requestAllowance).toBeUndefined()
  expect(provenance.profileAllowance).toBeDefined()
  expect(provenance.planAllowance).toEqual(provenance.profileAllowance)
  // And it is the hold-back the lead's attempt actually left unreserved.
  expect(provenance.lead.availableMicrounits).toBe(provenance.profileAllowance.maximumMicrounits)
  expect(provenance.lead.availableTokens).toBe(provenance.profileAllowance.maximumTokens)
}, 20000)
test('prepared Adea lead allocates its selected child through the canonical factory', async () => {
  allocation = await control('allocate')
  if (!allocation.ok) logBlocker(allocation)
  expect(allocation.ok).toBe(true)
  expect(allocation.after.canonical).toMatchObject({ executions: 2, attempts: 2, budgets: 2 })
  const { before, after } = allocation
  // Independent budgets: the child has its own ceiling, funded by exactly that hold on
  // the parent. Nothing is spent, and the parent's own ceiling never changes.
  expect(after.parent.maximumMicrounits).toBe(before.parent.maximumMicrounits)
  expect(after.parent.maximumTokens).toBe(before.parent.maximumTokens)
  expect(after.parent.spentMicrounits).toBe(0)
  expect(after.child.maximumMicrounits).toBeGreaterThan(0)
  expect(after.child.maximumMicrounits).toBeLessThanOrEqual(allocation.childPlanMaximumMicrounits)
  expect(after.child.maximumTokens).toBeLessThanOrEqual(allocation.childPlanMaximumTokens)
  expect(after.parent.reservedMicrounits - before.parent.reservedMicrounits).toBe(
    after.child.maximumMicrounits
  )
  expect(after.parent.reservedTokens - before.parent.reservedTokens).toBe(after.child.maximumTokens)
  expect(after.child.spentMicrounits).toBe(0)
  expect(after.child.reservedMicrounits).toBe(0)
  expect(after.physicalSends).toBe(0)
  expect(after.runtime.startCalls).toBe(0)
  // The lead's plan states what is held back for children. Its attempt (reserved by CP's production
  // root admission) left exactly that unreserved, and this one child is funded with all of it.
  const { leadAllowance } = allocation
  expect(leadAllowance.maximumMicrounits).toBeGreaterThan(0)
  expect(before.parent.availableMicrounits).toBe(leadAllowance.maximumMicrounits)
  expect(before.parent.availableTokens).toBe(leadAllowance.maximumTokens)
  expect(after.child.maximumMicrounits).toBe(leadAllowance.maximumMicrounits)
  expect(after.child.maximumTokens).toBe(leadAllowance.maximumTokens)
  expect(after.parent.availableMicrounits).toBe(0)
  expect(after.parent.availableTokens).toBe(0)
}, 20000)
test('a retried allocation leaves no duplicate execution, budget or ledger effect', async () => {
  const first = await control('allocate')
  const second = await control('allocate')
  expect(second.after.canonical).toEqual(first.after.canonical)
  expect(second.after.parent).toEqual(first.after.parent)
  expect(second.after.child).toEqual(first.after.child)
  expect(second.after.physicalSends).toBe(0)
  expect(second.after.runtime.startCalls).toBe(0)
  expect(second.after.canonical.executions).toBeLessThanOrEqual(2)
}, 30000)
test('revoked and quota-blocked authority after allocation start no child runtime', async () => {
  expect(allocation?.ok).toBe(true)
  try {
    for (const mode of ['workspace-revoked', 'quota-exhausted']) {
      await control('authority', { mode })
      const denied = await control('start-child')
      expect(denied.ok).toBe(false)
      expect(denied.after.runtime).toEqual({
        startCalls: 0,
        distinctStarts: 0,
        childAttemptReservations: 0,
      })
      // No spend authority was minted for the child, and the parent is untouched.
      expect(denied.after.child).toEqual(denied.before.child)
      expect(denied.after.parent).toEqual(denied.before.parent)
      expect(denied.after.physicalSends).toBe(0)
    }
  } finally {
    await control('authority', { mode: 'current' })
  }
}, 30000)
test('current authority admits the child runtime once and a retry starts nothing twice', async () => {
  expect(allocation?.ok).toBe(true)
  const started = await control('start-child')
  if (!started.ok) logBlocker({ stage: 'child-runtime-admission', ...started })
  expect(started.ok).toBe(true)
  // Child-runtime admission reserved the child's own ceiling; the parent did not move.
  expect(started.after.runtime).toEqual({
    startCalls: 1,
    distinctStarts: 1,
    childAttemptReservations: 1,
  })
  // CP's production child admission reserves the child's funded budget less the allowance its own
  // plan holds back for children; the funded budget here equals the plan ceiling, so no scaling.
  expect(allocation.childAllowance.maximumMicrounits).toBeGreaterThan(0)
  expect(started.after.child.reservedMicrounits).toBe(
    started.after.child.maximumMicrounits - allocation.childAllowance.maximumMicrounits
  )
  expect(started.after.child.reservedTokens).toBe(
    started.after.child.maximumTokens - allocation.childAllowance.maximumTokens
  )
  expect(started.after.child.availableMicrounits).toBe(allocation.childAllowance.maximumMicrounits)
  expect(started.after.child.availableTokens).toBe(allocation.childAllowance.maximumTokens)
  expect(started.after.parent).toEqual(started.before.parent)
  const retried = await control('start-child')
  expect(retried.ok).toBe(true)
  expect(retried.after.runtime.distinctStarts).toBe(1)
  expect(retried.after.runtime.childAttemptReservations).toBe(1)
  expect(retried.after.child).toEqual(started.after.child)
  expect(retried.after.parent).toEqual(started.after.parent)
  expect(retried.after.canonical).toEqual(started.after.canonical)
  // The scripted runtime port never reaches a provider.
  expect(retried.after.physicalSends).toBe(0)
  expect(retried.after.secretResolutions).toBe(0)
}, 30000)

// Everything below changes the lead's ledger on purpose and runs last. The lead's and the first
// child's spending are scripted ledger charges: no provider is reached, they only give the ledger
// something to settle. Siblings are allocated through the same canonical delegation service and
// transactional allocator as the first child.
const leadSpend = { costMicrounits: 1000, tokens: 10 }
const childSpend = { costMicrounits: 2000, tokens: 20 }
test('a settled lead frees balance but the allowance, used by the first child, funds no sibling', async () => {
  expect(allocation?.ok).toBe(true)
  const settled = await control('spend-lead', leadSpend)
  // The lead's envelope is released and its settled spending stays counted.
  expect(settled.parent.spentMicrounits).toBe(leadSpend.costMicrounits)
  expect(settled.parent.spentTokens).toBe(leadSpend.tokens)
  expect(settled.parent.reservedMicrounits).toBe(allocation.after.child.maximumMicrounits)
  expect(settled.parent.availableMicrounits).toBeGreaterThan(0)
  expect(settled.parent.availableTokens).toBeGreaterThan(0)
  const sibling = await control('allocate-sibling', { which: 'second' })
  expect(sibling.ok).toBe(false)
  expect(sibling.code).toBe('BUDGET_EXHAUSTED')
  // Nothing is left behind: no delegation, no budget, no ledger or canonical effect.
  expect(sibling.persistedChild).toBe(false)
  expect(sibling.childBudget).toBeUndefined()
  expect(sibling.after.canonical).toEqual(sibling.before.canonical)
  expect(sibling.after.parent).toEqual(sibling.before.parent)
  expect(sibling.after.child).toEqual(sibling.before.child)
  expect(sibling.after.physicalSends).toBe(0)
}, 30000)
test('settled child spending frees only what the child did not spend', async () => {
  const settled = await control('spend-child', childSpend)
  expect(settled.child.spentMicrounits).toBe(childSpend.costMicrounits)
  expect(settled.child.spentTokens).toBe(childSpend.tokens)
  const sibling = await control('allocate-sibling', { which: 'second' })
  expect(sibling.ok).toBe(true)
  // The allowance minus what the settled child charged, however large the parent balance is.
  expect(sibling.childBudget.maximumMicrounits).toBe(
    allocation.leadAllowance.maximumMicrounits - childSpend.costMicrounits
  )
  expect(sibling.childBudget.maximumTokens).toBe(
    allocation.leadAllowance.maximumTokens - childSpend.tokens
  )
  expect(sibling.before.parent.availableMicrounits).toBeGreaterThan(
    sibling.childBudget.maximumMicrounits
  )
}, 30000)
test('a cancelled lead is refused any further child and nothing is funded', async () => {
  const cancelled = await control('cancel-lead')
  expect(cancelled.parentState).toMatchObject({ execution: 'cancelled', attempt: 'cancelled' })
  const later = await control('allocate-sibling', { which: 'third' })
  expect(later.ok).toBe(false)
  // The delegation service refuses a parent that is no longer running before it asks for product
  // admission or touches funding. The allocator's own parent fence (CHILD_ADMISSION_DENIED) is
  // proven in CP's tests, where the service is bypassed.
  expect(later.code).toBe('DELEGATION_STATE_CONFLICT')
  expect(later.persistedChild).toBe(false)
  expect(later.childBudget).toBeUndefined()
  expect(later.after.canonical).toEqual(cancelled.canonical)
  expect(later.after.parent).toEqual(cancelled.parent)
  expect(later.after.physicalSends).toBe(0)
  expect(later.after.secretResolutions).toBe(0)
}, 30000)
