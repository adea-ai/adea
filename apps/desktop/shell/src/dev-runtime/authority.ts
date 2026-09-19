// Shared kernel for the M10 #34 grant authorities (roots, vault, grants).
//
// Error codes are the exact `DevErrorCode` strings from the shared Dev Runtime
// contract (`packages/types/src/dev-runtime.ts`); the desktop shell is a
// standalone bundle, so the values are mirrored here and the M10 channel layer
// maps them into `DevError` replies verbatim. Scope mirrors the shared `Scope`
// triple: every record is bound to one account/workspace/runtime node and
// cross-scope access reads as not found so record existence never leaks.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createDurableJsonStore } from './host-store'

export type DevAuthorityCode =
  | 'not_found'
  | 'unauthorized'
  | 'unauthorized_root'
  | 'path_escape'
  | 'symlink_rejected'
  | 'special_file_rejected'
  | 'identity_mismatch'
  | 'invalid_state'
  | 'stale_version'
  | 'corrupt_state'
  | 'unsupported_version'
  | 'auth_required'
  | 'limit_exceeded'

const RETRYABLE_CODES: ReadonlySet<DevAuthorityCode> = new Set(['corrupt_state'])

export class DevAuthorityError extends Error {
  readonly retryable: boolean
  readonly currentVersion?: number

  constructor(
    readonly code: DevAuthorityCode,
    message: string,
    currentVersion?: number
  ) {
    super(message)
    this.name = 'DevAuthorityError'
    this.retryable = RETRYABLE_CODES.has(code)
    if (currentVersion !== undefined) this.currentVersion = currentVersion
  }
}

export type DevScope = Readonly<{
  accountId: string
  workspaceId: string
  runtimeNodeId: string
}>

export type OwnerApproval = Readonly<{
  method: 'owner_dialog' | 'owner_setting'
  reference: string
  /** Optional host-issued binding fields; required by a production verifier. */
  scope?: DevScope
  issuedAt?: string
  expiresAt?: string
}>

export type OwnerApprovalVerifier = Readonly<{
  /**
   * Records that an authoritative owner prompt/setting ISSUED this approval.
   * Consumption below fails closed unless a matching issuance record exists,
   * so a caller-supplied non-empty string is never approval.
   */
  recordIssuance(approval: OwnerApproval, scope: DevScope, action: string): void
  consume(approval: OwnerApproval, scope: DevScope, action: string): void
}>

type IssuedApproval = Readonly<{
  reference: string
  method: string
  action: string
  accountId: string
  workspaceId: string
  runtimeNodeId: string
  issuedAt: string
  expiresAt: string
}>

type StoredApproval = IssuedApproval & Readonly<{ consumedAt?: string }>

const APPROVAL_MAX_LIFETIME_MS = 10 * 60_000

/**
 * Durable single-use approval evidence backed by an authoritative issuance
 * ledger. The host's owner prompt/setting calls `recordIssuance` when the
 * owner actually approves; an authority then consumes that exact record once.
 * Every consumption re-checks scope, action, and the validity window, and a
 * reference is never consumable twice.
 */
