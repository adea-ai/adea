import { createHash } from 'node:crypto'

import { and, eq, gt, isNull } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import { simLaunchCodes, simSessions } from './schema/sim-launch'

/**
 * Durable launch-code and session storage for hosted Agent Sim. The shapes match the sim-bridge store
 * contract structurally; this package does not import the bridge. Only digests of codes and session values
 * are stored, and every session is bound to the workspace and surface of the code that created it.
 */
export const SIM_SURFACES = ['hq', 'room-designer', 'character-designer'] as const
export type SimSurface = (typeof SIM_SURFACES)[number]

export type SimLaunchBinding = Readonly<{
  workspaceId: string
  bridgeId: string
  origin: string
  surface: SimSurface
}>

export type SimLaunchRedemption =
  | Readonly<{ ok: true; surface: SimSurface }>
  | Readonly<{ ok: false; reason: 'unknown' | 'code_expired' | 'code_used' | 'origin_refused' }>

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Spends a code and, when a session is given, creates that session in the same transaction. The row is
 * locked before it is read, so concurrent presentations serialize and exactly one can spend the code.
 * The expiry decision uses a clock read after the lock is acquired, because a wait behind another
 * transaction can outlast the code. The caller's `now` is only a finiteness check before the transaction.
 * A refusal returns and commits the spend. A failed session insert throws, which rolls the spend back.
 */
async function redeemCore(
  database: AgentHqDatabase,
  clock: () => number,
  code: string,
  presented: Readonly<{ bridgeId: string; origin: string }>,
  now: number,
  session?: Readonly<{ value: string; expiresAt: number }>
): Promise<SimLaunchRedemption> {
  // An unusable clock reading cannot prove the code is still live, so nothing is spent.
  if (!Number.isFinite(now)) return { ok: false, reason: 'code_expired' }
  return database.transaction(async (tx): Promise<SimLaunchRedemption> => {
    const [row] = await tx
      .select()
      .from(simLaunchCodes)
      .where(eq(simLaunchCodes.codeDigest, digest(code)))
      .for('update')
    if (!row) return { ok: false, reason: 'unknown' }
    if (row.consumedAt) return { ok: false, reason: 'code_used' }
    const current = clock()
    if (!Number.isFinite(current)) return { ok: false, reason: 'code_expired' }
    // Spent by the first presentation, whether or not it matches the binding below.
    await tx
      .update(simLaunchCodes)
      .set({ consumedAt: new Date(current) })
      .where(eq(simLaunchCodes.id, row.id))
    if (row.expiresAt.valueOf() <= current) return { ok: false, reason: 'code_expired' }
    if (row.bridgeId !== presented.bridgeId || row.origin !== presented.origin)
      return { ok: false, reason: 'origin_refused' }
    // The check constraint on the table limits the stored surface to SIM_SURFACES.
    const surface = row.surface as SimSurface
    if (session) {
      await tx.insert(simSessions).values({
        sessionDigest: digest(session.value),
        launchCodeId: row.id,
        workspaceId: row.workspaceId,
        surface,
        expiresAt: new Date(session.expiresAt),
      })
    }
    return { ok: true, surface }
  })
}

export type SimLaunchStoreOptions = Readonly<{
  /** The authoritative clock, read after each row lock. Defaults to the system clock. */
  clock?: () => number
}>

export function createSimLaunchStore(
  database: AgentHqDatabase,
  options: SimLaunchStoreOptions = {}
) {
  const clock = options.clock ?? (() => Date.now())
  return {
    async issue(code: string, binding: SimLaunchBinding, expiresAt: number): Promise<void> {
      if (!Number.isFinite(expiresAt)) throw new RangeError('launch code expiry must be finite')
      await database.insert(simLaunchCodes).values({
        codeDigest: digest(code),
        workspaceId: binding.workspaceId,
        surface: binding.surface,
        bridgeId: binding.bridgeId,
        origin: binding.origin,
        expiresAt: new Date(expiresAt),
      })
    },
    redeem(code: string, presented: Readonly<{ bridgeId: string; origin: string }>, now: number) {
      return redeemCore(database, clock, code, presented, now)
    },
    redeemAndSave(
      code: string,
      presented: Readonly<{ bridgeId: string; origin: string }>,
      now: number,
      session: Readonly<{ value: string; expiresAt: number }>
    ) {
      return redeemCore(database, clock, code, presented, now, session)
    },
    /**
     * Sessions are written only by redeemAndSave. This fails closed if a caller tries the separate save.
     */
    save(): never {
      throw new Error('Sim sessions are saved only with their launch code redemption')
    },
  }
}

/** The live session for a value in one workspace, or null when it is unknown, expired, revoked or elsewhere. */
export async function findSimSession(
  database: AgentHqDatabase,
  value: string,
  workspaceId: string,
  now: number
): Promise<Readonly<{ surface: SimSurface; expiresAt: number }> | null> {
  if (!Number.isFinite(now)) return null
  const [row] = await database
    .select()
    .from(simSessions)
    .where(
      and(
        eq(simSessions.sessionDigest, digest(value)),
        eq(simSessions.workspaceId, workspaceId),
        isNull(simSessions.revokedAt),
        gt(simSessions.expiresAt, new Date(now))
      )
    )
    .limit(1)
  return row ? { surface: row.surface as SimSurface, expiresAt: row.expiresAt.valueOf() } : null
}

/** Revokes a live session. Returns false when there was no live session to revoke. */
export async function revokeSimSession(
  database: AgentHqDatabase,
  value: string,
  now: number
): Promise<boolean> {
  if (!Number.isFinite(now)) return false
  const rows = await database
    .update(simSessions)
    .set({ revokedAt: new Date(now) })
    .where(and(eq(simSessions.sessionDigest, digest(value)), isNull(simSessions.revokedAt)))
    .returning({ id: simSessions.id })
  return rows.length === 1
}
