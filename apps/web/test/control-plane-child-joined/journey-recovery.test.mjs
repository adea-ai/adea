// Opt-in joined proof for #1173: failures at the message->dispatch, child acceptance, terminal
// receipt and publication boundaries. Adea's side runs as its own OS process and is SIGKILLed at
// each boundary, so every recovery starts a new process that has only PostgreSQL and the CP control
// API to go on. CP's side is reopened in-process only (its fixture cannot reopen a composition in a
// new process), which is said wherever it is used. See README.md "Lead-to-child journey".
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startJourney, verifyJourneyPackages, finalText } from './journey-support.mjs'

const manifestPath = process.env.PI_FACTORY_MANIFEST
if (!manifestPath) throw new Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')

const publicationIds = (evidence) => evidence.publications.map((record) => record.id)
const publicationTypes = (evidence) =>
  evidence.publications.map((record) => record.value.event.type).toSorted()

// The binding a restart must re-read unchanged. A status read refreshes the observation timestamps, so
// those are left out; every identity and state column must still match.
const bindingOf = (row) =>
  Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'observedAt' && key !== 'updatedAt')
  )
// Releases both held provider replies and returns the first failure, so the caller decides how it counts.
const releaseHeldGates = async (control) => {
  let cleanupError
  for (const name of ['lead-final', 'child-send']) {
    await control('release', { name }).catch((error) => {
      cleanupError ??= error
    })
  }
  return cleanupError
}

