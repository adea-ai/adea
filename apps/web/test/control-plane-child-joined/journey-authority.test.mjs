// Opt-in joined proof for #1173: authority at the edges of the journey. A lead stop is not a child
// cancellation and an acknowledgement is not termination; publication rechecks CP's and Adea's
// authority late; a revoked audience receives no result. Adea's side runs as its own processes
// against the pinned CP revision. See README.md "Lead-to-child journey".
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startJourney, verifyJourneyPackages, finalText } from './journey-support.mjs'

const manifestPath = process.env.PI_FACTORY_MANIFEST
if (!manifestPath) throw new Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')
const verify = () => verifyJourneyPackages(manifestPath)
/** What counts as new CP work. Usage-ledger rows are excluded: CP settles them on its own schedule. */
const cpWork = (evidence) => {
  const { commands, executions, attempts, budgets } = evidence.canonical
  return {
    commands,
    executions,
    attempts,
    budgets,
    physicalSends: evidence.physicalSends,
    childStarts: evidence.childStarts,
  }
}
const eventTypes = (evidence) => evidence.publications.map((record) => record.value.event.type)

/** Runs prepare, dispatch and bind, leaving the lead released from its first provider gate. */
async function startLead(journey) {
  const { driver, control } = journey
  await driver('prepare')
  const dispatched = await driver('dispatch')
  await control('bind', { executionId: dispatched.result.executionId })
  await control('release', { name: 'lead-first' })
  return dispatched.result
}

describe('lead stop, child cancellation and physical termination', () => {
  let journey, control
  beforeAll(async () => {
    await verify()
    journey = await startJourney('1173 stop')
    control = journey.control
    // The lead's final answer and the child's provider request are both held in flight.
    for (const name of ['lead-first', 'child-send', 'lead-final']) await control('hold', { name })
  }, 90000)
  afterAll(async () => {
    await journey?.stop()
  }, 30000)

  test('with the lead and its child in flight, a lead stop retried from a new process is one CP stop', async () => {
    await startLead(journey)
    const inflight = await journey.waitFor(
      () => control('evidence'),
      (e) => e.childSends === 1 && e.leadSends === 2,
      'lead final and child request held'
    )
    expect(inflight.lead.state).toBe('running')
    expect(inflight.child.state).toBe('running')
    expect(inflight.delegations.map((d) => d.state)).toEqual(['dispatched'])
    const before = cpWork(inflight)

    // CP holds this stop open while the lead's provider call is in flight, so the first reply may be
    // lost to a client timeout. Either way Adea has durably recorded that a stop was requested.
    const first = await journey.driver('cancel')
    expect(first.exitCode).toBe(0)
    expect(first.result.cancelRequestedAt).toBeTruthy()
    // The same stop from a new process repeats the first request's issuedAt: CP accepts it as the
    // same command instead of rejecting a conflicting one.
    const second = await journey.driver('cancel')
    expect(second.exitCode).toBe(0)
    expect(second.result.reasonCode).toBeUndefined()
    expect(second.result.state).toBe('cancelling')
    expect(second.result.cancelRequestedAt).toBe(first.result.cancelRequestedAt)
    const row = await journey.runtimeRow()
    expect(row.cancelRequestedAt.toISOString()).toBe(first.result.cancelRequestedAt)
    const after = await control('evidence')
    expect(cpWork(after)).toEqual(before)
    expect(after.lead.state).toBe('cancelling')
  }, 120000)

  test('the lead stop does not cancel the child, and nothing is published', async () => {
    const evidence = await control('evidence')
    // Lead-stop never cascades: the child and CP's delegation record are untouched.
    expect(evidence.child.state).toBe('running')
    // CP moves the record from dispatched to running when its progress scan next reads the child.
    expect(['dispatched', 'running']).toContain(evidence.delegations[0].state)
    expect(evidence.delegations).toHaveLength(1)
    expect(eventTypes(evidence)).not.toContain('delegation.cancelled')
    expect(evidence.childSends).toBe(1)
    const status = await journey.driver('status')
    expect(status.result.state).toBe('cancelling')
    expect(status.result.publishedMessageId).toBeUndefined()
    expect(await journey.publishedMessages()).toHaveLength(0)
  }, 60000)

  test('an acknowledged stop is not termination: the lead stays cancelling after its provider call is released', async () => {
    await control('release', { name: 'lead-final' })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const evidence = await control('evidence')
    // CP still reports the lead as cancelling; Adea shows the same and never invents "cancelled".
    expect(evidence.lead.state).toBe('cancelling')
    const status = await journey.driver('status')
    expect(status.result.state).toBe('cancelling')
    expect(await journey.publishedMessages()).toHaveLength(0)
  }, 60000)

  test('child cancellation is a separate CP-only control; its record is not the child native session ending', async () => {
    // Adea exposes no child-cancel operation and the public lead contract has none; this is CP's
    // host-side canonical stop, used here only to show what an acknowledgement does and does not prove.
    const cancelled = await control('cancel-children')
    expect(cancelled.cancelled).toHaveLength(1)
    const acknowledged = await control('evidence')
    expect(acknowledged.delegations.map((d) => d.state)).toEqual(['cancelled'])
    expect(eventTypes(acknowledged)).toContain('delegation.cancelled')
    // The record says cancelled; the child's native session was still running, with its provider
    // request still in flight.
    expect(acknowledged.child.state).toBe('running')
    await control('release', { name: 'child-send' })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const released = await control('evidence')
    // After the request ends, CP can no longer say what the child did: unknown, not cancelled.
    expect(released.child.state).toBe('unknown')
    expect(released.childSends).toBe(1)
    expect(released.childStarts).toBe(1)
    // No child outcome and no lead result reached the timeline.
    await control('scan')
    expect(
      eventTypes(await control('evidence')).filter((t) => t === 'delegation.completed')
    ).toEqual([])
    expect(await journey.driver('status')).toMatchObject({ result: { state: 'cancelling' } })
    expect(await journey.publishedMessages()).toHaveLength(0)
  }, 60000)
})

