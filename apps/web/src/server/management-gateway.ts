/**
 * Shared management gateway (M14.03.1, adea-ai/adea#1215).
 *
 * Human HTTP controls and lead tools execute management operations through
 * this one gateway: the inventory decides whether the operation is callable on
 * the caller's lane, the shared authorization API decides access for the same
 * user principal both paths carry, and the existing executor performs the
 * mutation. The gateway never mints authority: a lead caller must carry an
 * immutable CP-issued decision that is revalidated against the exact operation,
 * workspace, target and input binding before anything is authorized or run.
 *
 * Device-local operations stay on their authorized local APIs; a cloud caller
 * receives `device_required` instead of an inferred grant. Every authority,
 * authorization, audit and upstream failure is projected to a bounded typed
 * failure; a mismatched decision performs zero authorization and zero
 * executor calls.
 *
 * No `server-only` marker: Bun-run unit tests import this module directly.
 */
import type { UserPrincipalRef, WorkspacePermission } from '@adea-ai/types'
import {
  managementOperationSupport,
  managementOperations,
  validateManagementAuthorityDecision,
  type ManagementAuthorityDecision,
  type ManagementAuthorityReasonCode,
  type ManagementCallBinding,
  type ManagementCurrentAuthority,
  type ManagementOperationId,
  type ManagementUnsupportedReason,
} from '@adea-ai/types/management'

export type ManagementAuthorityReference = Readonly<{
  authorityRef: string
  intentId: string
  leadAgentId: string
}>

export type ManagementCaller =
  | Readonly<{ kind: 'human' }>
  | Readonly<{
      kind: 'lead'
      /** The exact authority reference the canonical turn resolved. */
      reference: ManagementAuthorityReference
      /** Immutable CP decision for the exact call; never a bare reference. */
      decision: ManagementAuthorityDecision
    }>

export type ManagementFailureCode =
  | 'authority_required'
  | 'conflict'
  | 'forbidden'
  | 'stale_revision'
  | 'unavailable'
  | 'unsupported'

export type ManagementFailureReason = ManagementAuthorityReasonCode | ManagementUnsupportedReason

export type ManagementFailure = Readonly<{
  code: ManagementFailureCode
  message: string
  operation: ManagementOperationId
  reason?: ManagementFailureReason
}>

export type ManagementOutcome<T> =
  | Readonly<{ ok: true; operation: ManagementOperationId; value: T }>
  | Readonly<{ ok: false; failure: ManagementFailure }>

/** The existing authorization decision audit, extended with lead attribution. */
export type ManagementAuditDecision = Readonly<{
  caller: ManagementCaller
  decision: 'allowed' | 'denied'
  operation: ManagementOperationId
  permission: WorkspacePermission
  principal: UserPrincipalRef
  reason: 'lead_management_allowed' | 'lead_management_denied'
  workspaceId: string
  /** Present only for a lead decision, naming the exact consumed approval. */
  authorityRef?: string
  decisionId?: string
  binding?: ManagementCallBinding
}>

export type ManagementAuthorizationInput = Readonly<{
  includeArchived?: boolean
  permission: WorkspacePermission
  principal: UserPrincipalRef
  workspaceId: string
}>

export type ManagementGatewayDependencies = Readonly<{
  /** The shared authorization API; its own callback records the user decision. */
  authorize(input: ManagementAuthorizationInput): Promise<boolean>
  /** The shared audit API consulted to attribute an inherited lead action. */
  audit?(record: ManagementAuditDecision): Promise<void>
  /**
   * Per-delivery CP current-authority/consumption assertion immediately before
   * the effect. Resolves void or throws; absent means the caller has no wired
   * current-authority owner and the lead action is refused before execution.
   */
  assertCurrent?: ManagementCurrentAuthority
}>

export type ManagementRunInput = Readonly<{
  /** Exact-call binding required for a lead caller and revalidated here. */
  binding?: ManagementCallBinding
  includeArchived?: boolean
  principal: UserPrincipalRef
  workspaceId: string
}>

export type ManagementGateway = Readonly<{
  caller: ManagementCaller
  run<T>(
    operation: ManagementOperationId,
    input: ManagementRunInput,
    execute: () => Promise<T>
  ): Promise<ManagementOutcome<T>>
}>

const KNOWN_REVISIONS = new Set(['Workspace version conflict', 'Workspace order conflict'])
const KNOWN_ORDER_CONFLICTS = new Set(['Project order conflict'])

