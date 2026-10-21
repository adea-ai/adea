/**
 * The populated migration rollback outcome qualification (#1219, #1222, #1220).
 *
 * A populated historical database is cut over to the current product, the rollback window is
 * declared over the expanded schema, and the outcome of that rollback is qualified: what the
 * migration carried across, what the fence records about it, what the window does not resurrect,
 * and what a point-in-time restore of the populated pre-cutover image actually leaves behind.
 *
 * The slices already delivered are reused, not repeated:
 *
 * - #1244 owns the rollback fence itself (`fenceLeadTurnForRollback`, the attribution contract and
 *   the disposition classifier). This file does not re-prove the fence mechanics on a fresh
 *   database: it qualifies the fence over the population a *migration* carried across, and over
 *   the population it did not.
 * - #1281 owns the migration-history preflight. This file runs that preflight against a populated
 *   database and against a restored one, because a preflight that was only ever exercised on
 *   synthetic fixtures proves nothing about a populated target.
 * - #1282 owns the canonical chain fixtures, the legacy audience seed and the quarantine tooling.
 *   The populated historical state is built from those helpers, unchanged.
 * - #1536 owns the restored schema objects and the refusal of an altered restored ledger. This
 *   file does not repeat either: it takes a point-in-time image of the populated pre-cutover
 *   database and reads the restored state *before* any verifier could repair it, which is the
 *   ordering #1536 established.
 * - #1530 owns the client surfaces a cutover must not change. Those surfaces are not re-proved
 *   here; this file only checks that the rollback window does not change the audience the current
 *   product already decided.
 *
 * Nothing here is a production statement. The database is a disposable instance this run creates,
 * populates, restores and drops; no production capture, no production migration and no production
 * rollback is executed, and no user data is read or restored. The qualification proves the
 * *mechanism* on synthetic rows; it does not establish the production migration ledger, the
 * production candidate set, production lock durations, live role ownership or operator readiness,
 * and it does not close #1219, #1222 or #1220.
 *
 * Determinism: one scenario runs once, in a fixed order, however the tests are selected or
 * reordered. Every test asserts on that scenario's recorded results and never on state a previous
 * test left behind.
 *
 * Provisioning: the admin URL comes from MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL, which the
 * integration lane exports when Docker provisioning succeeds. In CI a missing URL fails the suite
 * instead of skipping it. Outside CI the suite is skipped without the URL, and it never falls back
 * to the shared DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { ensureWorkspaceLead } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { getChannelForUser, listMessagesForUser } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { loadGroupAdmission } from '../../src/group-participation-store'
import {
  assertLeadTurnNotFenced,
  fenceLeadTurnForRollback,
  readLeadTurnRollbackState,
  type LeadTurnRollbackAttribution,
  type LeadTurnRollbackDisposition,
} from '../../src/lead-turn-rollback'
import { assertDatabaseMigrationHistoryCompatible } from '../../src/migration-history-preflight'
import { channelParticipants } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import {
  CUTOVER_TAG,
  DRIZZLE_DIR,
  disposeRehearsal,
  isProductDenial,
  migrationsFolderBefore,
  type RehearsalResources,
} from '../fixtures/cutover-rehearsal'
import {
  assertScratchDatabaseName,
  assertServerIdentity,
  canonicalTargetUrl,
  parseLocalDisposableTarget,
  type LocalDisposableTarget,
} from '../fixtures/migration-cutover-target'
import {
  captureGroupAudienceParticipants,
  legacyBackfillProfile,
  reconcileLegacyAudience,
} from '../fixtures/legacy-audience-quarantine'
import {
  insertLegacyGroup,
  insertLegacyMessage,
  insertLegacyReadState,
} from '../fixtures/legacy-audience-seed'

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
/** The live target of the qualification. Every database name this run creates carries it. */
const SCRATCH_PREFIX = 'rollback_1220_target_'
/** The point-in-time image of the populated pre-cutover database. */
const IMAGE_PREFIX = 'rollback_1220_image_'
/** The operator that declares the rollback window. It is a trusted in-process caller, by reference. */
const OPERATOR_ID = 'migration-rollback-qualification'
const OBSERVED_AT = '2026-10-21T00:00:00.000Z'
/** The migrations of this repository, applied the way the product's runner applies them. */
const MIGRATION_OPTIONS = {
  migrationsSchema: 'app',
  migrationsTable: '__drizzle_migrations',
} as const

/**
 * The journal entries with their timestamps.
 *
 * `readJournal` (the shared fixture) reports the tags; the ledger this proof compares against
 * carries the timestamps as well, so the journal is read once more for them. Both reads see the
 * repository's own migration ledger source.
 */
function journalEntries(): ReadonlyArray<{ idx: number; tag: string; when: number }> {
  const journal = JSON.parse(readFileSync(`${DRIZZLE_DIR}/meta/_journal.json`, 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[]
  }
  return journal.entries
}

/** The digest drizzle records for one migration file. */
function migrationHash(tag: string): string {
  return createHash('sha256')
    .update(readFileSync(`${DRIZZLE_DIR}/${tag}.sql`, 'utf8'))
    .digest('hex')
}

/**
 * The disposable target, validated before anything connects to it.
 *
 * The capture URL is inherited from the environment, so it is checked rather than trusted: a
 * loopback host, no startup or identity option, and no duplicate or encoded parameter. An
 * inherited URL that points anywhere else is refused instead of used.
 */
function requireLocalDisposableTarget(): LocalDisposableTarget {
  if (!provisioningUrl) {
    throw new Error(
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set. In CI this means the Docker capture provisioning did not run, and this qualification refuses to skip silently.'
    )
  }
  return parseLocalDisposableTarget(provisioningUrl)
}

let disposableTarget: LocalDisposableTarget | undefined

function target(): LocalDisposableTarget {
  disposableTarget ??= requireLocalDisposableTarget()
  return disposableTarget
}

function urlForDatabase(database: string): string {
  return canonicalTargetUrl(target(), database)
}

function assertScratch(database: string): void {
  assertScratchDatabaseName(database, SCRATCH_PREFIX)
}

function assertImage(database: string): void {
  assertScratchDatabaseName(database, IMAGE_PREFIX)
}

async function adminExecute(statement: string): Promise<void> {
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(statement)
  } finally {
    await admin.end()
  }
}

