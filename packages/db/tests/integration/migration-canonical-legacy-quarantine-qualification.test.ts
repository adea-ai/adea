import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { createAgent } from '../../src/agents'
import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
} from '../../src/migration-snapshot-capture'
import * as schema from '../../src/schema'
import { channelParticipants } from '../../src/schema'
import {
  createCanonicalDatabase,
  canonicalUrl,
  MIGRATION_ROLE,
  RUNTIME_ROLE,
} from '../fixtures/canonical-boundary'
import { canonicalChainFolders } from '../fixtures/canonical-chain'
import { DRIZZLE_DIR, migrationsFolderBefore } from '../fixtures/cutover-rehearsal'
import {
  insertLegacyMessage,
  insertLegacyReadState,
  seedLegacyAudience,
  type LegacyAudienceSeed,
} from '../fixtures/legacy-audience-seed'

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const SCRATCH_PREFIX = 'rehearsal_1222qual_'
const REPORT_EVENT_TABLE = 'app.quarantine_qualification_events'
const LOCK_KEY = '(12221222, 58)'
const MIGRATION_APP = 'adea_1222_qualification_migrator'
const RESTORE_APP = 'adea_1222_qualification_restore'
const PROBE_APP = 'adea_1222_qualification_lock_probe'
const OLD_WRITER_APP = 'adea_1222_qualification_old_writer'
const LOCK_ORDER_WRITER_APP = 'adea_1222_qualification_lock_order_writer'
const SOURCE_DOMAINS = [
  'channelParticipants',
  'groupAdmissions',
  'groupAudienceGrants',
  'groupEnlistmentGrants',
  'legacyAudienceQuarantine',
  'messages',
  'readState',
] as const
const EVIDENCE_TABLES = [
  'channel_participants',
  'group_admissions',
  'group_audience_grants',
  'group_enlistment_grants',
  'messages',
  'channel_read_states',
  'thread_read_states',
] as const
type EvidenceTable = (typeof EVIDENCE_TABLES)[number]
type TableEvidence = Readonly<{ count: number; digest: string }>
type Deferred = Readonly<{ promise: Promise<void>; resolve(): void }>
type LockWait = Readonly<{ pid: number; waitstart: Date | null }>
type LifecycleAgents = Readonly<{ active: string; archived: string; configurationError: string }>
type QueuedOutcome =
  | Readonly<{ kind: 'rows'; rows: readonly unknown[] }>
  | Readonly<{ kind: 'error'; message: string }>
type QualificationReport = Readonly<Record<string, unknown>>

const provisioned = !!provisioningUrl || inCi
const noOp = (): void => {}

function migrationEventSql(name: string): string {
  return `insert into ${REPORT_EVENT_TABLE} (name, recorded_at) values ('${name}', clock_timestamp());`
}

function deferred(): Deferred {
  let resolve = noOp
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function messageChain(error: unknown): string {
  const parts: string[] = []
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' | ')
}

function requireProvisioningUrl(): string {
  if (!provisioningUrl) {
    throw new Error(
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set; the qualification requires its disposable PostgreSQL fixture.'
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
      `Refusing to create or drop ${database}; names must start with ${SCRATCH_PREFIX}`
    )
  }
}

