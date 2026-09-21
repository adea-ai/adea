// The computer-use authority gate (issue #472). Every capture/input decision
// is re-derived here from provider-owned state — a caller or engine claim is
// never trusted (the browser lane's per-hop admission-ledger pattern applied
// to desktop authority):
//
// 1. consent records are issuance-backed: `issue` requires an owner
//    confirmation plus a FRESH #471 permission snapshot whose accessibility
//    row is granted; a denied row routes to the Settings deep link, an
//    unprobeable one refuses with the exact missing piece;
// 2. records are scope/lane/generation-bound, single-use, and expire within
//    CONSENT_TTL_MS of issuance (spec: attach/input tokens ≤60 seconds);
// 3. `verifyFresh` re-probes the permission state at most once per freshness
//    window and refuses when the state moved off the digest the record was
//    minted against. Instant revocation paths (takeover, kill switch) act
//    synchronously on in-memory state, so a probe window never delays a
//    revoke;
// 4. every refusal is counted (bounded, secret-free) for security telemetry
//    (threat model TM-017).
import { randomUUID } from 'node:crypto'

import type { ComputerUseConsent, Scope } from '../../../../../../packages/types/src/dev-runtime'
import type { MacPermissionService } from '../../desktop-permissions'
import type { ComputerUseCapabilityService } from './capability'

/** Consent records live at most 60 seconds (spec: attach/input token cap). */
export const CONSENT_TTL_MS = 60_000
/** How long a fresh permission verification stands before the gate re-probes. */
export const PERMISSION_FRESHNESS_MS = 10_000
/** Bounded ledger; the oldest records fall off first. */
const MAX_CONSENT_RECORDS = 256

export type ComputerUseGateErrorDetails = Readonly<{
  code:
    | 'permission_denied'
    | 'capability_unavailable'
    | 'identity_mismatch'
    | 'profile_scope_denied'
    | 'not_found'
    | 'stale_generation'
    | 'invalid_state'
  message: string
  retryable?: boolean
  remediation?: { action: string; parameters?: Record<string, string> }
}>

export class ComputerUseGateError extends Error {
  readonly code: ComputerUseGateErrorDetails['code']
  readonly retryable: boolean
  readonly remediation?: { action: string; parameters?: Record<string, string> }
  constructor(details: ComputerUseGateErrorDetails) {
    super(details.message)
    this.name = 'ComputerUseGateError'
    this.code = details.code
    this.retryable = details.retryable ?? false
    this.remediation = details.remediation
  }
}

export type ConsentRecord = ComputerUseConsent & { consumed: boolean }

export type ComputerUseConsentGate = Readonly<{
  issue(input: {
    scope: Scope
    lane: { id: string; runtimeSessionId: string; generation: number }
    confirmationId: string
  }): Promise<ComputerUseConsent>
  /**
   * Consumes a record for one authority claim. Single-use: a consumed,
   * expired, wrong-scope, wrong-lane, or wrong-generation id refuses.
   */
  consume(input: {
    consentId: string
    scope: Scope
    laneId: string
    generation: number
  }): ConsentRecord
  /**
   * Re-checks the permission state behind an active grant. Refuses when the
   * record is unknown, was never consumed, the accessibility grant moved, or
   * the snapshot no longer matches the record's digest; otherwise refreshes
   * the freshness window.
   */
  verifyFresh(consentId: string): Promise<void>
  /** Kill switch: drops every record for a lane immediately. */
  revokeForLane(laneId: string): void
  /** Secret-free refusal counters for security telemetry. */
  rejections(): readonly Readonly<{ code: string; count: number }>[]
}>

