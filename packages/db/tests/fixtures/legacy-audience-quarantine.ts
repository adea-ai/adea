import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { sql } from 'drizzle-orm'

import type { AgentHqDatabase } from '../../src/connection'

// Isolated legacy-audience quarantine tooling for the #1222 cutover rehearsal. It runs only on
// disposable rehearsal databases (see legacy-audience-quarantine.sql for the boundary). It is not a
// migration, takes no migration number, and is not wired into any production path.
//
// The classification below is the single definition used by quarantine, replay and reconciliation.
// A legacy participant of a group channel is ADMISSIBLE when its channel is active and its principal
// still resolves in the same workspace; otherwise it is QUARANTINED with one stable reason. Nothing is
// guessed: a quarantined principal gets no broader audience than the record already gave it.

export const LEGACY_AUDIENCE_DDL_PATH = `${import.meta.dir}/legacy-audience-quarantine.sql`
export const CANONICAL_BACKFILL_PATH = `${import.meta.dir}/canonical-chain/0050_group_legacy_backfill.sql`

export const LEGACY_AUDIENCE_REASONS = [
  'group_channel_not_active',
  'user_not_workspace_member',
  'agent_workspace_mismatch',
] as const

export type LegacyAudienceReason = (typeof LEGACY_AUDIENCE_REASONS)[number]

const BACKFILL_BREAKPOINT = '--> statement-breakpoint'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The backfill profile names the exact #1232 0050 source it was classified against. */
export function legacyBackfillProfile(): string {
  const digest = sha256Hex(readFileSync(CANONICAL_BACKFILL_PATH, 'utf8'))
  return `legacy-group-audience/0050-group-legacy-backfill@${digest.slice(0, 16)}`
}

/** The canonical 0050 backfill, statement by statement, exactly as drizzle would split it. */
export function canonicalBackfillStatements(): string[] {
  return readFileSync(CANONICAL_BACKFILL_PATH, 'utf8')
    .split(BACKFILL_BREAKPOINT)
    .map((part) => part.replace(/^(\s*--[^\n]*\n)*/g, '').trim())
    .filter((part) => part.length > 0)
}

/** Creates the quarantine table, the digest helper and the withholding triggers. Idempotent. */
export async function installLegacyAudienceQuarantine(db: AgentHqDatabase): Promise<void> {
  await db.execute(sql.raw(readFileSync(LEGACY_AUDIENCE_DDL_PATH, 'utf8')))
}

/**
 * Every group-channel participant row, classified. The reason is null for an admissible row and one
 * of LEGACY_AUDIENCE_REASONS otherwise. The source digest hashes the original participant row.
 */
function classifiedParticipants() {
  return sql`
    select
      cp.id as source_participant_id,
      cp.workspace_id,
      cp.channel_id,
      cp.principal_kind,
      coalesce(cp.user_id, cp.agent_id) as principal_id,
      to_char(ch.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as channel_created_at,
      to_char(cp.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as joined_at,
      app.legacy_participant_digest(cp) as source_row_digest,
      case
        when ch.lifecycle_state <> 'active' then 'group_channel_not_active'
        when cp.principal_kind = 'user' and not exists (
          select 1 from app.workspace_memberships wm
          where wm.workspace_id = cp.workspace_id and wm.user_id = cp.user_id
        ) then 'user_not_workspace_member'
        when cp.principal_kind = 'agent' and not exists (
          select 1 from app.agents ag
          where ag.id = cp.agent_id and ag.workspace_id = cp.workspace_id
        ) then 'agent_workspace_mismatch'
        else null
      end as reason
    from app.channel_participants cp
    join app.channels ch on ch.id = cp.channel_id and ch.workspace_id = cp.workspace_id
    where ch.kind = 'group'
  `
}

export type QuarantineResult = Readonly<{
  /** Quarantine records created by this call (zero on an idempotent replay). */
  recordedNow: number
  /** Derived rows withdrawn by this call, by table. */
  withdrawnNow: Readonly<{ admissions: number; audienceGrants: number; enlistmentGrants: number }>
}>

/**
 * Quarantines every non-admissible legacy participant and withdraws the derived admission and grant
 * rows for those principals in those channels. The original channel_participants rows are never
 * changed. Each withdrawn set is digested before deletion, and the digest is stored on the
 * quarantine record as its provenance. Re-running records nothing new and withdraws nothing again.
 */
