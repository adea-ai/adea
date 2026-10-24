// Opt-in joined proof for #1173: one workspace lead, one direct topic, one pinned BYO selection, one
// real Pi child and one logical outcome, through Adea's real product and the installed SDK, against
// the pinned CP revision (source-journey.json). See README.md "Lead-to-child journey".
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  startJourney,
  verifyJourneyPackages,
  finalText,
  childText,
  leadAndChildCompletedWaitMs,
} from './journey-support.mjs'

const manifestPath = process.env.PI_FACTORY_MANIFEST
if (!manifestPath) throw new Error('VERIFIED_CANDIDATE_MANIFEST_REQUIRED')

describe('happy journey and exactly-once replays', () => {
  let journey, control, lead, firstEvidence
  beforeAll(async () => {
    // Package and source identity are verified before any database connection is opened.
    await verifyJourneyPackages(manifestPath)
    journey = await startJourney('1173 journey')
    control = journey.control
  }, 90000)
  afterAll(async () => {
    await journey?.stop()
  }, 30000)

  test('an accepted lead message alone starts nothing and status reads grant no authority', async () => {
    const { harness, driver } = journey
    expect(await journey.intents()).toHaveLength(1)
    expect((await journey.channelMessages()).map((m) => m.bodyText)).toEqual([
      'Explicit lead and child roles',
    ])
    const before = await control('evidence')
    // Reads in separate processes: snapshot, status and progress. None may admit, start or send.
    for (const command of ['snapshot', 'status', 'progress']) {
      const read = await driver(command)
      expect(read.exitCode).toBe(0)
      expect(read.result.leadTurn?.state ?? read.result.state).toBe('blocked')
    }
    expect(await journey.runtimeRow()).toBeUndefined()
    const after = await control('evidence')
    expect(after.canonical).toEqual(before.canonical)
    expect(after.canonical).toMatchObject({ commands: 0, executions: 0, attempts: 0, budgets: 0 })
    expect(after.physicalSends).toBe(0)
    expect(after.secretResolutions).toBe(0)
    expect(harness.productRequests()).toBe(after.productReads)
  }, 60000)

  test('prepare discloses the payer and starts no inference; its replay is the same preparation', async () => {
    const { driver } = journey
    await control('hold', { name: 'lead-first' })
    const prepared = await driver('prepare')
    expect(prepared.exitCode).toBe(0)
    expect(prepared.result.state).toBe('prepared')
    expect(prepared.result.selectionRef).toBe(
      journey.harness.choices.requestedModelSelections.lead.selectionRef
    )
    const evidence = await control('evidence')
    expect(evidence.canonical).toMatchObject({ executions: 1, attempts: 1, budgets: 1 })
    expect(evidence.physicalSends).toBe(0)
    expect(evidence.secretResolutions).toBe(0)
    // A second process asking again gets the same preparation, not a second execution.
    const again = await driver('prepare')
    // CP itself accepts the replay (a refused one would surface as RUNTIME_UNAVAILABLE over the
    // stored row), because the retried command repeats the first attempt's issuedAt.
    expect(again.result.reasonCode).toBeUndefined()
    expect(again.result.preparationRef).toBe(prepared.result.preparationRef)
    expect(again.result.executionId).toBe(prepared.result.executionId)
    expect((await control('evidence')).canonical).toEqual(evidence.canonical)
  }, 60000)

  test('dispatch runs the lead once; the child is allocated, funded and started once', async () => {
    const { driver } = journey
    const dispatched = await driver('dispatch')
    expect(dispatched.exitCode).toBe(0)
    expect(['starting', 'running']).toContain(dispatched.result.state)
    expect(dispatched.result.reasonCode).toBeUndefined()
    lead = dispatched.result
    expect(lead.executionId).toBeTruthy()
    expect(lead.attemptId).toBeTruthy()
    expect(lead.runtimeSessionId).toBeTruthy()
    // The lead may delegate only after the host is bound to the SDK-dispatched execution.
    await control('bind', { executionId: lead.executionId })
    await control('release', { name: 'lead-first' })
    firstEvidence = await journey.waitFor(
      () => control('evidence'),
      (e) => e.lead?.state === 'completed' && e.child?.state === 'completed',
      'lead and child completed',
      leadAndChildCompletedWaitMs
    )
    expect(firstEvidence.leadSends).toBe(2)
    expect(firstEvidence.childSends).toBe(1)
    expect(firstEvidence.physicalSends).toBe(3)
    expect(firstEvidence.policyDecisions).toBe(1)
    expect(firstEvidence.executorCalls).toBe(1)
    expect(firstEvidence.childStarts).toBe(1)
    expect(firstEvidence.fundingWrites).toBe(1)
    expect(firstEvidence.canonical).toMatchObject({ executions: 2, attempts: 2, budgets: 2 })
  }, 90000)

  test('the lead status read publishes the exact answer to the timeline once, with the identity chain intact', async () => {
    const { driver } = journey
    const status = await driver('status')
    expect(status.exitCode).toBe(0)
    expect(status.result.state).toBe('completed')
    expect(status.result.publishedMessageId).toBeTruthy()
    const published = await journey.publishedMessages()
    expect(published).toHaveLength(1)
    const [message] = published
    // Exact UTF-8 bytes including the trailing newline; sender is the workspace lead.
    expect(message.bodyText).toBe(finalText)
    expect(message.senderKind).toBe('agent')
    expect(message.senderAgentId).toBe(journey.harness.lead.id)
    expect(message.id).toBe(status.result.publishedMessageId)
    expect(message.idempotencyKey).toBe(`lead-result:${journey.config.intentId}`)
    // Intent -> execution/attempt/native session in Adea, then CP's own records, then the child.
    const row = await journey.runtimeRow()
    expect(row).toMatchObject({
      state: 'completed',
      executionId: lead.executionId,
      attemptId: lead.attemptId,
      runtimeSessionId: lead.runtimeSessionId,
      dispatchId: lead.dispatchId,
      publishedMessageId: message.id,
    })
    expect(message.executionRef).toBe(row.executionId)
    expect(message.externalSessionRef).toBe(row.runtimeSessionId)
    const evidence = await control('evidence')
    expect(evidence.lead).toMatchObject({
      executionId: lead.executionId,
      attemptId: lead.attemptId,
      externalSessionId: lead.runtimeSessionId,
    })
    expect(evidence.delegations).toHaveLength(1)
    const [delegation] = evidence.delegations
    expect(delegation).toMatchObject({
      parentExecutionId: lead.executionId,
      parentAttemptId: lead.attemptId,
      // CP's canonical delegation record moves only when its progress scan reads the terminal
      // child; the scan is a separate CP step, taken in the next test.
      cancellation: 'cascade',
    })
    expect(['dispatched', 'running']).toContain(delegation.state)
    expect(evidence.child).toMatchObject({
      executionId: delegation.childExecutionId,
      attemptId: delegation.childAttemptId,
      state: 'completed',
      outcome: 'completed',
      text: childText,
    })
    // The child is its own native session, mapped from the admitted tool call.
    expect(evidence.toolCall).toMatchObject({
      status: 'succeeded',
      output: {
        delegationId: delegation.delegationId,
        childExecutionId: delegation.childExecutionId,
        childAttemptId: delegation.childAttemptId,
        externalSessionId: evidence.child.externalSessionId,
      },
    })
    expect(evidence.child.externalSessionId).not.toBe(lead.runtimeSessionId)
    expect(evidence.childStartKeys).toEqual([
      `delegation:${delegation.delegationId}:attempt:${delegation.childAttemptId}`,
    ])
    expect(evidence.reservations).toEqual([`runtime-attempt:${delegation.childAttemptId}`])
  }, 90000)

  test('the child outcome is published once by CP and replays change no durable row', async () => {
    const { driver } = journey
    const beforeScan = await control('evidence')
    expect(
      beforeScan.publications.filter((record) => record.value.event.type === 'delegation.completed')
    ).toHaveLength(0)
    // The terminal accounting receipt (cost state settled) is the baseline for the replays below.
    const evidence = await journey.accounted()
    expect(evidence.delegations[0].state).toBe('completed')
    const terminal = evidence.publications.filter(
      (record) => record.value.event.type === 'delegation.completed'
    )
    expect(terminal).toHaveLength(1)
    expect(terminal[0].revision).toBe(1)
    expect(terminal[0].value.event).toMatchObject({
      delegationId: evidence.delegations[0].delegationId,
      parentExecutionId: lead.executionId,
    })
    const messagesBefore = await journey.channelMessages()
    const rowBefore = await journey.runtimeRow()
    const repeats = []
    // Retried dispatch, repeated status reads and scans, and an in-process reopen of CP's
    // production composition. Adea's replays run in fresh processes.
    repeats.push(await driver('dispatch'))
    await control('scan')
    repeats.push(await driver('status'))
    await control('reopen')
    await control('scan')
    repeats.push(await driver('status'))
    for (const repeat of repeats) {
      expect(repeat.exitCode).toBe(0)
      expect(repeat.result.state).toBe('completed')
      expect(repeat.result.publishedMessageId).toBe(rowBefore.publishedMessageId)
    }
    const after = await control('evidence')
    expect(after.publications).toEqual(evidence.publications)
    // Settled-ledger idempotence: the full ledger (usage rows included) and the retained cost
    // state are unchanged by replays, scans and a CP reopen once the accounting receipt exists.
    expect(after.canonical).toEqual(evidence.canonical)
    expect(after.costState).toBe('settled')
    expect(after.costRevision).toBe(evidence.costRevision)
    expect(after.physicalSends).toBe(3)
    expect(after.childStarts).toBe(1)
    expect(after.reservations).toEqual(firstEvidence.reservations)
    expect(after.delegations).toEqual(evidence.delegations)
    expect(await journey.channelMessages()).toEqual(messagesBefore)
    expect(await journey.runtimeRow()).toEqual(rowBefore)
  }, 120000)

  test('an ordinary direct message in the same topic still creates no lead intent or CP work', async () => {
    const before = await control('evidence')
    const { harness, adea, connection } = journey
    const ordinary = await adea.createMessage(
      connection.db,
      harness.workspace.id,
      harness.topic.id,
      harness.owner.principal,
      {
        bodyText: 'Ordinary question',
        sender: harness.owner.principal,
        idempotencyKey: crypto.randomUUID(),
      }
    )
    expect(ordinary.bodyText).toBe('Ordinary question')
    expect(await journey.intents()).toHaveLength(1)
    const after = await control('evidence')
    expect(after.canonical).toEqual(before.canonical)
    expect(after.physicalSends).toBe(before.physicalSends)
  }, 30000)
})