function identity(snapshotId: string): MigrationSnapshotCaptureIdentityInput {
  return {
    capturedAt: new Date('2026-10-15T00:00:00.000Z'),
    rehearsalId: 'migration-canonical-legacy-quarantine-qualification',
    snapshotId,
    source: 'integration',
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function tableEvidence(
  database: AgentHqDatabase,
  table: EvidenceTable
): Promise<TableEvidence> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local time zone 'UTC'`)
    const rows = (await tx.execute(
      sql.raw(`select to_jsonb(t)::text as row_json from app.${table} t order by to_jsonb(t)::text`)
    )) as unknown as readonly { row_json: string }[]
    return {
      count: rows.length,
      digest: sha256(rows.map((row) => row.row_json).join('\n')),
    }
  })
}

async function evidenceMatrix(
  database: AgentHqDatabase,
  includeQuarantine: boolean
): Promise<Readonly<Record<string, TableEvidence>>> {
  const tables = includeQuarantine
    ? [...EVIDENCE_TABLES, 'legacy_audience_quarantine' as const]
    : [...EVIDENCE_TABLES]
  const entries = await Promise.all(
    tables.map(async (table) => [table, await tableEvidence(database, table)] as const)
  )
  return Object.fromEntries(entries)
}

async function journalRows(database: AgentHqDatabase): Promise<readonly string[]> {
  const rows = (await database.execute(sql`
    select to_jsonb(m)::text as row_json from drizzle.__drizzle_migrations m order by m.id
  `)) as unknown as readonly { row_json: string }[]
  return rows.map((row) => row.row_json)
}

async function schemaState(database: AgentHqDatabase): Promise<Readonly<Record<string, unknown>>> {
  const [row] = (await database.execute(sql`
    select
      to_regclass('app.legacy_audience_quarantine')::text as quarantine_table,
      to_regprocedure('app.legacy_audience_withhold()')::text as withholding_function,
      to_regprocedure('app.legacy_audience_source_immutable()')::text as source_guard_function,
      to_regprocedure('app.legacy_audience_quarantine_guard()')::text as quarantine_guard_function,
      (select count(*)::int from pg_trigger where tgname in (
        'legacy_audience_withhold', 'legacy_audience_source_immutable',
        'legacy_audience_quarantine_guard', 'legacy_audience_quarantine_no_truncate'
      )) as trigger_count
  `)) as unknown as readonly Record<string, unknown>[]
  if (!row) throw new Error('schema-state query returned no row')
  return row
}

async function qualificationEvents(database: AgentHqDatabase) {
  const rows = (await database.execute(
    sql.raw(`
    select name, to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at
    from ${REPORT_EVENT_TABLE} order by recorded_at, name
  `)
  )) as unknown as readonly { name: string; recorded_at: string }[]
  return rows.map((row) => ({ name: row.name, recordedAt: new Date(row.recorded_at) }))
}

function copyMigrationFolder(
  source: string,
  name: string,
  transform0058: (contents: string) => string
): string {
  const target = mkdtempSync(join(tmpdir(), `${name}-`))
  mkdirSync(join(target, 'meta'), { recursive: true })
  for (const entry of readdirSync(source)) {
    if (entry.endsWith('.sql')) {
      const contents = readFileSync(join(source, entry), 'utf8')
      writeFileSync(
        join(target, entry),
        entry === '0058_legacy_audience_quarantine.sql' ? transform0058(contents) : contents
      )
    }
  }
  copyFileSync(join(source, 'meta', '_journal.json'), join(target, 'meta', '_journal.json'))
  return target
}

function instrument0058(contents: string, injectFailure: boolean): string {
  const lockMarker = '  IN SHARE ROW EXCLUSIVE MODE;\n--> statement-breakpoint'
  if (!contents.includes(lockMarker)) {
    throw new Error('0058 qualification lock marker was not found')
  }
  let instrumented = `${migrationEventSql('migration_started')}\n--> statement-breakpoint\n${contents}`
  instrumented = instrumented.replace(
    lockMarker,
    `${lockMarker}\n${migrationEventSql('locks_acquired')}\n--> statement-breakpoint\n${migrationEventSql('latch_enter')}\n--> statement-breakpoint\nSELECT pg_advisory_xact_lock${LOCK_KEY};\n--> statement-breakpoint\n${migrationEventSql('latch_exit')}\n--> statement-breakpoint`
  )
  instrumented += `\n--> statement-breakpoint\n${migrationEventSql('migration_before_commit')}`
  if (injectFailure) {
    instrumented += `\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION '1222 qualification injected failure'; END $$;`
  }
  return instrumented
}

async function waitForBlockedRelation(
  observer: postgres.Sql,
  applicationName: string,
  relation: string,
  signal?: AbortSignal
): Promise<LockWait> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('lock wait observation was cancelled')
    const [row] = (await observer.unsafe(
      `select a.pid, l.waitstart
       from pg_stat_activity a join pg_locks l on l.pid = a.pid
       where a.application_name = $1 and l.relation = $2::regclass and not l.granted
       order by l.waitstart limit 1`,
      [applicationName, `app.${relation}`]
    )) as unknown as readonly { pid: number; waitstart: Date | null }[]
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${applicationName} to queue on app.${relation}`)
}

async function waitForLockOrCompletion<T>(
  observer: postgres.Sql,
  applicationName: string,
  relation: string,
  pending: Promise<T>,
  description: string
): Promise<LockWait> {
  const controller = new AbortController()
  const lockWait = waitForBlockedRelation(
    observer,
    applicationName,
    relation,
    controller.signal
  ).then((lock) => ({ kind: 'blocked' as const, lock }))
  const completion = pending.then(
    (result) => ({ kind: 'completed' as const, result }),
    (error: unknown) => ({ kind: 'failed' as const, error })
  )
  const outcome = await Promise.race([lockWait, completion])
  if (outcome.kind === 'blocked') {
    controller.abort()
    return outcome.lock
  }
  controller.abort()
  await lockWait.catch(() => undefined)
  if (outcome.kind === 'failed') {
    throw new Error(
      `${description} failed before reaching the lock queue: ${String(outcome.error)}`
    )
  }
  throw new Error(`${description} completed before reaching the lock queue`)
}