/**
 * Bounded error projection: only the exact known refusal maps to a specific
 * code, and everything else collapses to one fixed message so internal error
 * text can never reach a management caller.
 */
export function managementFailure(
  operation: ManagementOperationId,
  error: unknown
): ManagementFailure {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : ''
  const known = new Set([name, message])
  const matches = (candidates: ReadonlySet<string>) =>
    [...candidates].some((candidate) => known.has(candidate))

  if (matches(KNOWN_REVISIONS) || matches(KNOWN_ORDER_CONFLICTS))
    return Object.freeze({
      code: 'stale_revision' as const,
      message: 'Management target changed; refresh and retry',
      operation,
    })
  if (known.has('Project id conflict'))
    return Object.freeze({
      code: 'conflict' as const,
      message: 'Management target already exists',
      operation,
    })
  if (known.has('WorkspaceCleanupRequiredError') || known.has('Workspace cleanup required'))
    return Object.freeze({
      code: 'conflict' as const,
      message: 'Management target requires cleanup before this operation',
      operation,
    })
  if (
    known.has('WorkspacePersonalProtectedError') ||
    known.has('Project sharing forbidden') ||
    known.has('Project read-only') ||
    known.has('WorkspacePersonalProtected')
  )
    return Object.freeze({
      code: 'forbidden' as const,
      message: 'Management operation is forbidden',
      operation,
    })
  if (known.has('Project unavailable') || known.has('Workspace unavailable'))
    return Object.freeze({
      code: 'unavailable' as const,
      message: 'Management target is unavailable',
      operation,
    })
  return Object.freeze({
    code: 'unavailable' as const,
    message: 'Management operation is unavailable',
    operation,
  })
}

function authorityFailure(
  operation: ManagementOperationId,
  reason: ManagementAuthorityReasonCode
): ManagementFailure {
  return Object.freeze({
    code: 'authority_required' as const,
    message: 'Lead management authority is unavailable',
    operation,
    reason,
  })
}

function unsupportedFailure(
  operation: ManagementOperationId,
  reason: ManagementUnsupportedReason
): ManagementFailure {
  return Object.freeze({
    code: 'unsupported' as const,
    message: 'Management operation is not available on this lane',
    operation,
    reason,
  })
}