describe('late publication rechecks CP authority', () => {
  let journey, control
  beforeAll(async () => {
    await verify()
    journey = await startJourney('1173 publication')
    control = journey.control
    await control('hold', { name: 'lead-first' })
  }, 90000)
  afterAll(async () => {
    await journey?.stop()
  }, 30000)

  test('a result whose CP publication authority was withdrawn is withheld, then published once when restored', async () => {
    const lead = await startLead(journey)
    await journey.waitFor(
      () => control('evidence'),
      (e) => e.lead?.state === 'completed' && e.child?.state === 'completed',
      'lead and child completed'
    )
    await control('revoke-publication', { value: true })
    const before = await control('evidence')
    const withheld = await journey.driver('status')
    expect(withheld.exitCode).toBe(0)
    expect(withheld.result.reasonCode).toBe('PUBLICATION_WITHHELD')
    expect(withheld.result.publishedMessageId).toBeUndefined()
    expect(await journey.publishedMessages()).toHaveLength(0)
    const row = await journey.runtimeRow()
    expect(row).toMatchObject({ state: 'completed', publishedMessageId: null })
    // CP was asked, inside the publication transaction, and said no.
    expect((await control('evidence')).publicationChecks).toBe(before.publicationChecks + 1)

    await control('revoke-publication', { value: false })
    const published = await journey.driver('status')
    expect(published.result.reasonCode).toBeUndefined()
    expect(published.result.state).toBe('completed')
    const [message] = await journey.publishedMessages()
    expect(message.bodyText).toBe(finalText)
    expect(message.executionRef).toBe(lead.executionId)
    expect(published.result.publishedMessageId).toBe(message.id)
    const repeat = await journey.driver('status')
    expect(repeat.result.publishedMessageId).toBe(message.id)
    expect(await journey.publishedMessages()).toHaveLength(1)
  }, 120000)

  test('a stop pressed after completion is refused by CP and changes neither the result nor the child', async () => {
    const messages = await journey.channelMessages()
    const before = await control('evidence')
    const stop = await journey.driver('cancel')
    expect(stop.exitCode).toBe(0)
    expect(stop.result.reasonCode).toBe('RUNTIME_UNAVAILABLE')
    expect(stop.result.state).toBe('completed')
    expect(stop.result.publishedMessageId).toBeTruthy()
    const after = await control('evidence')
    expect(after.canonical).toEqual(before.canonical)
    expect(after.delegations).toEqual(before.delegations)
    expect(after.child).toEqual(before.child)
    expect(await journey.channelMessages()).toEqual(messages)
  }, 60000)
})

describe('a revoked audience receives no result', () => {
  let journey, control
  beforeAll(async () => {
    await verify()
    journey = await startJourney('1173 audience')
    control = journey.control
    await control('hold', { name: 'lead-first' })
  }, 90000)
  afterAll(async () => {
    await journey?.stop()
  }, 30000)

  test('membership revoked after the terminal read and before publication withholds the result', async () => {
    await startLead(journey)
    await journey.waitFor(
      () => control('evidence'),
      (e) => e.lead?.state === 'completed' && e.child?.state === 'completed',
      'lead and child completed'
    )
    // Usage settlement lands shortly after the terminal states; compare against the settled ledger.
    const before = await journey.settled(() => control('evidence'))
    const messages = await journey.channelMessages()
    // CP's own authority is current throughout; only Adea's audience changes, inside the status read.
    const withheld = await journey.driver('status', { fault: 'revoke-audience-before-publication' })
    // Adea refuses the whole read at its next audience check (the observation's authorization), so
    // there is no projection at all, let alone a result: the route sees a generic unavailable error.
    expect(withheld.exitCode).not.toBe(0)
    expect(withheld.result).toBeUndefined()
    expect(withheld.stderr).toContain('Lead turn unavailable')
    expect(withheld.stderr).not.toContain(finalText.trim())
    expect(await journey.publishedMessages()).toHaveLength(0)
    expect(await journey.channelMessages()).toEqual(messages)
    expect((await journey.runtimeRow()).publishedMessageId).toBeNull()
    // Adea refused on its own audience; CP's publication authority was never the deciding input.
    expect((await control('evidence')).publicationChecks).toBe(before.publicationChecks)
  }, 120000)

  test('the revoked member gets nothing from later reads or retries, and CP sees no new work', async () => {
    const before = await journey.settled(() => control('evidence'))
    const messages = await journey.channelMessages()
    for (const command of ['status', 'snapshot', 'progress', 'dispatch', 'cancel']) {
      const read = await journey.driver(command)
      // Refused outright: no projection, no result text, no published message id.
      expect(read.exitCode).not.toBe(0)
      expect(read.result).toBeUndefined()
      expect(read.stderr).toContain('Lead turn unavailable')
    }
    const after = await control('evidence')
    expect(cpWork(after)).toEqual(cpWork(before))
    expect(await journey.channelMessages()).toEqual(messages)
    expect(await journey.publishedMessages()).toHaveLength(0)
  }, 120000)
})