type Principal = Awaited<ReturnType<typeof createTemporaryUserSession>>['principal']

type LedgerRow = { id: number; hash: string; created_at: string }

/** The ledger rows the database carries, in the order drizzle recorded them. */
async function readLedger(connection: DatabaseConnection): Promise<LedgerRow[]> {
  return connection.db.execute<LedgerRow>(sql`
    select id, hash, created_at::text as created_at
    from app.__drizzle_migrations
    order by id`)
}

/** Whether the rollback fence's columns exist on the schema at all. */
async function fenceColumnsExist(connection: DatabaseConnection): Promise<boolean> {
  const rows = await connection.db.execute<{ present: boolean }>(sql`
    select count(*)::int > 0 as present
    from information_schema.columns
    where table_schema = 'app'
      and table_name = 'lead_turn_intents'
      and column_name = 'rollback_fenced_at'`)
  return rows[0]?.present ?? false
}

/** Whether the canonical group authority tables exist on the schema at all. */
async function groupTablesExist(connection: DatabaseConnection): Promise<boolean> {
  const rows = await connection.db.execute<{ present: boolean }>(sql`
    select count(*)::int > 0 as present
    from information_schema.tables
    where table_schema = 'app'
      and table_name in ('group_admissions', 'group_audience_grants', 'group_enlistment_grants')`)
  return rows[0]?.present ?? false
}

/**
 * The outcome of the database package's own migration-history preflight.
 *
 * The refusal is recorded rather than thrown, so the test can state exactly why a populated
 * target was accepted. An accepted target carries no reason; a refused one carries the message
 * the preflight produced.
 */
type PreflightOutcome = { accepted: boolean; reason: string | null }

async function preflightOutcome(connection: DatabaseConnection): Promise<PreflightOutcome> {
  try {
    await assertDatabaseMigrationHistoryCompatible(connection, DRIZZLE_DIR)
    return { accepted: true, reason: null }
  } catch (error) {
    return { accepted: false, reason: (error as Error).message }
  }
}

/**
 * The admission columns the historical schema already had.
 *
 * The projection names the columns that existed at 0043, so the same projection can be taken
 * before the cutover, after the cutover and after a restore, and compared as one document. The
 * columns later migrations add are read separately, because they are exactly what the cutover
 * could have invented.
 */
const INTENT_PROJECTION = sql`
  select id::text as id,
    workspace_id::text as workspace_id,
    channel_id::text as channel_id,
    message_id::text as message_id,
    actor_user_id::text as actor_user_id,
    agent_id::text as agent_id,
    control_plane_agent_id,
    profile_id,
    profile_version,
    profile_revision,
    channel_version,
    channel_visibility,
    audience::text as audience,
    dispatch_key,
    state,
    reason_code
  from app.lead_turn_intents
  order by id`

type IntentProjection = {
  id: string
  workspace_id: string
  channel_id: string
  message_id: string
  actor_user_id: string
  agent_id: string
  control_plane_agent_id: string
  profile_id: string
  profile_version: string
  profile_revision: number
  channel_version: number
  channel_visibility: string
  audience: string
  dispatch_key: string
  state: string
  reason_code: string
}

/** The fence columns, and the columns the migrations after the cutover added beside them. */
const FENCE_PROJECTION = sql`
  select id::text as id,
    rollback_fenced_at::text as rollback_fenced_at,
    rollback_fence_actor_kind,
    rollback_fence_actor_ref,
    rollback_fence_reason,
    rollback_fence_authority::text as rollback_fence_authority,
    requested_model_selections::text as requested_model_selections,
    handoff_target_session_id,
    handoff_target_generation::text as handoff_target_generation,
    handoff_target_task_id::text as handoff_target_task_id,
    handoff_target_attempt::text as handoff_target_attempt
  from app.lead_turn_intents
  order by id`

type FenceProjection = {
  id: string
  rollback_fenced_at: string | null
  rollback_fence_actor_kind: string | null
  rollback_fence_actor_ref: string | null
  rollback_fence_reason: string | null
  rollback_fence_authority: string | null
  requested_model_selections: string | null
  handoff_target_session_id: string | null
  handoff_target_generation: string | null
  handoff_target_task_id: string | null
  handoff_target_attempt: string | null
}

const RUNTIME_PROJECTION = sql`
  select intent_id::text as intent_id,
    state,
    dispatch_id,
    runtime_session_id,
    observed_at::text as observed_at,
    published_message_id::text as published_message_id,
    publication_digest
  from app.lead_turn_runtime
  order by intent_id`

type RuntimeProjection = {
  intent_id: string
  state: string
  dispatch_id: string | null
  runtime_session_id: string | null
  observed_at: string | null
  published_message_id: string | null
  publication_digest: string | null
}

/** A product read: a product denial becomes the value `denied`; any other failure propagates. */
async function settle<T>(read: () => Promise<T>): Promise<T | 'denied'> {
  try {
    return await read()
  } catch (error) {
    if (isProductDenial(error)) return 'denied'
    throw error
  }
}

/** Lower-case hexadecimal of an exact length. */
function hex(length: number): string {
  const unit = crypto.randomUUID().replaceAll('-', '')
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
}

function crockford(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()
}

type Lead = {
  id: string
  controlPlaneAgentId: string
  profileId: string
  profileVersion: string
  profileRevision: number
}

type Base = {
  workspaceId: string
  owner: Principal
  member: Principal
  /** The principal whose legacy roster row outlived their workspace membership. */
  removed: Principal
  lead: Lead
  groupChannelId: string
  groupMessageId: string
  topicChannelId: string
  /** Every message the fixture seeded, so a restore that lost one is detectable. */
  messageIds: string[]
}

type CohortKey = 'prepared' | 'uncertain' | 'inFlight' | 'terminal'
const COHORT_KEYS: readonly CohortKey[] = ['prepared', 'uncertain', 'inFlight', 'terminal']

