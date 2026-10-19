// Opt-in joined proof for #1173: CP's periodic recovery pass completes the journey without a manual
// scan. The host runs the pass at a short test-local interval; this file never calls scan, reopen or
// settle. The deterministic manual-scan proof lives in journey.test.mjs. See README.md "Lead-to-child journey".
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startJourney, verifyJourneyPackages } from './journey-support.mjs'

const manifestPath = process.env.PI_FACTORY_MANIFEST
if (!manifestPath) throw new Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')

describe('automatic recovery completes the journey without a manual scan', () => {
  let journey, control
  beforeAll(async () => {
    await verifyJourneyPackages(manifestPath)
    process.env.PI_FACTORY_PERIODIC_RECOVERY_MS = '500'
    journey = await startJourney('1173 automatic')
    control = journey.control
  }, 90000)
  afterAll(async () => {
    await journey?.stop()
    delete process.env.PI_FACTORY_PERIODIC_RECOVERY_MS
  }, 30000)

  test('the periodic pass alone settles the child outcome, and it is published exactly once', async () => {
    const { driver } = journey
    // Hold the lead before dispatch, as the authority file does, so the lead cannot delegate before bind
    // initializes the hooks. The release below lets it run; no scan, reopen or settle is requested.
    await control('hold', { name: 'lead-first' })
    const prepared = await driver('prepare')
    expect(prepared.result.state).toBe('prepared')
    const dispatched = await driver('dispatch')
    await control('bind', { executionId: dispatched.result.executionId })
    await control('release', { name: 'lead-first' })
    const settled = await journey.waitFor(
      () => control('evidence'),
      (e) => e.costState === 'settled' && e.delegations[0]?.state === 'completed',
      'periodic recovery settles the child outcome',
      60000
    )
    const terminal = settled.publications.filter((r) => r.value.event.type === 'delegation.completed')
    expect(terminal).toHaveLength(1)
    expect(terminal[0].revision).toBe(1)
    // The interval is 500 ms, so this window holds several more periodic passes. A second publication, or
    // a changed record, would show up here: the first settled snapshot alone is not enough.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const later = await control('evidence')
    const laterTerminal = later.publications.filter((r) => r.value.event.type === 'delegation.completed')
    expect(laterTerminal).toHaveLength(1)
    expect(laterTerminal[0].revision).toBe(1)
    expect(laterTerminal[0]).toEqual(terminal[0])
  }, 120000)
})