export function createOwnerApprovalVerifier(options: {
  dataDir: string
  now?: () => Date
}): OwnerApprovalVerifier {
  const now = options.now ?? (() => new Date())
  const store = createDurableJsonStore<StoredApproval>({
    file: join(options.dataDir, 'dev-runtime', 'approvals', 'consumed.json'),
    schemaVersion: 1,
    label: 'owner approval evidence',
  })

  function assertWellFormed(approval: OwnerApproval, scope: DevScope, action: string): void {
    requireApproval(approval, action)
    if (!approval.scope || !sameScope(approval.scope, scope))
      throw new DevAuthorityError('unauthorized', 'approval scope does not match the request')
    if (typeof approval.issuedAt !== 'string' || typeof approval.expiresAt !== 'string')
      throw new DevAuthorityError(
        'unauthorized',
        'approval evidence is missing its validity window'
      )
    const issued = Date.parse(approval.issuedAt)
    const expires = Date.parse(approval.expiresAt)
    const at = now().getTime()
    if (
      !Number.isFinite(issued) ||
      !Number.isFinite(expires) ||
      issued > at + 30_000 ||
      expires <= issued ||
      expires - issued > APPROVAL_MAX_LIFETIME_MS
    )
      throw new DevAuthorityError(
        'unauthorized',
        'approval evidence has an invalid validity window'
      )
  }

  return {
    recordIssuance(approval, scope, action) {
      assertWellFormed(approval, scope, action)
      const all = [...store.load().records]
      // A reference is single-use for its action even before consumption: an
      // owner prompt re-issued under the same reference replaces nothing.
      if (all.some((entry) => entry.reference === approval.reference && entry.action === action))
        throw new DevAuthorityError('unauthorized', 'approval reference was already issued')
      all.push({
        reference: approval.reference,
        method: approval.method,
        action,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        runtimeNodeId: scope.runtimeNodeId,
        issuedAt: approval.issuedAt!,
        expiresAt: approval.expiresAt!,
      })
      store.save(all)
    },
    consume(approval, scope, action) {
      assertWellFormed(approval, scope, action)
      const all = [...store.load().records]
      const underReference = all.filter((entry) => entry.reference === approval.reference)
      const issued = underReference.find((entry) => entry.action === action)
      if (!issued)
        throw new DevAuthorityError(
          'unauthorized',
          'approval evidence was never issued by an owner prompt'
        )
      // A reference is single-use across every action: any consumed record
      // under this reference makes a fresh consumption a replay.
      if (underReference.some((entry) => entry.consumedAt !== undefined))
        throw new DevAuthorityError('unauthorized', 'approval evidence has already been consumed')
      if (
        issued.method !== approval.method ||
        issued.accountId !== scope.accountId ||
        issued.workspaceId !== scope.workspaceId ||
        issued.runtimeNodeId !== scope.runtimeNodeId ||
        issued.issuedAt !== approval.issuedAt ||
        issued.expiresAt !== approval.expiresAt
      )
        throw new DevAuthorityError('unauthorized', 'approval evidence does not match its issuance')
      const at = now().getTime()
      if (Date.parse(issued.expiresAt) <= at)
        throw new DevAuthorityError('unauthorized', 'approval evidence is expired')
      store.save(
        all.map((entry) =>
          entry.reference === approval.reference && entry.action === action
            ? { ...entry, consumedAt: now().toISOString() }
            : entry
        )
      )
    },
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}

export function newRecordId(): string {
  return randomUUID()
}

const defaultClock = (): Date => new Date()

export function nowIso(clock: () => Date = defaultClock): string {
  return clock().toISOString()
}

/** Cross-scope access reads as not found: record existence never leaks. */
export function sameScope(a: DevScope, b: DevScope): boolean {
  return (
    a.accountId === b.accountId &&
    a.workspaceId === b.workspaceId &&
    a.runtimeNodeId === b.runtimeNodeId
  )
}

export function requireApproval(approval: OwnerApproval | undefined, what: string): OwnerApproval {
  if (!approval)
    throw new DevAuthorityError('unauthorized', `owner approval is required to ${what}`)
  if (
    (approval.method !== 'owner_dialog' && approval.method !== 'owner_setting') ||
    typeof approval.reference !== 'string' ||
    approval.reference.length < 1 ||
    approval.reference.length > 256
  ) {
    throw new DevAuthorityError('unauthorized', `owner approval for ${what} is malformed`)
  }
  return approval
}

export function requireLabel(label: unknown, what: string): string {
  if (typeof label !== 'string' || label.length < 1 || label.length > 128) {
    throw new DevAuthorityError('invalid_state', `${what} label must be 1..128 characters`)
  }
  return label
}