/**
 * The populated historical database, before any admission exists.
 *
 * The workspace, its members, the lead Agent and the group are written the way the product of
 * that day wrote them; the direct Agent topic is written directly, because the current writer
 * names `archive_source`, which 0048 adds.
 */
async function seedHistoricalBase(connection: DatabaseConnection): Promise<Base> {
  const suffix = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000)
  const session = async (name: string) =>
    (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `rollback-${name}-${suffix}`,
        expiresAt,
      })
    ).principal
  const owner = await session('owner')
  const member = await session('member')
  const removed = await session('removed')

  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `rollback-${suffix}`,
    name: 'Rollback qualification HQ',
    owner,
  })
  const workspaceId = workspace.id
  await connection.db.execute(sql`
    insert into app.workspace_memberships (workspace_id, user_id, role)
    values (${workspaceId}::uuid, ${member.userId}::uuid, 'member'),
           (${workspaceId}::uuid, ${removed.userId}::uuid, 'member')`)

  const lead = await ensureWorkspaceLead(connection.db, workspaceId, owner)
  const leadRow = await connection.db.execute<{
    control_plane_agent_id: string
    profile_id: string
    profile_version: string
    profile_revision: number
  }>(sql`
    select control_plane_agent_id, profile_id, profile_version, profile_revision
    from app.agents where id = ${lead.id}::uuid`)
  const leadRowValue = leadRow[0]
  if (!leadRowValue) throw new Error('the workspace lead row could not be read')

  // The active group with the legacy roster: the clean member, the participant who has since
  // left the workspace, and one message they can both read before the cutover.
  const groupChannelId = await insertLegacyGroup(
    connection.db,
    workspaceId,
    owner,
    'Rollback group'
  )
  await connection.db.insert(channelParticipants).values([
    { channelId: groupChannelId, principalKind: 'user', userId: member.userId, workspaceId },
    { channelId: groupChannelId, principalKind: 'user', userId: removed.userId, workspaceId },
  ])
  const groupMessageId = await insertLegacyMessage(connection.db, {
    bodyText: 'rollback-group-body',
    channelId: groupChannelId,
    sender: owner,
    workspaceId,
  })
  await insertLegacyReadState(connection.db, {
    channelId: groupChannelId,
    lastReadSequence: 1,
    userId: member.userId,
    workspaceId,
  })

  // The direct Agent topic the admissions hang from.
  const topicChannelId = await insertLegacyTopic(connection, workspaceId, lead.id)
  await connection.db.insert(channelParticipants).values([
    { channelId: topicChannelId, principalKind: 'user', userId: owner.userId, workspaceId },
    { channelId: topicChannelId, principalKind: 'agent', agentId: lead.id, workspaceId },
  ])

  // The ambiguous participant leaves the workspace. Their legacy roster row survives, and that
  // surviving row against a missing membership is exactly the audience the cutover cannot prove
  // and therefore has to quarantine.
  await connection.db.execute(sql`
    delete from app.workspace_memberships
    where workspace_id = ${workspaceId}::uuid and user_id = ${removed.userId}::uuid`)

  return {
    workspaceId,
    owner,
    member,
    removed,
    lead: {
      id: lead.id,
      controlPlaneAgentId: leadRowValue.control_plane_agent_id,
      profileId: leadRowValue.profile_id,
      profileVersion: leadRowValue.profile_version,
      profileRevision: leadRowValue.profile_revision,
    },
    groupChannelId,
    groupMessageId,
    topicChannelId,
    messageIds: [groupMessageId],
  }
}

/** The direct Agent topic of the historical schema. */
async function insertLegacyTopic(
  connection: DatabaseConnection,
  workspaceId: string,
  agentId: string
): Promise<string> {
  const rows = await connection.db.execute<{ id: string }>(sql`
    insert into app.channels (workspace_id, kind, visibility, title, lifecycle_state, idempotency_key, agent_id)
    values (${workspaceId}::uuid, 'direct_agent', 'workspace', 'Rollback topic', 'active',
      ${`rollback-topic-${crypto.randomUUID()}`}, ${agentId}::uuid)
    returning id::text as id`)
  const row = rows[0]
  if (!row) throw new Error('the historical direct topic insert returned no row')
  return row.id
}

/**
 * One admission in the shape the pre-cutover schema had.
 *
 * The current product's writer names the columns the migrations after 0043 added, so it cannot
 * run against the historical state. The historical admission is written directly, the way the
 * product of that day wrote it, and it pins the same values the current reader re-pins.
 */
async function insertLegacyAdmission(
  connection: DatabaseConnection,
  base: Base,
  messageId: string
): Promise<string> {
  const id = crypto.randomUUID()
  const audience = JSON.stringify([`agent:${base.lead.id}`, `user:${base.owner.userId}`].toSorted())
  await connection.db.execute(sql`
    insert into app.lead_turn_intents (
      id, workspace_id, channel_id, message_id, actor_user_id, agent_id, control_plane_agent_id,
      profile_id, profile_version, profile_revision, channel_version, channel_visibility,
      audience, dispatch_key
    ) values (
      ${id}::uuid, ${base.workspaceId}::uuid, ${base.topicChannelId}::uuid,
      ${messageId}::uuid, ${base.owner.userId}::uuid, ${base.lead.id}::uuid,
      ${base.lead.controlPlaneAgentId}, ${base.lead.profileId}, ${base.lead.profileVersion},
      ${base.lead.profileRevision}, 1, 'workspace', ${audience}::jsonb, ${`lead-turn:${id}`}
    )`)
  return id
}

/**
 * One runtime row in the shape the pre-cutover schema had.
 *
 * The four states are the four evidence shapes the rollback policy classifies: prepared without a
 * dispatch, a dispatch whose outcome was never observed, an attempt that was in flight, and a
 * terminal attempt that published. The control keeps the prepared shape and is never fenced.
 */