export function createManagementGateway(
  dependencies: ManagementGatewayDependencies,
  caller: ManagementCaller,
  now: () => number = Date.now
): ManagementGateway {
  return Object.freeze({
    caller,
    async run<T>(
      operation: ManagementOperationId,
      input: ManagementRunInput,
      execute: () => Promise<T>
    ): Promise<ManagementOutcome<T>> {
      const lane = caller.kind === 'lead' ? 'lead' : 'web'
      const support = managementOperationSupport(operation, lane)
      if (support.state === 'unsupported')
        return Object.freeze({ failure: unsupportedFailure(operation, support.reason), ok: false })

      let binding: ManagementCallBinding | undefined
      if (caller.kind === 'lead') {
        const decision = caller.decision
        if (!decision || decision.schemaVersion !== 'adea-management-authority/v1')
          return Object.freeze({
            failure: authorityFailure(operation, 'authority_malformed'),
            ok: false,
          })
        binding = input.binding
        if (!binding)
          return Object.freeze({
            failure: authorityFailure(operation, 'authority_binding_mismatch'),
            ok: false,
          })
        const invalid =
          validateManagementAuthorityDecision(decision, {
            authorityRef: caller.reference.authorityRef,
            binding,
            intentId: caller.reference.intentId,
            leadAgentId: caller.reference.leadAgentId,
            now: now(),
          }) ?? bindingOperationMismatch(operation, input, decision, binding)
        if (invalid)
          return Object.freeze({ failure: authorityFailure(operation, invalid), ok: false })
      }

      const permission = permissionFor(operation)
      const first = await checkAuthority(dependencies, input, permission)
      if ('failed' in first) return failureOutcome<T>(operation, first.failed)

      if (caller.kind === 'lead' && dependencies.audit) {
        try {
          await dependencies.audit({
            ...(caller.decision.authorityRef ? { authorityRef: caller.decision.authorityRef } : {}),
            ...(input.binding ? { binding: input.binding } : {}),
            caller,
            decision: first.allowed ? 'allowed' : 'denied',
            decisionId: caller.decision.decisionId,
            operation,
            permission,
            principal: input.principal,
            reason: first.allowed ? 'lead_management_allowed' : 'lead_management_denied',
            workspaceId: input.workspaceId,
          })
        } catch {
          // A lead action may not execute without its attribution record.
          return failureOutcome<T>(operation, {
            code: 'unavailable',
            message: 'Management audit is unavailable',
          })
        }
      }
      if (!first.allowed)
        return failureOutcome<T>(operation, {
          code: 'forbidden',
          message: 'Management operation is forbidden',
        })

      // Late authority recheck after the awaited authorize/audit: a membership
      // revocation that lands during those waits must stop the effect.
      const late = await checkAuthority(dependencies, input, permission)
      if ('failed' in late) return failureOutcome<T>(operation, late.failed)
      if (!late.allowed)
        return failureOutcome<T>(operation, {
          code: 'forbidden',
          message: 'Management operation is forbidden',
        })

      if (caller.kind === 'lead') {
        // Per-delivery CP current-authority assertion immediately before the
        // effect, then a final synchronous time/binding recheck after every
        // await so an expired or parked decision cannot execute.
        if (dependencies.assertCurrent) {
          try {
            await dependencies.assertCurrent({
              approval: caller.decision.approval,
              audienceRef: caller.decision.audienceRef,
              authorityRef: caller.decision.authorityRef,
              authorityRevision: caller.decision.authorityRevision,
              binding: binding!,
              decisionId: caller.decision.decisionId,
              intentId: caller.decision.intentId,
              leadAgentId: caller.decision.leadAgentId,
              now: now(),
              planRef: caller.decision.planRef,
              planRevision: caller.decision.planRevision,
              principal: caller.decision.principal,
            })
          } catch {
            return Object.freeze({
              failure: authorityFailure(operation, 'authority_unavailable'),
              ok: false,
            })
          }
        } else {
          // Without a current-authority owner no lead effect may run, even
          // when the signed decision is locally current.
          return Object.freeze({
            failure: authorityFailure(operation, 'authority_unavailable'),
            ok: false,
          })
        }
        const invalid =
          validateManagementAuthorityDecision(caller.decision, {
            authorityRef: caller.reference.authorityRef,
            binding: binding!,
            intentId: caller.reference.intentId,
            leadAgentId: caller.reference.leadAgentId,
            now: now(),
          }) ?? bindingOperationMismatch(operation, input, caller.decision, binding!)
        if (invalid)
          return Object.freeze({ failure: authorityFailure(operation, invalid), ok: false })
      }

      try {
        return Object.freeze({ ok: true as const, operation, value: await execute() })
      } catch (error) {
        return Object.freeze({ failure: managementFailure(operation, error), ok: false })
      }
    },
  })
}

type AuthorityCheck =
  | Readonly<{ allowed: boolean }>
  | Readonly<{ failed: Readonly<{ code: 'unavailable'; message: string }> }>

async function checkAuthority(
  dependencies: ManagementGatewayDependencies,
  input: ManagementRunInput,
  permission: WorkspacePermission
): Promise<AuthorityCheck> {
  try {
    return Object.freeze({
      allowed: await dependencies.authorize({
        ...(input.includeArchived ? { includeArchived: true } : {}),
        permission,
        principal: input.principal,
        workspaceId: input.workspaceId,
      }),
    })
  } catch {
    return Object.freeze({
      failed: Object.freeze({
        code: 'unavailable' as const,
        message: 'Management authorization is unavailable',
      }),
    })
  }
}

function failureOutcome<T>(
  operation: ManagementOperationId,
  failure: Readonly<{
    code: 'forbidden' | 'unavailable'
    message: string
  }>
): ManagementOutcome<T> {
  return Object.freeze({
    failure: Object.freeze({ ...failure, operation }),
    ok: false,
  })
}

/** The binding must name the operation and workspace actually being run. */
function bindingOperationMismatch(
  operation: ManagementOperationId,
  input: ManagementRunInput,
  decision: ManagementAuthorityDecision,
  binding: ManagementCallBinding
): ManagementAuthorityReasonCode | null {
  if (
    binding.operation !== operation ||
    binding.workspaceId !== input.workspaceId ||
    decision.binding.workspaceId !== input.workspaceId ||
    decision.binding.operation !== operation
  )
    return 'authority_binding_mismatch'
  return null
}

function permissionFor(operation: ManagementOperationId): WorkspacePermission {
  // Only callable cloud operations reach the authorization step; the inventory
  // test guarantees every one of them names a permission.
  const permission = managementOperations[operation].permission
  if (!permission) throw new Error(`Management operation ${operation} has no permission`)
  return permission
}
