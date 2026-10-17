// Opt-in joined backend proof. A pinned lead profile that states no child allowance keeps CP's
// legacy behaviour: nothing is held back from the lead's attempt, and only balance released by the
// lead's settled spending can fund children. Compare child-allocation.test.mjs, where the allowance
// is stated on the pinned profile version. Ports other than CP's are scripted, never live.
import { beforeAll, afterAll, test, expect } from 'bun:test'
import { startHarness } from './harness.mjs'
let harness, control
beforeAll(async () => {
  harness = await startHarness({
    allowanceSource: 'none',
    title: '1211 lead profile without a child allowance',
  })
  control = harness.control
}, 30000)
afterAll(async () => {
  await harness?.stop()
}, 15000)

test('a pinned profile that states no allowance gives the lead plan none and holds nothing back', async () => {
  const prepared = await control('prepare')
  expect(prepared.prepared.selectionRef).toBe(
    harness.choices.requestedModelSelections.lead.selectionRef
  )
  const dispatched = await control('dispatch')
  expect(dispatched.ok).toBe(true)
  const provenance = await control('provenance')
  expect(provenance.source).toBe('none')
  expect(provenance.catalogVersion).toMatchObject({
    profileVersionId: provenance.planProfile.profileVersionId,
    contentDigest: provenance.planProfile.contentDigest,
    lifecycle: 'published',
  })
  expect(provenance.profileAllowance).toBeUndefined()
  expect(provenance.requestAllowance).toBeUndefined()
  expect(provenance.planAllowance).toBeUndefined()
  // Nothing is held back: the lead's attempt reserved its whole envelope.
  expect(provenance.lead.availableMicrounits).toBe(0)
  expect(provenance.lead.availableTokens).toBe(0)
  expect(provenance.lead.reservedMicrounits).toBe(provenance.lead.maximumMicrounits)
}, 30000)
test('while the lead attempt holds its whole envelope no child is funded', async () => {
  const refused = await control('allocate')
  expect(refused.ok).toBe(false)
  expect(refused.code).toBe('BUDGET_EXHAUSTED')
  expect(refused.persistedChild).toBe(false)
  expect(refused.childBudget).toBeUndefined()
  expect(refused.after.canonical).toEqual(refused.before.canonical)
  expect(refused.after.parent).toEqual(refused.before.parent)
  expect(refused.after.physicalSends).toBe(0)
}, 30000)
test('balance released by the lead settling is the only funding, with no plan-level cap', async () => {
  const settled = await control('spend-lead', { costMicrounits: 1000, tokens: 10 })
  expect(settled.parent.spentMicrounits).toBe(1000)
  expect(settled.parent.availableMicrounits).toBeGreaterThan(0)
  const first = await control('allocate')
  expect(first.ok).toBe(true)
  expect(first.leadAllowance).toBeUndefined()
  const second = await control('allocate-sibling', { which: 'second' })
  // With no stated allowance nothing caps outstanding child funding below what the parent has:
  // the sibling is funded from what remains, which the stated-allowance journey refuses.
  expect(second.ok).toBe(true)
  expect(second.childBudget.maximumMicrounits).toBe(second.before.parent.availableMicrounits)
  expect(second.childBudget.maximumMicrounits).toBeGreaterThan(0)
  expect(second.after.parent.availableMicrounits).toBe(0)
}, 30000)