async function insertLegacyRuntime(
  connection: DatabaseConnection,
  input: Readonly<{
    intentId: string
    state: 'prepared' | 'dispatch_pending' | 'running' | 'completed'
    publishedMessageId?: string
  }>
): Promise<void> {
  const bound =
    input.state === 'prepared' || input.state === 'dispatch_pending'
      ? { dispatchId: null, runtimeSessionId: null, observedAt: null }
      : {
          dispatchId: `dispatch_${hex(32)}`,
          runtimeSessionId: `ses_${crockford()}`,
          observedAt: OBSERVED_AT,
        }
  const published = input.state === 'completed' && input.publishedMessageId
  await connection.db.execute(sql`
    insert into app.lead_turn_runtime (
      intent_id, dispatch_id, execution_id, attempt_id, selection_ref, selection_revision,
      preparation_ref, preparation_expires_at, runtime_session_id, state, observed_at,
      published_message_id, publication_digest
    ) values (
      ${input.intentId}::uuid, ${bound.dispatchId}, ${`exe_${crockford()}`}, ${`att_${crockford()}`},
      ${`msel_${hex(32)}`}, 1, ${`prep_${hex(32)}`}, ${OBSERVED_AT}::timestamptz,
      ${bound.runtimeSessionId}, ${input.state}, ${bound.observedAt}::timestamptz,
      ${published ? input.publishedMessageId : null}::uuid, ${published ? hex(64) : null}
    )`)
}

type Population = {
  /** The four admissions the rollback window fences, by their evidence state. */
  cohort: Record<CohortKey, string>
  /** The admission the rollback window does not fence. */
  control: string
  messageIds: string[]
}

/**
 * The admission population the migration carries across.
 *
 * Five admissions: the four evidence shapes the rollback policy classifies, and one control the
 * rollback window deliberately leaves alone. The control is what makes the cohort a cohort.
 */
async function seedAdmissions(connection: DatabaseConnection, base: Base): Promise<Population> {
  const cohort = {} as Record<CohortKey, string>
  const messageIds = [...base.messageIds]
  for (const key of COHORT_KEYS) {
    const messageId = await insertLegacyMessage(connection.db, {
      bodyText: `rollback-admission-${key}`,
      channelId: base.topicChannelId,
      sender: base.owner,
      workspaceId: base.workspaceId,
    })
    messageIds.push(messageId)
    const intentId = await insertLegacyAdmission(connection, base, messageId)
    const runtimeState =
      key === 'prepared'
        ? 'prepared'
        : key === 'uncertain'
          ? 'dispatch_pending'
          : key === 'inFlight'
            ? 'running'
            : 'completed'
    let publishedMessageId: string | undefined
    if (key === 'terminal') {
      // The terminal attempt published before the window; the message it published is part of
      // the populated state the restore has to carry.
      publishedMessageId = await insertLegacyMessage(connection.db, {
        bodyText: 'rollback-published-result',
        channelId: base.topicChannelId,
        sender: base.owner,
        workspaceId: base.workspaceId,
      })
      messageIds.push(publishedMessageId)
    }
    await insertLegacyRuntime(connection, {
      intentId,
      state: runtimeState,
      ...(publishedMessageId ? { publishedMessageId } : {}),
    })
    cohort[key] = intentId
  }
  const controlMessageId = await insertLegacyMessage(connection.db, {
    bodyText: 'rollback-admission-control',
    channelId: base.topicChannelId,
    sender: base.owner,
    workspaceId: base.workspaceId,
  })
  messageIds.push(controlMessageId)
  const control = await insertLegacyAdmission(connection, base, controlMessageId)
  await insertLegacyRuntime(connection, { intentId: control, state: 'prepared' })
  return { cohort, control, messageIds }
}

/** The recorded outcome of one fence, as the product's own writer returned it. */
type FenceOutcome = {
  disposition: LeadTurnRollbackDisposition
  fenced: boolean
  alreadyFenced: boolean
  attribution?: LeadTurnRollbackAttribution
}

type Scenario = Awaited<ReturnType<typeof executeScenario>>