export function createConsentGate(input: {
  permissions: MacPermissionService
  capabilities: ComputerUseCapabilityService
  now?: () => number
  nowIso?: () => string
  ttlMs?: number
  freshnessMs?: number
}): ComputerUseConsentGate {
  const now = input.now ?? (() => Date.now())
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  const ttlMs = input.ttlMs ?? CONSENT_TTL_MS
  const freshnessMs = input.freshnessMs ?? PERMISSION_FRESHNESS_MS
  const records = new Map<string, ConsentRecord>()
  const rejections = new Map<string, number>()
  /** consentId → last fresh-verification time within the permission window. */
  const freshUntil = new Map<string, number>()

  function refuse(code: ComputerUseGateErrorDetails['code'], message: string, retryable = false) {
    rejections.set(code, (rejections.get(code) ?? 0) + 1)
    return new ComputerUseGateError({ code, message, retryable })
  }

  return {
    async issue({ scope, lane, confirmationId }) {
      // The confirmation is an owner action on a specific lane: it is never
      // optional and never inferred (fail-closed approval semantics).
      if (typeof confirmationId !== 'string' || confirmationId.length === 0)
        throw refuse('permission_denied', 'consent requires an owner confirmation')
      const capabilities = await input.capabilities.report({ force: true })
      const inputRow = capabilities.capabilities.find((row) => row.id === 'input')
      if (!inputRow)
        throw refuse(
          'capability_unavailable',
          'the input capability row is missing from the report'
        )
      if (inputRow.state === 'unavailable') {
        throw new ComputerUseGateError({
          code: 'capability_unavailable',
          message: inputRow.missingPiece ?? 'the input capability is unavailable on this host',
          retryable: true,
        })
      }
      if (inputRow.state === 'denied') {
        throw new ComputerUseGateError({
          code: 'permission_denied',
          message:
            'screen input is refused: the accessibility permission is denied; repair it in ' +
            'System Settings (macOS ignores re-prompts)',
          remediation: { action: 'open_settings', parameters: { permissionId: 'accessibility' } },
        })
      }
      if (inputRow.state === 'not_determined') {
        throw new ComputerUseGateError({
          code: 'permission_denied',
          message:
            'screen input is refused: the accessibility consent prompt is still pending; ' +
            'answer it, then re-check on the permissions page',
          remediation: {
            action: 'request_permission',
            parameters: { permissionId: 'accessibility' },
          },
        })
      }
      if (inputRow.state !== 'available')
        throw refuse('capability_unavailable', 'the input capability did not prove available')

      const createdAt = nowIso()
      const snapshot = await input.permissions.snapshot({ force: true })
      const record: ConsentRecord = {
        consentId: randomUUID(),
        computerUseLaneId: lane.id,
        runtimeSessionId: lane.runtimeSessionId,
        scope: { ...scope },
        generation: lane.generation + 1,
        permissionDigest: input.capabilities.permissionDigest(snapshot),
        createdAt,
        expiresAt: new Date(now() + ttlMs).toISOString(),
        consumed: false,
      }
      // Bounded ledger: drop the oldest record when full.
      if (records.size >= MAX_CONSENT_RECORDS) {
        const oldest = records.keys().next().value
        if (oldest !== undefined) {
          records.delete(oldest)
          freshUntil.delete(oldest)
        }
      }
      records.set(record.consentId, record)
      return record
    },

    consume({ consentId, scope, laneId, generation }) {
      const record = records.get(consentId)
      if (!record) throw refuse('not_found', 'consent record is unknown or already dropped')
      if (record.consumed) throw refuse('permission_denied', 'consent record is single-use')
      if (record.expiresAt <= nowIso())
        throw refuse('permission_denied', 'consent record has expired', true)
      if (
        record.scope.accountId !== scope.accountId ||
        record.scope.workspaceId !== scope.workspaceId ||
        record.scope.runtimeNodeId !== scope.runtimeNodeId
      )
        throw refuse('profile_scope_denied', 'consent record belongs to another scope')
      if (record.computerUseLaneId !== laneId)
        throw refuse('identity_mismatch', 'consent record belongs to another lane')
      if (record.generation !== generation)
        throw refuse('stale_generation', 'consent record binds to another lane generation')
      record.consumed = true
      freshUntil.set(record.consentId, now() + freshnessMs)
      return record
    },

    async verifyFresh(consentId) {
      const record = records.get(consentId)
      if (!record) throw refuse('not_found', 'consent record is unknown or already dropped')
      if (record.consumed === false)
        throw refuse('permission_denied', 'consent record was never consumed')
      const freshThrough = freshUntil.get(consentId) ?? 0
      if (now() < freshThrough) return
      const snapshot = await input.permissions.snapshot({ force: true })
      const accessibility = snapshot.permissions.find((entry) => entry.id === 'accessibility')
      if (snapshot.hostPlatform !== 'macos' || !accessibility || accessibility.state !== 'granted')
        throw refuse('permission_denied', 'the accessibility grant behind this consent moved')
      const digest = input.capabilities.permissionDigest(snapshot)
      if (digest !== record.permissionDigest)
        throw refuse(
          'permission_denied',
          'the permission state behind this consent changed since it was issued'
        )
      freshUntil.set(consentId, now() + freshnessMs)
    },

    revokeForLane(laneId) {
      for (const [consentId, record] of records)
        if (record.computerUseLaneId === laneId) {
          records.delete(consentId)
          freshUntil.delete(consentId)
        }
    },

    rejections: () =>
      [...rejections.entries()]
        .map(([code, count]) => ({ code, count }))
        .toSorted((left, right) => left.code.localeCompare(right.code)),
  }
}
