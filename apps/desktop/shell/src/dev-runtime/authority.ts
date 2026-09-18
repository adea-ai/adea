// Shared kernel for the M10 #34 grant authorities (roots, vault, grants).
//
// Error codes are the exact `DevErrorCode` strings from the shared Dev Runtime
// contract (`packages/types/src/dev-runtime.ts`); the desktop shell is a
// standalone bundle, so the values are mirrored here and the M10 channel layer
// maps them into `DevError` replies verbatim. Scope mirrors the shared `Scope`
// triple: every record is bound to one account/workspace/runtime node and
// cross-scope access reads as not found so record existence never leaks.
import { randomUUID } from 'node:crypto'

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
}>

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
