/**
 * #1222: a native-session inventory inside a cutover snapshot.
 *
 * The cutover rehearsal proves the database families. The runtime's own session
 * inventory is not a database family: `captureMigrationSnapshot` composes it from
 * an injected authoritative read (`nativeSessionInventory`), and without one the
 * domain stays unknown with `unsupported_family` — never an empty section.
 *
 * This qualification exercises that merged seam with a *synthetic* inventory: a
 * fake `listRuntimeSessions` that returns crafted sessions. It never reads a
 * user's native session file, never calls an installed capture, and never
 * contacts a runtime host. The synthetic source is the only evidence here, and
 * the cases say so in their names.
 *
 * The cases: a populated synthetic inventory compares identical before and
 * after; a changed inventory is a determinate drift rather than an unknown; and
 * a missing, denied, unavailable or out-of-scope inventory stays unknown with no
 * section at all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import {
  NativeSessionInventoryError,
  type NativeSessionInventoryScope,
  type NativeSessionInventorySession,
  type NativeSessionInventorySource,
} from '../../src/native-session-inventory'
import { DRIZZLE_DIR } from '../fixtures/cutover-rehearsal'

const OBSERVED_AT = '2026-01-05T00:00:00.000Z'
const SCRATCH_PREFIX = 'rehearsal_1222_native_'
const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'

function requireProvisioningUrl(): string {
  if (!provisioningUrl) {
    throw new Error(
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set. In CI this means the Docker capture provisioning did not run, and this qualification refuses to skip silently.'
    )
  }
  return provisioningUrl
}

function urlForDatabase(database: string): string {
  const url = new URL(requireProvisioningUrl())
  url.pathname = `/${database}`
  return url.toString()
}

function assertScratch(database: string): void {
  if (!database.startsWith(SCRATCH_PREFIX)) {
    throw new Error(
      `Refusing to create or drop "${database}": scratch names need ${SCRATCH_PREFIX}`
    )
  }
}

async function adminExecute(statement: string): Promise<void> {
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(statement)
  } finally {
    await admin.end()
  }
}

const SCOPE: NativeSessionInventoryScope = {
  accountId: 'acct_native_surface',
  runtimeNodeId: 'node_native_surface',
  workspaceId: 'wsp_native_surface',
}

const OUT_OF_SCOPE: NativeSessionInventoryScope = {
  accountId: 'acct_other',
  runtimeNodeId: 'node_other',
  workspaceId: 'wsp_other',
}

/** One crafted runtime session. Nothing here is read from a real host. */
function syntheticSession(
  overrides: Partial<NativeSessionInventorySession> = {}
): NativeSessionInventorySession {
  return {
    id: 'ses_native_one',
    scope: SCOPE,
    projectId: 'prj_native',
    worktreeId: 'wtr_native',
    lifecycle: 'active',
    archived: false,
    generation: 1,
    version: 3,
    agentProfileId: 'profile_native',
    agentProfileVersion: 2,
    harnessInstallationId: null,
    activeHarnessRunId: null,
    ...overrides,
  } as NativeSessionInventorySession
}

/** A synthetic authoritative read: one bounded page, no cursor, no host. */
function syntheticSource(
  sessions: readonly NativeSessionInventorySession[]
): NativeSessionInventorySource {
  return {
    authorizedScopes: [SCOPE],
    listRuntimeSessions: async (input) => {
      if (input.cursor) return { items: [] }
      return { items: sessions }
    },
  }
}

/** A synthetic read that fails the way an authenticated read can fail. */
function failingSource(kind: 'denied' | 'unavailable'): NativeSessionInventorySource {
  return {
    authorizedScopes: [SCOPE],
    listRuntimeSessions: async () => {
      throw new NativeSessionInventoryError(kind, `synthetic inventory ${kind}`)
    },
  }
}

/** A synthetic read that returns a record outside the scope it declared. */
function outOfScopeSource(): NativeSessionInventorySource {
  return {
    authorizedScopes: [SCOPE],
    listRuntimeSessions: async () => ({
      items: [syntheticSession({ scope: OUT_OF_SCOPE })],
    }),
  }
}