describe('crash and restart recovery across the journey boundaries', () => {
  let journey, control, ids, finished
  beforeAll(async () => {
    await verifyJourneyPackages(manifestPath)
    journey = await startJourney('1173 recovery')
    control = journey.control
    await control('hold', { name: 'lead-first' })
  }, 90000)
  afterAll(async () => {
    await journey?.stop()
  }, 30000)

  test('a prepare whose reply is lost leaves one CP preparation and no Adea binding', async () => {
    const killed = await journey.driver('prepare', { fault: 'prepare-ack-lost' })
    expect(killed.killed).toBe(true)
    expect(killed.result).toBeUndefined()
    const evidence = await control('evidence')
    expect(evidence.canonical).toMatchObject({
      commands: 1,
      executions: 1,
      attempts: 1,
      budgets: 1,
    })
    expect(evidence.physicalSends).toBe(0)
    expect(await journey.runtimeRow()).toBeUndefined()
    // A restarted process prepares the same CP attempt: no second execution, command or budget.
    const retried = await journey.driver('prepare')
    expect(retried.exitCode).toBe(0)
    expect(retried.result.state).toBe('prepared')
    const after = await control('evidence')
    expect(after.canonical).toEqual(evidence.canonical)
    const row = await journey.runtimeRow()
    expect(row).toMatchObject({ state: 'prepared', dispatchId: null })
    ids = { executionId: row.executionId, attemptId: row.attemptId }
  }, 90000)

  test('a dispatch accepted by CP but lost to Adea is recovered by lookup without a second dispatch', async () => {
    const killed = await journey.driver('dispatch', { fault: 'dispatch-ack-lost' })
    expect(killed.killed).toBe(true)
    const pending = await journey.runtimeRow()
    expect(pending).toMatchObject({ state: 'dispatch_pending', dispatchId: null })
    // The host observes the lead only once it is bound to the SDK-dispatched execution.
    await control('bind', { executionId: ids.executionId })
    const during = await control('evidence')
    // Prepare accepts the one canonical command; dispatch binds to it and adds none.
    expect(during.canonical).toMatchObject({ commands: 1, executions: 1, attempts: 1 })
    expect(during.lead).toMatchObject(ids)
    // Held at the provider: the lead is running, it has made no model progress, nothing is published.
    expect(during.childStarts).toBe(0)
    expect(await journey.publishedMessages()).toHaveLength(0)

    // A new process knows only the pending marker. A read recovers the binding through CP's
    // lookup; it cannot dispatch, prepare or send.
    const recovered = await journey.driver('status')
    expect(recovered.exitCode).toBe(0)
    expect(['starting', 'running']).toContain(recovered.result.state)
    const row = await journey.runtimeRow()
    expect(row).toMatchObject(ids)
    expect(row.dispatchId).toMatch(/^dispatch_[a-f0-9]{32}$/)
    expect(row.runtimeSessionId).toBe(during.lead.externalSessionId)
    const after = await control('evidence')
    expect(after.canonical).toEqual(during.canonical)
    // A retried dispatch is the same CP dispatch.
    const retried = await journey.driver('dispatch')
    expect(retried.exitCode).toBe(0)
    expect((await journey.runtimeRow()).dispatchId).toBe(row.dispatchId)
    expect((await control('evidence')).canonical).toEqual(during.canonical)
  }, 120000)

  test('a process killed while the accepted child is in flight loses nothing; a restart reads the same binding', async () => {
    // The child's provider send is held so the acceptance is observable in flight, then the lead
    // is released to delegate. CP accepts and starts the child exactly once. The hold is released in
    // `finally`, so a failure in this test cannot leave the child stuck for the tests after it.
    // The lead's post-delegation request is held too, so the lead stays running while the child is in flight.
    await control('hold', { name: 'child-send' })
    await control('hold', { name: 'lead-final' })
    try {
      await control('release', { name: 'lead-first' })
      const accepted = await journey.waitFor(
        () => control('evidence'),
        // The child's physical request is recorded before its held send, and CP's start record and the
        // lead's post-delegation request can land in either order. Wait for all of them, so the counts
        // below are read after they arrive.
        (e) =>
          e.childStarts === 1 &&
          e.childSends === 1 &&
          e.leadSends === 2 &&
          e.delegations.length === 1 &&
          Boolean(e.child),
        'child accepted and started once'
      )
      expect(accepted.lead).toMatchObject(ids)
      expect(accepted.leadSends).toBe(2)
      expect(accepted.childSends).toBe(1)
      expect(accepted.canonical).toMatchObject({
        commands: 1,
        executions: 2,
        attempts: 2,
        budgets: 2,
      })
      expect(await journey.publishedMessages()).toHaveLength(0)
      const beforeKill = await journey.runtimeRow()
      expect(beforeKill.publishedMessageId).toBeNull()

      // The Adea process reads the accepted child and dies before storing the observation.
      const killed = await journey.driver('status', { fault: 'child-acceptance-lost' })
      expect(killed.killed).toBe(true)
      expect(killed.result).toBeUndefined()
      // Nothing durable moved: the same binding, no message, no extra CP work, one child start.
      expect(await journey.runtimeRow()).toEqual(beforeKill)
      expect(await journey.publishedMessages()).toHaveLength(0)
      expect(await journey.channelMessages()).toHaveLength(1)
      const afterKill = await control('evidence')
      expect(afterKill.canonical).toEqual(accepted.canonical)
      expect(afterKill.childStarts).toBe(1)
      expect(afterKill.physicalSends).toBe(accepted.physicalSends)
      // CP publishes the delegation's request and dispatch when the child is accepted. The kill adds
      // none, and nothing is published for completion yet.
      expect(publicationTypes(accepted)).toEqual(['delegation.dispatched', 'delegation.requested'])
      expect(publicationIds(afterKill)).toEqual(publicationIds(accepted))
      expect(publicationTypes(afterKill)).toEqual(publicationTypes(accepted))
      expect(publicationTypes(afterKill)).not.toContain('delegation.completed')

      // A restarted process re-reads the same binding without dispatching, preparing or sending.
      const recovered = await journey.driver('status')
      expect(recovered.exitCode).toBe(0)
      expect(['starting', 'running']).toContain(recovered.result.state)
      expect(bindingOf(await journey.runtimeRow())).toEqual(bindingOf(beforeKill))
      const afterRecover = await control('evidence')
      expect(afterRecover.canonical).toEqual(accepted.canonical)
      expect(afterRecover.childStarts).toBe(1)
      expect(afterRecover.physicalSends).toBe(accepted.physicalSends)
      expect(publicationIds(afterRecover)).toEqual(publicationIds(accepted))
      expect(publicationTypes(afterRecover)).not.toContain('delegation.completed')
    } catch (error) {
      // The original failure is kept; a cleanup error after it is reported, not thrown.
      const cleanupError = await releaseHeldGates(control)
      if (cleanupError)
        console.error(`held gate release failed after a test failure: ${cleanupError.message}`)
      throw error
    }
    const cleanupError = await releaseHeldGates(control)
    if (cleanupError) throw cleanupError
  }, 120000)

  test('the child is accepted once; a terminal receipt lost to Adea is read again after a restart', async () => {
    await control('release', { name: 'lead-first' })
    await journey.waitFor(
      () => control('evidence'),
      (e) => e.lead?.state === 'completed' && e.child?.state === 'completed',
      'lead and child completed'
    )
    // CP settles on its own recovery interval; the baseline is the terminal accounting receipt.
    finished = await journey.accounted()
    expect(finished.leadSends).toBe(2)
    expect(finished.childSends).toBe(1)
    expect(finished.childStarts).toBe(1)
    expect(finished.reservations).toHaveLength(1)
    // The completed receipt reaches the Adea process and the process dies before storing it.
    const killed = await journey.driver('status', { fault: 'terminal-receipt-lost' })
    expect(killed.killed).toBe(true)
    const row = await journey.runtimeRow()
    expect(['starting', 'running', 'dispatch_pending']).toContain(row.state)
    expect(row.publishedMessageId).toBeNull()
    expect(await journey.publishedMessages()).toHaveLength(0)

    // CP reopens its production composition in-process (not an OS-process restart) and scans.
    await control('reopen')
    await control('scan')
    const reopened = await control('evidence')
    expect(reopened.lead.state).toBe('completed')
    expect(reopened.child.state).toBe('completed')
    for (const key of ['physicalSends', 'childStarts', 'canonical', 'reservations'])
      expect(reopened[key]).toEqual(finished[key])
    expect(reopened.costState).toBe('settled')
    expect(reopened.costRevision).toBe(finished.costRevision)
    expect(reopened.delegations).toHaveLength(1)
    expect(reopened.delegations[0].state).toBe('completed')
  }, 120000)

  test('a process killed inside the publication transaction publishes nothing', async () => {
    const killed = await journey.driver('status', { fault: 'publication-in-transaction' })
    expect(killed.killed).toBe(true)
    // The terminal observation was committed before publication began; the message was not.
    const row = await journey.runtimeRow()
    expect(row).toMatchObject({ state: 'completed', publishedMessageId: null })
    expect(row.publicationDigest).toBeNull()
    expect(await journey.publishedMessages()).toHaveLength(0)
    expect((await journey.channelMessages()).length).toBe(1)
  }, 90000)

  test('a process killed after the publication committed repeats the same message, not another', async () => {
    const killed = await journey.driver('status', { fault: 'reply-lost' })
    expect(killed.killed).toBe(true)
    const published = await journey.publishedMessages()
    expect(published).toHaveLength(1)
    const [message] = published
    expect(message.bodyText).toBe(finalText)
    const beforeRow = await journey.runtimeRow()
    expect(beforeRow.publishedMessageId).toBe(message.id)

    const messages = await journey.channelMessages()
    for (let attempt = 0; attempt < 2; attempt++) {
      const repeat = await journey.driver('status')
      expect(repeat.exitCode).toBe(0)
      expect(repeat.result.state).toBe('completed')
      expect(repeat.result.publishedMessageId).toBe(message.id)
    }
    expect((await journey.driver('dispatch')).result.publishedMessageId).toBe(message.id)
    // Same rows, same bytes, same digest.
    expect(await journey.channelMessages()).toEqual(messages)
    expect(await journey.runtimeRow()).toEqual(beforeRow)
  }, 120000)

  test('counters: one accepted command pair, one lead, one child, one start, one send each', async () => {
    await control('scan')
    await control('scan')
    const evidence = await journey.accounted()
    // Settled-ledger idempotence across the whole recovery chain: crashes, restarts, reopen and
    // repeated reads leave the ledger and the retained cost state exactly as the receipt had them.
    expect(evidence.canonical).toEqual(finished.canonical)
    expect(evidence.costRevision).toBe(finished.costRevision)
    expect(evidence.reservations).toEqual(finished.reservations)
    expect(evidence.canonical).toMatchObject({
      commands: 1,
      executions: 2,
      attempts: 2,
      budgets: 2,
    })
    expect(evidence.leadSends).toBe(2)
    expect(evidence.childSends).toBe(1)
    expect(evidence.physicalSends).toBe(3)
    expect(evidence.childStarts).toBe(1)
    expect(evidence.executorCalls).toBe(1)
    expect(evidence.fundingWrites).toBe(1)
    expect(evidence.delegations).toHaveLength(1)
    expect(
      evidence.publications.filter((record) => record.value.event.type === 'delegation.completed')
    ).toHaveLength(1)
    expect(await journey.intents()).toHaveLength(1)
    expect(await journey.publishedMessages()).toHaveLength(1)
  }, 60000)
})