export async function quarantineLegacyAudience(
  db: AgentHqDatabase,
  input: Readonly<{ observedAt: string; profile: string }>
): Promise<QuarantineResult> {
  return db.transaction(async (tx) => {
    const recorded = await tx.execute<{ count: number }>(sql`
      with classified as (${classifiedParticipants()}),
      inserted as (
        insert into app.legacy_audience_quarantine (
          workspace_id, channel_id, principal_kind, principal_id, reason,
          source_participant_id, source_row_digest, source_channel_created_at, source_joined_at,
          profile, observed_at
        )
        select
          workspace_id, channel_id, principal_kind, principal_id, reason,
          source_participant_id, source_row_digest, channel_created_at, joined_at,
          ${input.profile}, ${input.observedAt}
        from classified
        where reason is not null
        on conflict (workspace_id, channel_id, principal_kind, principal_id) do nothing
        returning 1
      )
      select count(*)::int as count from inserted
    `)
    const recordedNow = recorded[0]?.count ?? 0

    const pending = await tx.execute<{ id: string }>(sql`
      select id::text as id from app.legacy_audience_quarantine
      where withdrawn_digest is null
      order by id
    `)
    const pendingIds = pending.map((row) => row.id)
    const withdrawnNow = { admissions: 0, audienceGrants: 0, enlistmentGrants: 0 }
    if (pendingIds.length === 0) return { recordedNow, withdrawnNow }

    const doomed = await tx.execute<{
      quarantine_id: string
      kind: string
      row_id: string
      row_json: string
    }>(sql`
      select q.id::text as quarantine_id, 'admission' as kind, a.id::text as row_id,
        to_jsonb(a)::text as row_json
      from app.legacy_audience_quarantine q
      join app.group_admissions a
        on a.workspace_id = q.workspace_id and a.channel_id = q.channel_id
        and a.principal_kind = q.principal_kind
        and coalesce(a.user_id, a.agent_id) = q.principal_id
      where q.withdrawn_digest is null
      union all
      select q.id::text, 'audience', g.id::text, to_jsonb(g)::text
      from app.legacy_audience_quarantine q
      join app.group_audience_grants g
        on g.workspace_id = q.workspace_id and g.channel_id = q.channel_id
        and q.principal_kind = 'user' and g.user_id = q.principal_id
      where q.withdrawn_digest is null
      union all
      select q.id::text, 'enlistment', g.id::text, to_jsonb(g)::text
      from app.legacy_audience_quarantine q
      join app.group_enlistment_grants g
        on g.workspace_id = q.workspace_id and g.channel_id = q.channel_id
        and q.principal_kind = 'agent' and g.agent_id = q.principal_id
      where q.withdrawn_digest is null
    `)

    const byQuarantine = new Map<
      string,
      {
        lines: string[]
        admissions: number
        audience: number
        enlistment: number
        admissionIds: string[]
        audienceIds: string[]
        enlistmentIds: string[]
      }
    >()
    for (const id of pendingIds) {
      byQuarantine.set(id, {
        lines: [],
        admissions: 0,
        audience: 0,
        enlistment: 0,
        admissionIds: [],
        audienceIds: [],
        enlistmentIds: [],
      })
    }
    for (const row of doomed) {
      const entry = byQuarantine.get(row.quarantine_id)
      if (!entry) continue
      entry.lines.push(`${row.kind}:${row.row_id}:${row.row_json}`)
      if (row.kind === 'admission') {
        entry.admissions += 1
        entry.admissionIds.push(row.row_id)
      } else if (row.kind === 'audience') {
        entry.audience += 1
        entry.audienceIds.push(row.row_id)
      } else {
        entry.enlistment += 1
        entry.enlistmentIds.push(row.row_id)
      }
    }

    const admissionIds = [...byQuarantine.values()].flatMap((entry) => entry.admissionIds)
    const audienceIds = [...byQuarantine.values()].flatMap((entry) => entry.audienceIds)
    const enlistmentIds = [...byQuarantine.values()].flatMap((entry) => entry.enlistmentIds)
    // Deleted one id at a time: the sets are the quarantined principals' derived rows only.
    for (const id of admissionIds) {
      await tx.execute(sql`delete from app.group_admissions where id = ${id}::uuid`)
    }
    for (const id of audienceIds) {
      await tx.execute(sql`delete from app.group_audience_grants where id = ${id}::uuid`)
    }
    for (const id of enlistmentIds) {
      await tx.execute(sql`delete from app.group_enlistment_grants where id = ${id}::uuid`)
    }

    for (const [quarantineId, entry] of byQuarantine) {
      const digest = sha256Hex([...entry.lines].toSorted().join('\n'))
      withdrawnNow.admissions += entry.admissions
      withdrawnNow.audienceGrants += entry.audience
      withdrawnNow.enlistmentGrants += entry.enlistment
      await tx.execute(sql`
        update app.legacy_audience_quarantine
        set withdrawn_admissions = ${entry.admissions},
            withdrawn_audience_grants = ${entry.audience},
            withdrawn_enlistment_grants = ${entry.enlistment},
            withdrawn_digest = ${digest}
        where id::text = ${quarantineId} and withdrawn_digest is null
      `)
    }
    return { recordedNow, withdrawnNow }
  })
}

/**
 * Replays the canonical 0050 backfill with the replay setting on, inside its own transaction. The
 * withholding trigger then skips quarantined principals silently, so the backfill cannot re-admit
 * them, and it still admits every admissible row exactly as before.
 */