async function waitForBlockedAdvisory(
  observer: postgres.Sql,
  applicationName: string
): Promise<number> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const [row] = (await observer.unsafe(
      `select a.pid
       from pg_stat_activity a join pg_locks l on l.pid = a.pid
       where a.application_name = $1 and l.locktype = 'advisory' and not l.granted
       limit 1`,
      [applicationName]
    )) as unknown as readonly { pid: number }[]
    if (row) return row.pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${applicationName} to queue on the test latch`)
}

async function addLifecycleAgents(
  migration: AgentHqDatabase,
  runtime: AgentHqDatabase,
  seed: LegacyAudienceSeed
): Promise<LifecycleAgents> {
  const create = (name: string) =>
    createAgent(runtime, seed.workspaceId, seed.owner, {
      name: `Quarantine qualification ${name} ${crypto.randomUUID()}`,
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
  const [active, archived, configurationError, archivedGroupAgent] = await Promise.all([
    create('active'),
    create('archived'),
    create('configuration-error'),
    create('archived-group'),
  ])
  await migration.execute(sql`
    update app.agents set lifecycle_state = 'archived'
    where id in (${archived.id}::uuid, ${archivedGroupAgent.id}::uuid)
  `)
  await migration.execute(sql`
    update app.agents set lifecycle_state = 'configuration_error'
    where id = ${configurationError.id}::uuid
  `)
  await migration.insert(channelParticipants).values([
    {
      agentId: active.id,
      channelId: seed.activeGroupId,
      principalKind: 'agent',
      workspaceId: seed.workspaceId,
    },
    {
      agentId: archived.id,
      channelId: seed.activeGroupId,
      principalKind: 'agent',
      workspaceId: seed.workspaceId,
    },
    {
      agentId: configurationError.id,
      channelId: seed.activeGroupId,
      principalKind: 'agent',
      workspaceId: seed.workspaceId,
    },
    {
      agentId: archivedGroupAgent.id,
      channelId: seed.archivedGroupId,
      principalKind: 'agent',
      workspaceId: seed.workspaceId,
    },
  ])
  return {
    active: active.id,
    archived: archived.id,
    configurationError: configurationError.id,
  }
}

async function capture(database: AgentHqDatabase, snapshotId: string) {
  return captureMigrationSnapshot(database, {
    identity: identity(snapshotId),
    requestedDomains: SOURCE_DOMAINS,
  })
}

async function runConcurrentCutover(input: {
  database: DatabaseConnection
  databaseName: string
  removedUserId: string
  workspaceId: string
  channelId: string
  participantId: string
  folder: string
}) {
  const migrationUrl = canonicalUrl(requireProvisioningUrl(), input.databaseName, MIGRATION_ROLE)
  const runtimeUrl = canonicalUrl(requireProvisioningUrl(), input.databaseName, RUNTIME_ROLE)
  const migrationClient = postgres(migrationUrl, {
    connection: { application_name: MIGRATION_APP },
    max: 1,
    onnotice: () => {},
  })
  const runtimeClient = postgres(runtimeUrl, {
    connection: { application_name: RESTORE_APP },
    max: 1,
    onnotice: () => {},
  })
  const oldWriter = postgres(migrationUrl, {
    connection: { application_name: OLD_WRITER_APP },
    max: 1,
    onnotice: () => {},
  })
  const latchClient = postgres(migrationUrl, { max: 1, onnotice: () => {} })
  const probeClient = postgres(migrationUrl, {
    connection: { application_name: PROBE_APP },
    max: 1,
    onnotice: () => {},
  })
  const observer = postgres(migrationUrl, { max: 1, onnotice: () => {} })
  const migrationDb = drizzle(migrationClient, { schema })
  const oldWriterReady = deferred()
  const releaseOldWriter = deferred()
  const latchReady = deferred()
  const releaseLatch = deferred()
  let migrationPromise: Promise<void> | undefined
  let oldWriterPromise: Promise<void> | undefined
  let latchPromise: Promise<void> | undefined
  let queuedAttemptPromise: Promise<QueuedOutcome> | undefined
  let probePromise: Promise<Readonly<{ requestedAt: Date; acquiredAt: Date }>> | undefined
  try {
    oldWriterPromise = oldWriter.begin(async (tx) => {
      await tx.unsafe(
        "update app.channel_participants set updated_at = updated_at + interval '1 microsecond' where id = $1::uuid",
        [input.participantId]
      )
      oldWriterReady.resolve()
      await releaseOldWriter.promise
    })
    await oldWriterReady.promise

    latchPromise = latchClient.begin(async (tx) => {
      await tx.unsafe(`select pg_advisory_xact_lock${LOCK_KEY}`)
      latchReady.resolve()
      await releaseLatch.promise
    })
    await latchReady.promise

    const startedAt = Date.now()
    migrationPromise = migrate(migrationDb, { migrationsFolder: input.folder })
    const oldWriterWait = await waitForBlockedRelation(
      observer,
      MIGRATION_APP,
      'channel_participants'
    )
    releaseOldWriter.resolve()
    await oldWriterPromise

    const migrationPid = await waitForBlockedAdvisory(observer, MIGRATION_APP)
    const duringSource = await tableEvidence(input.database.db, 'channel_participants')
    queuedAttemptPromise = runtimeClient
      .unsafe(
        `insert into app.group_admissions
        (workspace_id, channel_id, principal_kind, user_id, agent_id, joined_sequence, joined_at,
         auth_group_id, auth_grant_id, auth_revision)
       values ($1::uuid, $2::uuid, 'user', $3::uuid, null, 0, now(), $2::text,
         'qualification-queued-restore', 1)
       returning id`,
        [input.workspaceId, input.channelId, input.removedUserId]
      )
      .then(
        (rows) => ({ kind: 'rows' as const, rows: Array.from(rows) as readonly unknown[] }),
        (error: unknown) => ({ kind: 'error' as const, message: String(error) })
      )
    probePromise = probeClient.begin(async (tx) => {
      const [requested] = (await tx.unsafe(
        'select clock_timestamp() as captured_at'
      )) as unknown as {
        captured_at: Date
      }[]
      await tx.unsafe('lock table app.group_admissions in row exclusive mode')
      const [acquired] = (await tx.unsafe(
        'select clock_timestamp() as captured_at'
      )) as unknown as {
        captured_at: Date
      }[]
      if (!requested || !acquired) throw new Error('lock probe timestamp query returned no row')
      return { acquiredAt: acquired.captured_at, requestedAt: requested.captured_at }
    })
    const queuedWriterWait = await waitForLockOrCompletion(
      observer,
      RESTORE_APP,
      'group_admissions',
      queuedAttemptPromise,
      'queued authority restoration'
    )
    const probeWait = await waitForBlockedRelation(observer, PROBE_APP, 'group_admissions')
    const heldLocks = (await observer.unsafe(
      `select count(distinct c.relname)::int as count
       from pg_locks l join pg_class c on c.oid = l.relation
       join pg_namespace n on n.oid = c.relnamespace
       where l.pid = $1 and l.granted and l.mode = 'ShareRowExclusiveLock'
         and n.nspname = 'app'
         and c.relname = any($2::text[])`,
      [
        migrationPid,
        [
          'channels',
          'channel_participants',
          'workspace_memberships',
          'agents',
          'group_admissions',
          'group_audience_grants',
          'group_enlistment_grants',
        ],
      ]
    )) as unknown as readonly { count: number }[]
    if (Number(heldLocks[0]?.count) !== 7) {
      throw new Error(
        `migration reached its test latch with only ${heldLocks[0]?.count ?? 0}/7 locks`
      )
    }

    releaseLatch.resolve()
    await Promise.all([migrationPromise, queuedAttemptPromise, probePromise])
    await latchPromise
    const completedAt = Date.now()
    const events = await qualificationEvents(input.database.db)
    const byName = new Map(events.map((event) => [event.name, event.recordedAt]))
    const eventTime = (name: string) => {
      const value = byName.get(name)
      if (!value) throw new Error(`migration instrumentation did not record ${name}`)
      return value
    }
    const probeResult = await probePromise
    const queuedOutcome = await queuedAttemptPromise
    if (queuedOutcome.kind === 'error') {
      throw new Error(`queued authority restoration failed: ${queuedOutcome.message}`)
    }
    const queuedRows = queuedOutcome.rows
    const eventLockStart = eventTime('locks_acquired').getTime()
    const latchEnter = eventTime('latch_enter').getTime()
    const latchExit = eventTime('latch_exit').getTime()
    const latchHoldMs = latchExit - latchEnter
    const probeWaitMs = probeResult.acquiredAt.getTime() - probeResult.requestedAt.getTime()
    const latchOverlapMs = Math.max(
      0,
      Math.min(probeResult.acquiredAt.getTime(), latchExit) -
        Math.max(probeResult.requestedAt.getTime(), latchEnter)
    )
    const postLatchLockWaitMs = Math.max(0, probeWaitMs - latchOverlapMs)
    const lockWindowToClientReturnMs = completedAt - eventLockStart
    const preexistingWriterWaitMs =
      oldWriterWait.waitstart && byName.get('locks_acquired')
        ? eventLockStart - oldWriterWait.waitstart.getTime()
        : null
    const afterSource = await tableEvidence(input.database.db, 'channel_participants')
    const [restored] = (await input.database.db.execute(sql`
      select count(*)::int as count from app.group_admissions
      where workspace_id = ${input.workspaceId}::uuid and channel_id = ${input.channelId}::uuid
        and principal_kind = 'user' and user_id = ${input.removedUserId}::uuid
    `)) as unknown as readonly { count: number }[]
    return {
      duringSource,
      heldLocks: Number(heldLocks[0]?.count ?? 0),
      lockMetrics: {
        intentionalLatchHoldMs: latchHoldMs,
        intentionalLatchOverlapWithProbeMs: latchOverlapMs,
        lockWindowToMigrationReturnMs: lockWindowToClientReturnMs,
        lockWindowExcludingIntentionalLatchMs: Math.max(
          0,
          lockWindowToClientReturnMs - latchHoldMs
        ),
        migrationCallDurationMs: completedAt - startedAt,
        oldWriterLockWaitMs: preexistingWriterWaitMs,
        probeWaitExcludingIntentionalLatchMs: postLatchLockWaitMs,
        probeWaitIncludingLatchMs: probeWaitMs,
      },
      queuedRestorationRowsReturned: queuedRows.length,
      queuedRestorationWaitStartObserved: queuedWriterWait.waitstart !== null,
      sourceAfter: afterSource,
      sourceBeforeClassification: duringSource,
      sourcePreservedByMigration:
        afterSource.count === duringSource.count && afterSource.digest === duringSource.digest,
      restoredAdmissions: Number(restored?.count ?? -1),
      eventLockStart,
      lockProbePid: probeWait.pid,
    }
  } finally {
    releaseOldWriter.resolve()
    releaseLatch.resolve()
    await Promise.allSettled(
      [migrationPromise, oldWriterPromise, latchPromise, queuedAttemptPromise, probePromise].filter(
        (promise): promise is Promise<unknown> => promise !== undefined
      )
    )
    await Promise.all([
      observer.end(),
      probeClient.end(),
      latchClient.end(),
      oldWriter.end(),
      runtimeClient.end(),
      migrationClient.end(),
    ])
  }
}

async function runLockOrderDeadlock(input: {
  database: DatabaseConnection
  databaseName: string
  folder: string
}): Promise<Readonly<Record<string, unknown>>> {
  const before = await evidenceMatrix(input.database.db, false)
  const beforeJournal = await journalRows(input.database.db)
  const beforeDdl = await schemaState(input.database.db)
  const migrationUrl = canonicalUrl(requireProvisioningUrl(), input.databaseName, MIGRATION_ROLE)
  const writerUrl = canonicalUrl(requireProvisioningUrl(), input.databaseName, MIGRATION_ROLE)
  const migrationClient = postgres(migrationUrl, {
    connection: { application_name: MIGRATION_APP },
    max: 1,
    onnotice: () => {},
  })
  const writer = postgres(writerUrl, {
    connection: { application_name: LOCK_ORDER_WRITER_APP },
    max: 1,
    onnotice: () => {},
  })
  const observer = postgres(migrationUrl, { max: 1, onnotice: () => {} })
  const migrationDb = drizzle(migrationClient, { schema })
  const membershipLockReady = deferred()
  const requestChannelLock = deferred()
  let migrationPromise: Promise<void> | undefined
  let writerPromise: Promise<unknown> | undefined
  try {
    writerPromise = writer.begin(async (tx) => {
      await tx.unsafe('lock table app.workspace_memberships in row exclusive mode')
      membershipLockReady.resolve()
      await requestChannelLock.promise
      await tx.unsafe('lock table app.channels in row exclusive mode')
      return 'committed'
    })
    await membershipLockReady.promise

    migrationPromise = migrate(migrationDb, { migrationsFolder: input.folder })
    const migrationMembershipWait = await waitForBlockedRelation(
      observer,
      MIGRATION_APP,
      'workspace_memberships'
    )
    requestChannelLock.resolve()
    const writerChannelWait = await waitForBlockedRelation(
      observer,
      LOCK_ORDER_WRITER_APP,
      'channels'
    )

    const settle = async (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({
          status: 'rejected' as const,
          message: messageChain(error),
        })
      )
    let deadlockTimer: ReturnType<typeof setTimeout> | undefined
    let outcomes: Awaited<ReturnType<typeof settle>>[]
    try {
      outcomes = await Promise.race([
        Promise.all([settle(writerPromise), settle(migrationPromise)]),
        new Promise<never>((_, reject) => {
          deadlockTimer = setTimeout(
            () => reject(new Error('lock-order deadlock did not resolve within 15 seconds')),
            15_000
          )
        }),
      ])
    } finally {
      if (deadlockTimer) clearTimeout(deadlockTimer)
    }
    const resolvedAt = Date.now()
    const writerOutcome = outcomes[0]
    const migrationOutcome = outcomes[1]
    const writerMessage = writerOutcome.status === 'rejected' ? writerOutcome.message : 'committed'
    const migrationMessage =
      migrationOutcome.status === 'rejected' ? migrationOutcome.message : 'committed'
    const deadlockDetected = /deadlock detected/i.test(writerMessage + '\n' + migrationMessage)
    const migrationError = /deadlock detected/i.test(migrationMessage)
      ? 'deadlock detected'
      : migrationMessage
    const after = await evidenceMatrix(input.database.db, false)
    const afterJournal = await journalRows(input.database.db)
    const afterDdl = await schemaState(input.database.db)
    const [eventCount] = (await input.database.db.execute(
      sql.raw(`select count(*)::int as count from ${REPORT_EVENT_TABLE}`)
    )) as unknown as readonly { count: number }[]
    const waitStartMs = (wait: LockWait) => wait.waitstart?.getTime() ?? resolvedAt
    return {
      deadlockDetected,
      deadlockVictim:
        writerOutcome.status === 'rejected' && /deadlock detected/i.test(writerMessage)
          ? 'older_writer'
          : migrationOutcome.status === 'rejected' && /deadlock detected/i.test(migrationMessage)
            ? 'migration'
            : 'unknown',
      inputAndAuthorityPreserved: JSON.stringify(before) === JSON.stringify(after),
      journalUnchanged: JSON.stringify(beforeJournal) === JSON.stringify(afterJournal),
      migrationError,
      migrationNotApplied: JSON.stringify(beforeJournal) === JSON.stringify(afterJournal),
      instrumentationWritesRolledBack: Number(eventCount?.count ?? -1) === 0,
      schemaDdlAbsent:
        beforeDdl.quarantine_table === null &&
        JSON.stringify(beforeDdl) === JSON.stringify(afterDdl),
      lockWaitMetrics: {
        migrationMembershipWaitMs: resolvedAt - waitStartMs(migrationMembershipWait),
        writerChannelWaitMs: resolvedAt - waitStartMs(writerChannelWait),
        deadlockResolutionAfterCycleMs:
          resolvedAt -
          Math.max(waitStartMs(migrationMembershipWait), waitStartMs(writerChannelWait)),
      },
      writerOutcome: writerMessage,
    }
  } finally {
    requestChannelLock.resolve()
    await Promise.allSettled(
      [migrationPromise, writerPromise].filter(Boolean) as Promise<unknown>[]
    )
    await Promise.all([observer.end(), writer.end(), migrationClient.end()])
  }
}

describe.skipIf(!provisioned)(
  'production 0058 historical-data and concurrency qualification (#1222)',
  () => {
    let admin: postgres.Sql | undefined
    let database: DatabaseConnection | undefined
    let runtime: DatabaseConnection | undefined
    let scratch = ''
    let chainRoot: string | undefined
    let pre0058Folder: string | undefined
    const temporaryFolders: string[] = []
    let report: QualificationReport | undefined

    beforeAll(async () => {
      scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`
      assertScratch(scratch)
      admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
      await createCanonicalDatabase(admin, urlForDatabase, scratch)
      const migrationUrl = canonicalUrl(requireProvisioningUrl(), scratch, MIGRATION_ROLE)
      const runtimeUrl = canonicalUrl(requireProvisioningUrl(), scratch, RUNTIME_ROLE)
      database = createDatabase(migrationUrl)
      runtime = createDatabase(runtimeUrl)
      const chain = canonicalChainFolders()
      chainRoot = chain.root
      pre0058Folder = migrationsFolderBefore('0058_legacy_audience_quarantine')

      // Build the repository's historical shape, write legacy records there, then advance to the
      // exact current schema immediately before 0058. This is deliberately not schema.sql replay.
      await migrate(database.db, { migrationsFolder: chain.stageOne })
      const seed = await seedLegacyAudience({ migration: database.db, runtime: runtime.db })
      const lifecycleAgents = await addLifecycleAgents(database.db, runtime.db, seed)
      const legacyMessageId = await insertLegacyMessage(database.db, {
        bodyText: 'synthetic historical message retained across 0058',
        channelId: seed.activeGroupId,
        sender: seed.owner,
        workspaceId: seed.workspaceId,
      })
      await insertLegacyReadState(database.db, {
        channelId: seed.activeGroupId,
        lastReadSequence: 1,
        userId: seed.owner.userId,
        workspaceId: seed.workspaceId,
      })
      await database.db.execute(sql`
        insert into app.thread_read_states
          (workspace_id, user_id, channel_id, thread_root_message_id, last_read_sequence)
        values (${seed.workspaceId}::uuid, ${seed.owner.userId}::uuid, ${seed.activeGroupId}::uuid,
          ${legacyMessageId}::uuid, 1)
      `)
      await migrate(database.db, { migrationsFolder: chain.full })
      await migrate(database.db, { migrationsFolder: pre0058Folder })
      await database.db.execute(
        sql.raw(`
        create table ${REPORT_EVENT_TABLE} (
          name text primary key,
          recorded_at timestamptz not null
        )
      `)
      )

      const preCutover = await evidenceMatrix(database.db, false)
      const beforeSnapshot = await capture(database.db, 'before-0058')
      const beforeQuarantineDomain = beforeSnapshot.domains.find(
        (domain) => domain.domain === 'legacyAudienceQuarantine'
      )
      const beforeJournal = await journalRows(database.db)
      const initialDdl = await schemaState(database.db)

      const failedFolder = copyMigrationFolder(DRIZZLE_DIR, 'm18-1222-failure', (contents) =>
        instrument0058(contents, true)
      )
      temporaryFolders.push(failedFolder)
      const failedMigration = await migrate(database.db, { migrationsFolder: failedFolder }).then(
        () => 'unexpected_success',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      const afterFailure = await evidenceMatrix(database.db, false)
      const afterFailureDdl = await schemaState(database.db)
      const afterFailureJournal = await journalRows(database.db)
      const failureEvents = (await database.db.execute(
        sql.raw(`select count(*)::int as count from ${REPORT_EVENT_TABLE}`)
      )) as unknown as readonly { count: number }[]
      const afterFailureSnapshot = await capture(database.db, 'after-failed-0058')
      const failureDomain = afterFailureSnapshot.domains.find(
        (domain) => domain.domain === 'legacyAudienceQuarantine'
      )
      const deadlockRollback = await runLockOrderDeadlock({
        database,
        databaseName: scratch,
        folder: failedFolder,
      })

      const successfulFolder = copyMigrationFolder(DRIZZLE_DIR, 'm18-1222-success', (contents) =>
        instrument0058(contents, false)
      )
      temporaryFolders.push(successfulFolder)
      const sourceRows = (await database.db.execute(sql`
        select id::text as id, channel_id::text as channel_id, principal_kind, user_id::text as user_id
        from app.channel_participants
        where channel_id = ${seed.activeGroupId}::uuid and principal_kind = 'user'
          and user_id = ${seed.removedUserId}::uuid
      `)) as unknown as readonly { id: string }[]
      if (sourceRows.length !== 1 || !sourceRows[0]) {
        throw new Error('synthetic removed-user source row was not present before the cutover')
      }

      const concurrent = await runConcurrentCutover({
        channelId: seed.activeGroupId,
        database,
        databaseName: scratch,
        folder: successfulFolder,
        participantId: sourceRows[0].id,
        removedUserId: seed.removedUserId,
        workspaceId: seed.workspaceId,
      })
      const afterCutover = await evidenceMatrix(database.db, true)
      const afterSnapshot = await capture(database.db, 'after-0058')
      const quarantineRecords =
        afterSnapshot.document.sections.legacyAudienceQuarantine?.records ?? []
      const reasons = Object.fromEntries(
        [...new Set(quarantineRecords.map((record) => record.reason))]
          .toSorted()
          .map((reason) => [
            reason,
            quarantineRecords.filter((record) => record.reason === reason).length,
          ])
      )
      const [sourceDigestCheck] = (await database.db.execute(sql`
        select q.source_row_digest, app.legacy_participant_digest(cp) as current_source_digest
        from app.legacy_audience_quarantine q
        join app.channel_participants cp on cp.id = q.source_participant_id
        where q.source_participant_id = ${sourceRows[0].id}::uuid
      `)) as unknown as readonly { source_row_digest: string; current_source_digest: string }[]
      const snapshotRepeatBefore = await capture(database.db, 'after-0058-repeat-before')
      await migrate(database.db, { migrationsFolder: DRIZZLE_DIR })
      const snapshotRepeatAfter = await capture(database.db, 'after-0058-repeat-after')
      const repeatedEvidence = await evidenceMatrix(database.db, true)
      const repeatDdl = await schemaState(database.db)
      const repeatSnapshotSame =
        JSON.stringify(snapshotRepeatBefore.document.sections.legacyAudienceQuarantine) ===
        JSON.stringify(snapshotRepeatAfter.document.sections.legacyAudienceQuarantine)

      const groupAuthorityBefore = Object.fromEntries(
        ['group_admissions', 'group_audience_grants', 'group_enlistment_grants'].map((table) => [
          table,
          preCutover[table],
        ])
      )
      const groupAuthorityAfter = Object.fromEntries(
        ['group_admissions', 'group_audience_grants', 'group_enlistment_grants'].map((table) => [
          table,
          afterCutover[table],
        ])
      )

      report = {
        schemaVersion: 3,
        syntheticScenario: {
          startingSchema: 'canonical historical chain through 0057, before 0058',
          sourceRowsBeforeCutover: preCutover.channel_participants,
          sourceRowsAfterOldWriterBeforeClassification: concurrent.sourceBeforeClassification,
          sourceRowsAfterCutover: afterCutover.channel_participants,
          oldWriterChangedSourceBeforeMigration:
            preCutover.channel_participants.digest !== concurrent.sourceBeforeClassification.digest,
          messagesBeforeCutover: preCutover.messages,
          messagesAfterCutover: afterCutover.messages,
          channelReadStatesBeforeCutover: preCutover.channel_read_states,
          channelReadStatesAfterCutover: afterCutover.channel_read_states,
          threadReadStatesBeforeCutover: preCutover.thread_read_states,
          threadReadStatesAfterCutover: afterCutover.thread_read_states,
          derivedAuthorityBeforeCutover: groupAuthorityBefore,
          derivedAuthorityAfterCutover: groupAuthorityAfter,
          quarantine: {
            count: quarantineRecords.length,
            digest: afterCutover.legacy_audience_quarantine?.digest,
            reasons,
            utcMicrosecondTimestamps: quarantineRecords.every(
              (record) =>
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(
                  record.sourceChannelCreatedAt
                ) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(record.sourceJoinedAt)
            ),
            sourceDigestMatchesPreservedRow:
              sourceDigestCheck?.source_row_digest === sourceDigestCheck?.current_source_digest,
            withdrawnDigestCount: quarantineRecords.filter((record) => record.withdrawnDigest)
              .length,
          },
          beforeCutoverDomain: beforeQuarantineDomain,
          afterCutoverDomain: afterSnapshot.domains.find(
            (domain) => domain.domain === 'legacyAudienceQuarantine'
          ),
          archivedAgentReason: quarantineRecords.find(
            (record) => record.principalId === lifecycleAgents.archived
          )?.reason,
          configurationErrorAgentReason: quarantineRecords.find(
            (record) => record.principalId === lifecycleAgents.configurationError
          )?.reason,
          cleanActiveAgentAdmitted: (
            afterSnapshot.document.sections.groupEnlistmentGrants?.records ?? []
          ).some((record) => record.agentId === lifecycleAgents.active),
        },
        failureRollback: {
          injectedError: failedMigration.includes('1222 qualification injected failure'),
          dataAndAuthorityRestored: JSON.stringify(preCutover) === JSON.stringify(afterFailure),
          journalUnchanged: JSON.stringify(beforeJournal) === JSON.stringify(afterFailureJournal),
          ddlAndTriggersAbsent: JSON.stringify(initialDdl) === JSON.stringify(afterFailureDdl),
          instrumentationWritesRolledBack: Number(failureEvents[0]?.count ?? -1) === 0,
          snapshotStillSchemaAbsent: failureDomain,
        },
        deadlockRollback,
        concurrency: {
          ...concurrent,
          lockMetrics: concurrent.lockMetrics,
        },
        idempotency: {
          migrationReplayed: true,
          quarantineSnapshotSameAfterRepeat: repeatSnapshotSame,
          quarantineEvidenceSameAfterRepeat:
            afterCutover.legacy_audience_quarantine?.digest ===
            repeatedEvidence.legacy_audience_quarantine?.digest,
          schemaStateAfterRepeat: repeatDdl,
        },
      }
      console.log(`M18_1222_QUALIFICATION ${JSON.stringify(report)}`)
    }, 300_000)

    afterAll(async () => {
      const failures: unknown[] = []
      const attempt = async (operation: () => Promise<unknown> | void) => {
        try {
          await operation()
        } catch (error) {
          failures.push(error)
        }
      }
      if (runtime) await attempt(() => runtime!.close())
      if (database) await attempt(() => database!.close())
      if (scratch) {
        assertScratch(scratch)
        if (admin)
          await attempt(() => admin!.unsafe(`drop database if exists "${scratch}" with (force)`))
      }
      if (admin) await attempt(() => admin!.end())
      for (const folder of temporaryFolders) {
        await attempt(() => rmSync(folder, { recursive: true, force: true }))
      }
      if (pre0058Folder)
        await attempt(() => rmSync(pre0058Folder!, { recursive: true, force: true }))
      if (chainRoot) await attempt(() => rmSync(chainRoot!, { recursive: true, force: true }))
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `qualification cleanup failed in ${failures.length} step(s)`
        )
      }
    })

    test('0058 starts from a historical populated schema, and a failure rolls the migration back atomically', () => {
      if (!report) throw new Error('qualification report was not produced')
      const failure = report.failureRollback as Record<string, unknown>
      expect(failure.injectedError).toBe(true)
      expect(failure.dataAndAuthorityRestored).toBe(true)
      expect(failure.journalUnchanged).toBe(true)
      expect(failure.ddlAndTriggersAbsent).toBe(true)
      expect(failure.instrumentationWritesRolledBack).toBe(true)
      expect(failure.snapshotStillSchemaAbsent).toEqual({
        domain: 'legacyAudienceQuarantine',
        status: 'unknown',
        unknownReason: 'schema_absent',
      })
    })

    test('the lock-order inversion reports a deadlock and safely rolls back before retry', () => {
      if (!report) throw new Error('qualification report was not produced')
      const deadlock = report.deadlockRollback as Record<string, unknown>
      const waits = deadlock.lockWaitMetrics as Record<string, unknown>
      expect(deadlock.deadlockDetected).toBe(true)
      expect(deadlock.deadlockVictim).not.toBe('unknown')
      expect(deadlock.migrationNotApplied).toBe(true)
      expect(deadlock.journalUnchanged).toBe(true)
      expect(deadlock.inputAndAuthorityPreserved).toBe(true)
      expect(deadlock.schemaDdlAbsent).toBe(true)
      expect(deadlock.instrumentationWritesRolledBack).toBe(true)
      expect(waits.migrationMembershipWaitMs).toBeGreaterThanOrEqual(0)
      expect(waits.writerChannelWaitMs).toBeGreaterThanOrEqual(0)
      expect(waits.deadlockResolutionAfterCycleMs).toBeGreaterThanOrEqual(0)
    })

    test('the successful migration preserves source/history, withholds ambiguous audiences and captures provenance', () => {
      if (!report) throw new Error('qualification report was not produced')
      const scenario = report.syntheticScenario as Record<string, unknown>
      const quarantine = scenario.quarantine as Record<string, unknown>
      expect(scenario.startingSchema).toBe('canonical historical chain through 0057, before 0058')
      expect(scenario.beforeCutoverDomain).toEqual({
        domain: 'legacyAudienceQuarantine',
        status: 'unknown',
        unknownReason: 'schema_absent',
      })
      expect(quarantine.count).toBe(7)
      expect(quarantine.reasons).toEqual({
        agent_not_active: 2,
        agent_workspace_mismatch: 1,
        group_channel_not_active: 3,
        user_not_workspace_member: 1,
      })
      expect(quarantine.withdrawnDigestCount).toBe(7)
      expect(quarantine.utcMicrosecondTimestamps).toBe(true)
      expect(quarantine.sourceDigestMatchesPreservedRow).toBe(true)
      expect(scenario.cleanActiveAgentAdmitted).toBe(true)
      expect(scenario.archivedAgentReason).toBe('agent_not_active')
      expect(scenario.configurationErrorAgentReason).toBe('agent_not_active')
      expect(scenario.oldWriterChangedSourceBeforeMigration).toBe(true)
      expect(scenario.sourceRowsAfterCutover).toEqual(
        scenario.sourceRowsAfterOldWriterBeforeClassification
      )
      expect(scenario.messagesAfterCutover).toEqual(scenario.messagesBeforeCutover)
      expect(scenario.channelReadStatesAfterCutover).toEqual(
        scenario.channelReadStatesBeforeCutover
      )
      expect(scenario.threadReadStatesAfterCutover).toEqual(scenario.threadReadStatesBeforeCutover)
    })

    test('the migration blocks an existing roster writer, queues restoration until guards commit, and reports observed lock windows', () => {
      if (!report) throw new Error('qualification report was not produced')
      const concurrency = report.concurrency as Record<string, unknown>
      const metrics = concurrency.lockMetrics as Record<string, unknown>
      expect(concurrency.heldLocks).toBe(7)
      expect(concurrency.queuedRestorationWaitStartObserved).toBe(true)
      expect(concurrency.queuedRestorationRowsReturned).toBe(0)
      expect(concurrency.restoredAdmissions).toBe(0)
      expect(concurrency.sourcePreservedByMigration).toBe(true)
      expect(metrics.oldWriterLockWaitMs).toBeGreaterThanOrEqual(0)
      expect(metrics.intentionalLatchHoldMs).toBeGreaterThan(0)
      expect(metrics.probeWaitIncludingLatchMs).toBeGreaterThan(0)
      expect(metrics.probeWaitExcludingIntentionalLatchMs).toBeGreaterThanOrEqual(0)
      expect(metrics.lockWindowToMigrationReturnMs).toBeGreaterThanOrEqual(0)
      expect(metrics.lockWindowExcludingIntentionalLatchMs).toBeGreaterThanOrEqual(0)
    })

    test('replaying migration 0058 leaves nonempty quarantine provenance and snapshot equality intact', () => {
      if (!report) throw new Error('qualification report was not produced')
      const idempotency = report.idempotency as Record<string, unknown>
      expect(idempotency.quarantineSnapshotSameAfterRepeat).toBe(true)
      expect(idempotency.quarantineEvidenceSameAfterRepeat).toBe(true)
      expect(idempotency.schemaStateAfterRepeat).toEqual(
        expect.objectContaining({ quarantine_table: 'legacy_audience_quarantine' })
      )
    })
  }
)