const identity = (snapshotId: string): MigrationSnapshotCaptureIdentityInput => ({
  capturedAt: new Date(OBSERVED_AT),
  rehearsalId: 'rehearsal-native-inventory-1222',
  snapshotId,
  source: 'integration',
})

let connection: DatabaseConnection | undefined
let scratch: string | undefined

async function capture(inventory: NativeSessionInventorySource | undefined, snapshotId: string) {
  if (!connection) throw new Error('the disposable capture database is not open')
  return captureMigrationSnapshot(connection.db, {
    identity: identity(snapshotId),
    requestedDomains: ['nativeSessions'],
    ...(inventory ? { nativeSessionInventory: inventory } : {}),
  })
}

describe.skipIf(!provisioningUrl && !inCi)(
  'migration snapshot: a synthetic native-session inventory',
  () => {
    beforeAll(async () => {
      requireProvisioningUrl()
      scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
      assertScratch(scratch)
      await adminExecute(`create database "${scratch}"`)
      connection = createDatabase(urlForDatabase(scratch))
      // The capture validates the live journal overlay, so the disposable
      // database carries the current schema.
      await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
    }, 300_000)

    afterAll(async () => {
      await connection?.close()
      if (scratch) {
        assertScratch(scratch)
        await adminExecute(`drop database if exists "${scratch}"`)
      }
    }, 60_000)

    test('a populated synthetic inventory compares identical before and after', async () => {
      const sessions = [syntheticSession(), syntheticSession({ id: 'ses_native_two', version: 1 })]
      const before = await capture(syntheticSource(sessions), 'before')
      const after = await capture(syntheticSource(sessions), 'after')
      expect(before.domains.find((domain) => domain.domain === 'nativeSessions')).toEqual({
        domain: 'nativeSessions',
        status: 'captured',
        unknownReason: null,
      })
      expect(before.document.sections.nativeSessions?.records.length).toBe(2)
      expect(after.document.sections.nativeSessions?.records.length).toBe(2)
      // The synthetic records are the only evidence: the session references are
      // the crafted ones, never a real runtime session.
      expect(
        before.document.sections.nativeSessions?.records
          .map((record) => record['sessionRef'])
          .toSorted()
      ).toEqual(['ses_native_one', 'ses_native_two'])
      const comparison = compareMigrationSnapshots({
        after: after.document,
        before: before.document,
      })
      expect(comparison.findings.filter((finding) => finding.family === 'nativeSessions')).toEqual(
        []
      )
    }, 300_000)

    test('a changed synthetic inventory is a determinate drift, not an unknown', async () => {
      const before = await capture(syntheticSource([syntheticSession()]), 'before')
      const after = await capture(
        syntheticSource([syntheticSession({ generation: 2, agentProfileVersion: 3 })]),
        'after'
      )
      const comparison = compareMigrationSnapshots({
        after: after.document,
        before: before.document,
      })
      const findings = comparison.findings.filter((finding) => finding.family === 'nativeSessions')
      // The runtime's own counters are attributes and the profile version is a
      // digest, so both are determinate drift.
      expect(findings.some((finding) => finding.findingClass === 'changed_attribute')).toBe(true)
      expect(findings.some((finding) => finding.findingClass === 'digest_drift')).toBe(true)
      expect(findings.some((finding) => finding.findingClass === 'unknown_domain')).toBe(false)
    }, 300_000)

    test('a missing synthetic inventory stays unknown and never becomes an empty section', async () => {
      const result = await capture(undefined, 'without-inventory')
      expect(result.domains.find((domain) => domain.domain === 'nativeSessions')).toEqual({
        domain: 'nativeSessions',
        status: 'unknown',
        unknownReason: 'unsupported_family',
      })
      expect(result.document.sections.nativeSessions).toBeUndefined()
    }, 300_000)

    test('a failed or out-of-scope synthetic inventory stays unknown', async () => {
      for (const source of [
        failingSource('denied'),
        failingSource('unavailable'),
        outOfScopeSource(),
      ]) {
        const result = await capture(source, 'failing-inventory')
        expect(result.domains.find((domain) => domain.domain === 'nativeSessions')).toEqual({
          domain: 'nativeSessions',
          status: 'unknown',
          unknownReason: 'inventory_error',
        })
        expect(result.document.sections.nativeSessions).toBeUndefined()
      }
    }, 300_000)
  }
)
