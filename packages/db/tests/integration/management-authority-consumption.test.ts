import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  claimManagementAuthorityDecision,
  completeManagementAuthorityDecision,
  type ManagementAuthorityClaimInput,
} from '../../src/management-authority-consumption'
import { createWorkspaceWithOwner } from '../../src/workspaces'

function claimInput(workspaceId: string, decisionId = randomUUID()): ManagementAuthorityClaimInput {
  return {
    actionDigest: `sha256:${'a'.repeat(64)}`,
    authorityRef: 'authority-1',
    authorityRevision: 7,
    decisionId,
    inputDigest: `sha256:${'b'.repeat(64)}`,
    operation: 'project.update',
    targetDigest: `sha256:${'c'.repeat(64)}`,
    targetId: randomUUID(),
    workspaceId,
  }
}

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('management authority durable consumption (#1215)', () => {
  let first: DatabaseConnection
  let second: DatabaseConnection

  beforeAll(() => {
    first = createDatabase(connectionUrl!)
    second = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await first.close()
    await second.close()
  })

  async function fixture(): Promise<string> {
    const temporary = await createTemporaryUserSession(first.db, {
      credentialDigest: `digest-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(first.db, {
      idempotencyKey: `management-${crypto.randomUUID()}`,
      name: 'Management claim fixture',
      owner: temporary.principal,
    })
    return workspace.id
  }

  test('two processes claim one decision exactly once; replay and restart refuse duplicates', async () => {
    const workspaceId = await fixture()
    const input = claimInput(workspaceId)

    const owner = await claimManagementAuthorityDecision(first.db, input)
    expect(owner).toEqual({ state: 'claimed' })

    const concurrent = await claimManagementAuthorityDecision(second.db, input)
    expect(concurrent).toEqual({ priorState: 'claimed', state: 'recovery_required' })

    expect(
      await completeManagementAuthorityDecision(first.db, input.decisionId, {
        resultDigest: `sha256:${'d'.repeat(64)}`,
        state: 'succeeded',
      })
    ).toBe(true)

    const replay = await claimManagementAuthorityDecision(second.db, input)
    expect(replay).toEqual({
      resultDigest: `sha256:${'d'.repeat(64)}`,
      state: 'replayed',
    })

    // Cold restart: a fresh connection still sees the retained claim.
    const restarted = createDatabase(connectionUrl!)
    try {
      expect(await claimManagementAuthorityDecision(restarted.db, input)).toEqual({
        resultDigest: `sha256:${'d'.repeat(64)}`,
        state: 'replayed',
      })
    } finally {
      await restarted.close()
    }
  })

  test('the same decision id can never name a second call or a second effect', async () => {
    const workspaceId = await fixture()
    const input = claimInput(workspaceId)
    await claimManagementAuthorityDecision(first.db, input)

    const changedCall = {
      ...input,
      inputDigest: `sha256:${'e'.repeat(64)}`,
    }
    expect(await claimManagementAuthorityDecision(second.db, changedCall)).toEqual({
      priorState: 'claimed',
      state: 'recovery_required',
    })
    expect(
      await completeManagementAuthorityDecision(first.db, input.decisionId, {
        state: 'failed',
        failureCode: 'unavailable',
      })
    ).toBe(true)
    expect(await claimManagementAuthorityDecision(second.db, changedCall)).toEqual({
      priorState: 'failed',
      state: 'recovery_required',
    })
    // A second completion cannot transition the retained failed row.
    expect(
      await completeManagementAuthorityDecision(first.db, input.decisionId, {
        state: 'succeeded',
        resultDigest: null,
      })
    ).toBe(false)
  })

  test('an interrupted claim never executes a second effect and can be reconciled once', async () => {
    const workspaceId = await fixture()
    const input = claimInput(workspaceId)
    await claimManagementAuthorityDecision(first.db, input)
    // A crashed worker leaves the row `claimed`; the next delivery is refused
    // and never executes the effect a second time.
    expect(await claimManagementAuthorityDecision(second.db, input)).toEqual({
      priorState: 'claimed',
      state: 'recovery_required',
    })
    // Operator reconciliation retains the interrupted claim exactly once.
    expect(
      await completeManagementAuthorityDecision(second.db, input.decisionId, {
        state: 'succeeded',
        resultDigest: null,
      })
    ).toBe(true)
    expect(await claimManagementAuthorityDecision(second.db, input)).toEqual({
      resultDigest: null,
      state: 'replayed',
    })
    expect(
      await completeManagementAuthorityDecision(second.db, input.decisionId, {
        state: 'failed',
        failureCode: 'unavailable',
      })
    ).toBe(false)
  })
})
