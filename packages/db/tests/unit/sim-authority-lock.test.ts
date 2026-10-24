import { describe, expect, test } from 'bun:test'

import { lockSimAuthorityEnd, lockSimIssuance } from '../../src/sim-authority-lock'
import { recordingDatabase, type Entry } from '../fixtures/recording-database'

// The lock orders launch-code issuance against the sweeps that end a workspace's Sim authority.
// A recording transaction shows which advisory lock each side asks for and what key it uses; that
// the lock really makes a sweep wait for an in-flight issuance is proved against PostgreSQL in the
// integration suite.
const executed = (log: Entry[]) =>
  log.filter((entry): entry is Extract<Entry, { op: 'execute' }> => entry.op === 'execute')

const asTransaction = (database: unknown) => database as Parameters<typeof lockSimIssuance>[0]

describe('the Sim authority lock', () => {
  test('issuance takes the shared advisory lock and a sweep takes the exclusive one', async () => {
    const { database, log } = recordingDatabase()
    await lockSimIssuance(asTransaction(database), 'workspace-one')
    await lockSimAuthorityEnd(asTransaction(database), 'workspace-one')

    const [issuance, sweep] = executed(log)
    expect(issuance!.sql).toBe('select pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))')
    expect(sweep!.sql).toBe('select pg_advisory_xact_lock(hashtext($1), hashtext($2))')
  })

  test('both sides ask for the same key, so a sweep and an issuance of one workspace collide', async () => {
    const { database, log } = recordingDatabase()
    await lockSimIssuance(asTransaction(database), 'workspace-one')
    await lockSimAuthorityEnd(asTransaction(database), 'workspace-one')
    const [issuance, sweep] = executed(log)
    expect(issuance!.params).toEqual(['adea.sim-authority', 'workspace-one'])
    expect(sweep!.params).toEqual(issuance!.params)
  })

  test('the key folds the workspace identifier to lower case, matching how the sweeps compare', async () => {
    const { database, log } = recordingDatabase()
    const id = '8f0c6a52-45f1-4e0b-a8d2-7c1d6f4a9b10'
    await lockSimIssuance(asTransaction(database), id.toUpperCase())
    await lockSimIssuance(asTransaction(database), id)
    await lockSimAuthorityEnd(asTransaction(database), id.toUpperCase())
    await lockSimAuthorityEnd(asTransaction(database), id)
    const [issuanceUpper, issuanceLower, sweepUpper, sweepLower] = executed(log)
    expect(issuanceUpper!.params).toEqual(issuanceLower!.params)
    expect(sweepUpper!.params).toEqual(sweepLower!.params)
    expect(sweepUpper!.params).toEqual(issuanceLower!.params)
  })

  test('different workspaces take different keys', async () => {
    const { database, log } = recordingDatabase()
    await lockSimIssuance(asTransaction(database), 'workspace-one')
    await lockSimIssuance(asTransaction(database), 'workspace-two')
    const [one, two] = executed(log)
    expect(one!.params).not.toEqual(two!.params)
  })
})