export async function replayCanonicalBackfill(db: AgentHqDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('adea.legacy_backfill_replay', 'on', true)`)
    for (const statement of canonicalBackfillStatements()) {
      await tx.execute(sql.raw(statement))
    }
  })
}

export type LegacyAudienceReconciliation = Readonly<{
  sourceRows: number
  admissibleRows: number
  quarantined: number
  quarantinedByReason: Readonly<Record<LegacyAudienceReason, number>>
  admissions: number
  audienceGrants: number
  enlistmentGrants: number
  /** Quarantine records whose classification has no record: must be zero. */
  unrecordedClassifications: number
  /** Digest of the original group participant rows. Must not change across quarantine. */
  sourceDigest: string
  /** Digest of the quarantine records, including their withdrawal digests. */
  quarantineDigest: string
  /** Digest of every admission row, by id. */
  admissionsDigest: string
  invariants: Readonly<{
    admissionsEqualAdmissible: boolean
    admissionsPlusQuarantinedEqualSource: boolean
    quarantineCoversClassification: boolean
  }>
}>

/** Read-only reconciliation. Counts and digests cover the quarantined records as well as the admitted. */
export async function reconcileLegacyAudience(
  db: AgentHqDatabase
): Promise<LegacyAudienceReconciliation> {
  const counts = await db.execute<Record<string, number>>(sql`
    with classified as (${classifiedParticipants()})
    select
      (select count(*)::int from classified) as source_rows,
      (select count(*)::int from classified where reason is null) as admissible_rows,
      (select count(*)::int from app.legacy_audience_quarantine) as quarantined,
      (select count(*)::int from app.legacy_audience_quarantine
        where reason = 'group_channel_not_active') as not_active,
      (select count(*)::int from app.legacy_audience_quarantine
        where reason = 'user_not_workspace_member') as user_not_member,
      (select count(*)::int from app.legacy_audience_quarantine
        where reason = 'agent_workspace_mismatch') as agent_mismatch,
      (select count(*)::int from app.group_admissions) as admissions,
      (select count(*)::int from app.group_audience_grants) as audience_grants,
      (select count(*)::int from app.group_enlistment_grants) as enlistment_grants,
      (select count(*)::int from classified c
        where c.reason is not null and not exists (
          select 1 from app.legacy_audience_quarantine q
          where q.workspace_id = c.workspace_id and q.channel_id = c.channel_id
            and q.principal_kind = c.principal_kind and q.principal_id = c.principal_id
        )) as unrecorded
  `)
  const digests = await db.execute<Record<string, string>>(sql`
    select
      coalesce((select encode(sha256(convert_to(string_agg(app.legacy_participant_digest(cp), '|' order by cp.id::text), 'UTF8')), 'hex')
        from app.channel_participants cp
        join app.channels ch on ch.id = cp.channel_id and ch.workspace_id = cp.workspace_id
        where ch.kind = 'group'), '') as source_digest,
      coalesce((select encode(sha256(convert_to(string_agg(concat_ws('|', q.workspace_id, q.channel_id,
          q.principal_kind, q.principal_id, q.reason, q.source_row_digest,
          coalesce(q.withdrawn_digest, ''), coalesce(q.withdrawn_admissions::text, ''),
          coalesce(q.withdrawn_audience_grants::text, ''), coalesce(q.withdrawn_enlistment_grants::text, '')),
          '\n' order by q.workspace_id::text, q.channel_id::text, q.principal_kind::text, q.principal_id::text), 'UTF8')), 'hex')
        from app.legacy_audience_quarantine q), '') as quarantine_digest,
      coalesce((select encode(sha256(convert_to(string_agg(a.id::text || ':' || to_jsonb(a)::text, '\n' order by a.id::text), 'UTF8')), 'hex')
        from app.group_admissions a), '') as admissions_digest
  `)
  const c = counts[0] ?? {}
  const d = digests[0] ?? {}
  const sourceRows = Number(c.source_rows ?? 0)
  const admissibleRows = Number(c.admissible_rows ?? 0)
  const quarantined = Number(c.quarantined ?? 0)
  const admissions = Number(c.admissions ?? 0)
  return {
    sourceRows,
    admissibleRows,
    quarantined,
    quarantinedByReason: {
      group_channel_not_active: Number(c.not_active ?? 0),
      user_not_workspace_member: Number(c.user_not_member ?? 0),
      agent_workspace_mismatch: Number(c.agent_mismatch ?? 0),
    },
    admissions,
    audienceGrants: Number(c.audience_grants ?? 0),
    enlistmentGrants: Number(c.enlistment_grants ?? 0),
    unrecordedClassifications: Number(c.unrecorded ?? 0),
    sourceDigest: d.source_digest ?? '',
    quarantineDigest: d.quarantine_digest ?? '',
    admissionsDigest: d.admissions_digest ?? '',
    invariants: {
      admissionsEqualAdmissible: admissions === admissibleRows,
      admissionsPlusQuarantinedEqualSource: admissions + quarantined === sourceRows,
      quarantineCoversClassification: Number(c.unrecorded ?? 0) === 0,
    },
  }
}