async function executeScenario() {
  const disposable = requireLocalDisposableTarget()
  const journal = journalEntries()
  const prefixCount = journal.findIndex((entry) => entry.tag === CUTOVER_TAG)
  if (prefixCount < 0) throw new Error(`the cutover tag ${CUTOVER_TAG} is not in the journal`)

  const scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const image = `${IMAGE_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  assertScratch(scratch)
  assertImage(image)
  resources.scratch = scratch
  resources.image = image
  await adminExecute(`create database "${scratch}"`)

  const connect = async (): Promise<DatabaseConnection> => {
    const connection = createDatabase(urlForDatabase(scratch), { maxConnections: 1 })
    resources.connection = connection
    await assertServerIdentity(connection.db, {
      database: scratch,
      user: disposable.user,
    })
    return connection
  }

  // The historical prefix of the repository's own journal, applied the way the runner of that day
  // applied it: the same statements, the same hashes, the same ledger timestamps.
  resources.preFolder = migrationsFolderBefore(CUTOVER_TAG)
  let connection = await connect()
  await migrate(connection.db, { migrationsFolder: resources.preFolder, ...MIGRATION_OPTIONS })
  const base = await seedHistoricalBase(connection)
  const population = await seedAdmissions(connection, base)
  const historicalLedger = await readLedger(connection)
  const historicalIntents = await connection.db.execute<IntentProjection>(INTENT_PROJECTION)
  const historicalRuntimes = await connection.db.execute<RuntimeProjection>(RUNTIME_PROJECTION)
  const historicalFenceColumnsExist = await fenceColumnsExist(connection)
  const historicalGroupTablesExist = await groupTablesExist(connection)
  // The preflight on the populated historical target: its ledger is a prefix of the candidate, so
  // nothing would be skipped and nothing moved.
  const historicalPreflight = await preflightOutcome(connection)

  // The point-in-time image of the populated pre-cutover database. It is a physical copy, the
  // shape a base-backup restore produces: it carries the schema, the rows and the ledger, and it
  // carries no role or privilege model.
  await connection.close()
  resources.connection = undefined
  await adminExecute(`create database "${image}" template "${scratch}"`)
  connection = await connect()

  // The cutover: the remaining journal entries, applied unchanged.
  await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR, ...MIGRATION_OPTIONS })
  const cutoverLedger = await readLedger(connection)
  const cutoverIntents = await connection.db.execute<IntentProjection>(INTENT_PROJECTION)
  const cutoverFence = await connection.db.execute<FenceProjection>(FENCE_PROJECTION)
  const cutoverRuntimes = await connection.db.execute<RuntimeProjection>(RUNTIME_PROJECTION)
  const cutoverGroupTablesExist = await groupTablesExist(connection)
  const cutoverPreflight = await preflightOutcome(connection)

  const reconciliation = await reconcileLegacyAudience(connection.db)
  const quarantineRows = await connection.db.execute<{
    principal_id: string
    principal_kind: string
    reason: string
    profile: string
    source_row_digest: string
    withdrawn_digest: string | null
  }>(sql`
    select principal_id::text as principal_id, principal_kind, reason, profile,
      source_row_digest, withdrawn_digest
    from app.legacy_audience_quarantine
    order by principal_id`)
  const audience = await captureGroupAudienceParticipants(connection.db, base.workspaceId)
  const quarantinedAdmission = await loadGroupAdmission(
    connection.db,
    base.workspaceId,
    base.groupChannelId,
    {
      kind: 'user',
      userId: base.removed.userId,
    }
  )
  const admittedAdmission = await loadGroupAdmission(
    connection.db,
    base.workspaceId,
    base.groupChannelId,
    {
      kind: 'user',
      userId: base.member.userId,
    }
  )
  const removedChannel = await settle(() =>
    getChannelForUser(connection.db, base.workspaceId, base.groupChannelId, base.removed)
  )
  const memberChannel = await settle(() =>
    getChannelForUser(connection.db, base.workspaceId, base.groupChannelId, base.member)
  )
  const removedMessages = await settle(() =>
    listMessagesForUser(connection.db, base.workspaceId, base.groupChannelId, base.removed)
  )
  const memberMessages = await settle(() =>
    listMessagesForUser(connection.db, base.workspaceId, base.groupChannelId, base.member)
  )

  // The rollback window: the cohort the operator fences.
  const fenceRequest = {
    actor: { kind: 'operator' as const, operatorId: OPERATOR_ID },
    reason: 'rollback_cohort' as const,
  }
  const fences = {} as Record<CohortKey, FenceOutcome>
  for (const key of COHORT_KEYS) {
    const outcome = await fenceLeadTurnForRollback(
      connection.db,
      base.workspaceId,
      population.cohort[key],
      fenceRequest
    )
    fences[key] = {
      disposition: outcome.disposition,
      fenced: outcome.fenced,
      alreadyFenced: outcome.alreadyFenced,
      ...(outcome.attribution ? { attribution: outcome.attribution } : {}),
    }
  }
  // The window is declared once: a second declaration keeps the first attribution.
  const repeatFences = {} as Record<CohortKey, FenceOutcome>
  for (const key of COHORT_KEYS) {
    const outcome = await fenceLeadTurnForRollback(
      connection.db,
      base.workspaceId,
      population.cohort[key],
      fenceRequest
    )
    repeatFences[key] = {
      disposition: outcome.disposition,
      fenced: outcome.fenced,
      alreadyFenced: outcome.alreadyFenced,
      ...(outcome.attribution ? { attribution: outcome.attribution } : {}),
    }
  }

  // A fenced admission is refused a new effect; the control, which the window did not fence, is
  // not.
  const fencedEffectRefused = await connection.db.transaction(async (tx) => {
    try {
      await assertLeadTurnNotFenced(tx, population.cohort.uncertain)
      return false
    } catch (error) {
      if ((error as Error).message !== 'LEAD_TURN_FENCED') throw error
      return true
    }
  })
  const controlEffectAllowed = await connection.db.transaction(async (tx) => {
    await assertLeadTurnNotFenced(tx, population.control)
    return true
  })

  const controlState = await readLeadTurnRollbackState(
    connection.db,
    base.workspaceId,
    population.control,
    base.owner
  )
  const cohortStates = {} as Record<
    CohortKey,
    { disposition: LeadTurnRollbackDisposition; fenced: boolean }
  >
  for (const key of COHORT_KEYS) {
    const state = await readLeadTurnRollbackState(
      connection.db,
      base.workspaceId,
      population.cohort[key],
      base.owner
    )
    cohortStates[key] = { disposition: state.disposition, fenced: state.fenced }
  }

  // The window does not resurrect what the cutover withdrew.
  const windowRemovedAdmission = await loadGroupAdmission(
    connection.db,
    base.workspaceId,
    base.groupChannelId,
    { kind: 'user', userId: base.removed.userId }
  )
  const windowRemovedChannel = await settle(() =>
    getChannelForUser(connection.db, base.workspaceId, base.groupChannelId, base.removed)
  )
  const windowMemberChannel = await settle(() =>
    getChannelForUser(connection.db, base.workspaceId, base.groupChannelId, base.member)
  )

  // The point-in-time rollback: the pre-cutover image is restored over the cut-over database.
  await connection.close()
  resources.connection = undefined
  await adminExecute(`drop database "${scratch}" with (force)`)
  await adminExecute(`create database "${scratch}" template "${image}"`)
  connection = await connect()

  // The restored state is read before anything could repair it.
  const restoredLedger = await readLedger(connection)
  const restoredIntents = await connection.db.execute<IntentProjection>(INTENT_PROJECTION)
  const restoredRuntimes = await connection.db.execute<RuntimeProjection>(RUNTIME_PROJECTION)
  const restoredFenceColumnsExist = await fenceColumnsExist(connection)
  const restoredGroupTablesExist = await groupTablesExist(connection)
  const restoredMessages = await connection.db.execute<{ id: string }>(sql`
    select id::text as id from app.messages order by id`)
  // The preflight accepts the restored target as well: the recovery is forward-only.
  const restoredPreflight = await preflightOutcome(connection)

  // The forward-only recovery: the current chain is applied to the restored populated database.
  await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR, ...MIGRATION_OPTIONS })
  const recoveredLedger = await readLedger(connection)
  const recoveredIntents = await connection.db.execute<IntentProjection>(INTENT_PROJECTION)
  const recoveredFence = await connection.db.execute<FenceProjection>(FENCE_PROJECTION)
  const recoveredRuntimes = await connection.db.execute<RuntimeProjection>(RUNTIME_PROJECTION)
  const recoveredGroupTablesExist = await groupTablesExist(connection)
  const recoveredReconciliation = await reconcileLegacyAudience(connection.db)
  const recoveredAudience = await captureGroupAudienceParticipants(connection.db, base.workspaceId)

  // The cohort has to be fenced again: the restore rolled the fence back with the schema.
  const refences = {} as Record<CohortKey, FenceOutcome>
  for (const key of COHORT_KEYS) {
    const outcome = await fenceLeadTurnForRollback(
      connection.db,
      base.workspaceId,
      population.cohort[key],
      fenceRequest
    )
    refences[key] = {
      disposition: outcome.disposition,
      fenced: outcome.fenced,
      alreadyFenced: outcome.alreadyFenced,
      ...(outcome.attribution ? { attribution: outcome.attribution } : {}),
    }
  }

  return {
    target: disposable,
    scratch,
    image,
    journal,
    prefixCount,
    memberUserId: base.member.userId,
    removedUserId: base.removed.userId,
    historicalLedger,
    historicalIntents,
    historicalRuntimes,
    historicalFenceColumnsExist,
    historicalGroupTablesExist,
    historicalPreflight,
    cutoverLedger,
    cutoverIntents,
    cutoverFence,
    cutoverRuntimes,
    cutoverGroupTablesExist,
    cutoverPreflight,
    reconciliation,
    quarantineRows,
    audience,
    quarantinedAdmission,
    admittedAdmission,
    removedChannel,
    memberChannel,
    removedMessages,
    memberMessages,
    fences,
    repeatFences,
    fencedEffectRefused,
    controlEffectAllowed,
    controlState: { disposition: controlState.disposition, fenced: controlState.fenced },
    cohortStates,
    windowRemovedAdmission,
    windowRemovedChannel,
    windowMemberChannel,
    restoredLedger,
    restoredIntents,
    restoredRuntimes,
    restoredFenceColumnsExist,
    restoredGroupTablesExist,
    restoredPreflight,
    restoredMessageIds: restoredMessages.map((row) => row.id),
    seededMessageIds: population.messageIds,
    recoveredLedger,
    recoveredIntents,
    recoveredFence,
    recoveredRuntimes,
    recoveredGroupTablesExist,
    recoveredReconciliation,
    recoveredAudience,
    refences,
  }
}

const resources: RehearsalResources & { image?: string } = {}
let scenario: Promise<Scenario> | undefined

function runScenario(): Promise<Scenario> {
  scenario ??= executeScenario()
  return scenario
}

describe.skipIf(!provisioningUrl && !inCi)(
  'populated migration rollback outcome qualification (#1219/#1222/#1220)',
  () => {
    beforeAll(async () => {
      await runScenario()
    }, 600_000)

    afterAll(async () => {
      const pending = scenario
      scenario = undefined
      if (pending) await pending.catch(() => undefined)
      const image = resources.image
      await disposeRehearsal(resources, async (database) => {
        const failures: unknown[] = []
        for (const name of [database, ...(image ? [image] : [])]) {
          try {
            if (name.startsWith(IMAGE_PREFIX)) assertImage(name)
            else assertScratch(name)
            await adminExecute(`drop database if exists "${name}" with (force)`)
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'the disposable databases could not be dropped')
        }
      })
    }, 300_000)

    test("the disposable target is a validated loopback instance, and every database name carries this run's prefix", async () => {
      const { scratch, image, target: disposable } = await runScenario()
      expect(disposable.host).toBe('127.0.0.1')
      expect(scratch.startsWith(SCRATCH_PREFIX)).toBe(true)
      expect(image.startsWith(IMAGE_PREFIX)).toBe(true)
      // The image name must not also pass as a scratch name, so a drop can never confuse them.
      expect(scratch.startsWith(IMAGE_PREFIX)).toBe(false)
      expect(image.startsWith(SCRATCH_PREFIX)).toBe(false)
    })

    test("the populated historical database holds exactly the repository's journal prefix, and its ledger is the historical one", async () => {
      const { historicalLedger, journal, prefixCount } = await runScenario()
      expect(prefixCount).toBeGreaterThan(0)
      expect(historicalLedger).toHaveLength(prefixCount)
      // The ledger rows are the historical migrations, byte for byte, at their historical
      // timestamps. A ledger that only had the right count would prove nothing.
      const prefix = journal.slice(0, prefixCount)
      for (const [index, entry] of prefix.entries()) {
        const row = historicalLedger[index]
        expect(row).toBeDefined()
        expect(row?.hash).toBe(migrationHash(entry.tag))
        expect(row?.created_at).toBe(String(entry.when))
      }
    })

    test('the migration-history preflight accepts the populated target, and the cutover advances the ledger to the current chain', async () => {
      const { historicalLedger, cutoverLedger, journal, historicalPreflight, cutoverPreflight } =
        await runScenario()
      expect(historicalPreflight).toEqual({ accepted: true, reason: null })
      expect(cutoverPreflight).toEqual({ accepted: true, reason: null })
      expect(historicalLedger.length).toBeGreaterThan(0)
      expect(cutoverLedger).toHaveLength(journal.length)
      // The cutover kept the historical rows and appended the rest: no applied migration moved.
      for (const [index, row] of cutoverLedger.entries()) {
        expect(row.hash).toBe(migrationHash(journal[index]!.tag))
        expect(row.created_at).toBe(String(journal[index]!.when))
      }
    })

    test('the cutover carries the in-flight admissions across and invents no rollback fence for them', async () => {
      const {
        historicalIntents,
        cutoverIntents,
        historicalRuntimes,
        cutoverRuntimes,
        cutoverFence,
        historicalFenceColumnsExist,
        historicalGroupTablesExist,
        cutoverGroupTablesExist,
      } = await runScenario()
      expect(historicalIntents.length).toBeGreaterThanOrEqual(5)
      // The historical schema had neither the fence columns nor the canonical group authority:
      // the cutover is what introduced them.
      expect(historicalFenceColumnsExist).toBe(false)
      expect(historicalGroupTablesExist).toBe(false)
      expect(cutoverGroupTablesExist).toBe(true)
      // Every column the historical schema had is unchanged by the cutover.
      expect(cutoverIntents).toEqual(historicalIntents)
      // The runtime evidence is unchanged too: the cutover resolved nothing.
      expect(cutoverRuntimes).toEqual(historicalRuntimes)
      // The fence columns arrived null, and so did every column the later migrations added. A
      // migration that invented a fence would show one here.
      expect(cutoverFence).toHaveLength(historicalIntents.length)
      for (const row of cutoverFence) {
        expect(row.rollback_fenced_at).toBeNull()
        expect(row.rollback_fence_actor_kind).toBeNull()
        expect(row.rollback_fence_actor_ref).toBeNull()
        expect(row.rollback_fence_reason).toBeNull()
        expect(row.rollback_fence_authority).toBeNull()
        expect(row.requested_model_selections).toBeNull()
        expect(row.handoff_target_session_id).toBeNull()
        expect(row.handoff_target_generation).toBeNull()
        expect(row.handoff_target_task_id).toBeNull()
        expect(row.handoff_target_attempt).toBeNull()
      }
    })

    test('the ambiguous legacy audience is quarantined with provenance, and the clean member keeps the channel', async () => {
      const {
        reconciliation,
        quarantineRows,
        audience,
        memberUserId,
        removedUserId,
        quarantinedAdmission,
        admittedAdmission,
        removedChannel,
        memberChannel,
        removedMessages,
        memberMessages,
      } = await runScenario()
      // The departed participant is quarantined, with a recorded reason and a preserved source.
      expect(reconciliation.quarantined).toBeGreaterThanOrEqual(1)
      expect(reconciliation.quarantinedByReason.user_not_workspace_member).toBeGreaterThanOrEqual(1)
      expect(reconciliation.invariants.originalsPreserved).toBe(true)
      expect(reconciliation.invariants.quarantineCoversClassification).toBe(true)
      expect(reconciliation.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(reconciliation.quarantineDigest).toMatch(/^[0-9a-f]{64}$/)
      // The provenance names the exact backfill source the classification was made against, and
      // it names the principal it withheld.
      const withheld = quarantineRows.find((row) => row.principal_id === removedUserId)
      expect(withheld).toBeDefined()
      expect(withheld?.reason).toBe('user_not_workspace_member')
      expect(withheld?.principal_kind).toBe('user')
      expect(withheld?.profile).toBe(legacyBackfillProfile())
      expect(withheld?.source_row_digest).toMatch(/^[0-9a-f]{64}$/)
      expect(withheld?.withdrawn_digest).toMatch(/^[0-9a-f]{64}$/)
      expect(quarantineRows.some((row) => row.principal_id === memberUserId)).toBe(false)
      // The clean member keeps its admission; the quarantined principal has none.
      expect(quarantinedAdmission).toBeNull()
      expect(admittedAdmission).not.toBeNull()
      // The channel follows the admission.
      expect(removedChannel).toBe('denied')
      expect(removedMessages).toBe('denied')
      expect(memberChannel).not.toBe('denied')
      expect(memberMessages).not.toBe('denied')
      // The audience names the admitted principals, so an equal count cannot hide a swap.
      expect(audience.admissions.some((key) => key.endsWith(`user:${memberUserId}`))).toBe(true)
      expect(audience.admissions.some((key) => key.endsWith(`user:${removedUserId}`))).toBe(false)
    })

    test('the rollback cohort fence classifies every carried admission, and the uncertainty stays explicit', async () => {
      const { fences } = await runScenario()
      expect(fences.prepared.disposition).toBe('no_effect_recorded')
      expect(fences.uncertain.disposition).toBe('reconcile_uncertain_effect')
      expect(fences.inFlight.disposition).toBe('in_flight_fenced')
      expect(fences.terminal.disposition).toBe('terminal_retained')
      for (const key of COHORT_KEYS) {
        const outcome = fences[key]
        expect(outcome.fenced).toBe(true)
        expect(outcome.alreadyFenced).toBe(false)
        const attribution = outcome.attribution
        expect(attribution).toBeDefined()
        expect(attribution?.actor).toEqual({ kind: 'operator', operatorId: OPERATOR_ID })
        expect(attribution?.reason).toBe('rollback_cohort')
        expect(attribution?.authority.schemaVersion).toBe(1)
        expect(attribution?.authority.disposition).toBe(outcome.disposition)
        expect(attribution?.authority.channelLifecycleState).toBe('active')
        expect(attribution?.authority.actorMembershipId).toBeNull()
      }
      // The uncertain admission is never reported as safe to resume: its disposition names the
      // reconciliation, and no disposition in the cohort is `fence_required`.
      expect(fences.uncertain.disposition).not.toBe('no_effect_recorded')
    })

    test('declaring the window twice keeps the first attribution, and the fence blocks a new effect', async () => {
      const { fences, repeatFences, fencedEffectRefused, controlEffectAllowed } =
        await runScenario()
      for (const key of COHORT_KEYS) {
        expect(repeatFences[key].alreadyFenced).toBe(true)
        expect(repeatFences[key].fenced).toBe(true)
        expect(repeatFences[key].disposition).toBe(fences[key].disposition)
        expect(repeatFences[key].attribution?.fencedAt).toBe(fences[key].attribution?.fencedAt)
        expect(repeatFences[key].attribution?.actor).toEqual(fences[key].attribution?.actor)
      }
      // A fenced admission is refused a new effect, and the refusal is the fence's own. The
      // control the window did not fence is not refused.
      expect(fencedEffectRefused).toBe(true)
      expect(controlEffectAllowed).toBe(true)
    })

    test('an admission outside the cohort stays unfenced and is reported as fence_required', async () => {
      const { controlState, cohortStates } = await runScenario()
      expect(controlState.fenced).toBe(false)
      expect(controlState.disposition).toBe('fence_required')
      // The cohort the window did fence is reported as fenced.
      for (const key of COHORT_KEYS) {
        expect(cohortStates[key].fenced).toBe(true)
        expect(cohortStates[key].disposition).toBe(
          key === 'prepared'
            ? 'no_effect_recorded'
            : key === 'uncertain'
              ? 'reconcile_uncertain_effect'
              : key === 'inFlight'
                ? 'in_flight_fenced'
                : 'terminal_retained'
        )
      }
    })

    test('the rollback window does not resurrect the withdrawn audience', async () => {
      const { windowRemovedAdmission, windowRemovedChannel, windowMemberChannel } =
        await runScenario()
      expect(windowRemovedAdmission).toBeNull()
      expect(windowRemovedChannel).toBe('denied')
      expect(windowMemberChannel).not.toBe('denied')
    })

    test('the point-in-time restore rolls the populated database back to its historical schema and ledger', async () => {
      const {
        restoredLedger,
        restoredIntents,
        restoredRuntimes,
        restoredFenceColumnsExist,
        restoredGroupTablesExist,
        restoredPreflight,
        restoredMessageIds,
        seededMessageIds,
        journal,
        prefixCount,
        historicalIntents,
        historicalRuntimes,
      } = await runScenario()
      // The preflight accepts the restored target: its ledger is a prefix of the candidate, so
      // the recovery is forward-only and nothing would be skipped.
      expect(restoredPreflight).toEqual({ accepted: true, reason: null })
      // The ledger is the historical one: the restore carried the migration ledger back.
      expect(restoredLedger).toHaveLength(prefixCount)
      expect(restoredLedger[0]?.hash).toBe(migrationHash(journal[0]!.tag))
      // The fence columns do not exist at all on the restored schema, and neither do the
      // canonical group authority tables.
      expect(restoredFenceColumnsExist).toBe(false)
      expect(restoredGroupTablesExist).toBe(false)
      // The populated population came back unchanged, evidence included: the uncertain attempt
      // is still uncertain after the rollback.
      expect(restoredIntents).toEqual(historicalIntents)
      expect(restoredRuntimes).toEqual(historicalRuntimes)
      // Every seeded message is still there, and only those: the restore lost nothing and
      // invented nothing.
      expect(restoredMessageIds.toSorted()).toEqual(seededMessageIds.toSorted())
    })

    test('the forward-only recovery re-applies the cutover without loss and invents no fence', async () => {
      const {
        recoveredLedger,
        recoveredIntents,
        recoveredFence,
        recoveredRuntimes,
        recoveredGroupTablesExist,
        journal,
        historicalIntents,
        historicalRuntimes,
      } = await runScenario()
      expect(recoveredLedger).toHaveLength(journal.length)
      // The canonical group authority is back: the recovery re-applied the whole current chain.
      expect(recoveredGroupTablesExist).toBe(true)
      // The population survived the rollback and the recovery unchanged.
      expect(recoveredIntents).toEqual(historicalIntents)
      expect(recoveredRuntimes).toEqual(historicalRuntimes)
      // The recovery invented no fence either.
      for (const row of recoveredFence) {
        expect(row.rollback_fenced_at).toBeNull()
        expect(row.rollback_fence_actor_kind).toBeNull()
        expect(row.rollback_fence_actor_ref).toBeNull()
        expect(row.rollback_fence_reason).toBeNull()
        expect(row.rollback_fence_authority).toBeNull()
      }
    })

    test('the quarantine provenance is re-established after the rollback, for the same principals', async () => {
      const { reconciliation, recoveredReconciliation, audience, recoveredAudience } =
        await runScenario()
      // The source rows are the same rows, so their digest is the same digest.
      expect(recoveredReconciliation.sourceDigest).toBe(reconciliation.sourceDigest)
      // The same principals are quarantined, for the same reasons.
      expect(recoveredReconciliation.quarantined).toBe(reconciliation.quarantined)
      expect(recoveredReconciliation.quarantinedByReason).toEqual(
        reconciliation.quarantinedByReason
      )
      expect(recoveredReconciliation.admissibleRows).toBe(reconciliation.admissibleRows)
      expect(recoveredReconciliation.invariants.originalsPreserved).toBe(true)
      expect(recoveredReconciliation.invariants.quarantineCoversClassification).toBe(true)
      // The derived authority is the same authority, granted to the same principals.
      expect(recoveredAudience.admissions).toEqual(audience.admissions)
      expect(recoveredAudience.audienceGrants).toEqual(audience.audienceGrants)
      expect(recoveredAudience.enlistmentGrants).toEqual(audience.enlistmentGrants)
    })

    test('the cohort must be fenced again after the rollback, and the dispositions are the same', async () => {
      const { fences, refences } = await runScenario()
      for (const key of COHORT_KEYS) {
        expect(refences[key].alreadyFenced).toBe(false)
        expect(refences[key].fenced).toBe(true)
        // The evidence survived the rollback, so the classification is the same one.
        expect(refences[key].disposition).toBe(fences[key].disposition)
        expect(refences[key].attribution?.actor).toEqual({
          kind: 'operator',
          operatorId: OPERATOR_ID,
        })
      }
    })
  }
)

describe('the rollback qualification boundary (no database needed)', () => {
  test('an inherited target that is not a loopback address is refused', () => {
    expect(() =>
      parseLocalDisposableTarget('postgresql://user:pass@db.example.com:5432/postgres')
    ).toThrow(/loopback/)
  })

  test("a database name that does not carry this run's prefix is refused", () => {
    expect(() => assertScratchDatabaseName('someone_elses_database', SCRATCH_PREFIX)).toThrow(
      /scratch names need/
    )
    expect(() => assertScratchDatabaseName('someone_elses_database', IMAGE_PREFIX)).toThrow(
      /scratch names need/
    )
  })
})
