// Durable cleanup-policy authority for #424.
//
// A CleanupPolicy is the reusable project-level approval the spec requires
// before ANY automatic background cleanup may run: it is created as a draft,
// approved once through a single-use owner approval, and later evaluated per
// worktree. Evaluation observes facts only and always returns
// `executesNothing: true` — it never executes a cleanup step. Every fact the
// predicates need comes from the injected `worktreeFacts` seam; when the
// facts are unavailable the evaluation fails closed (blockers with
// `capability_unavailable`, matched=false), so an unprovable state can never
// satisfy an automatic policy.
//
// The policy store is a durable atomic JSON store: reads fail closed on
// corruption (`corrupt_state`) and never rewrite the unread file, matching
// the project/session authority's contract.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CleanupBlocker,
  CleanupPolicy,
  CleanupPolicyEvaluation,
  CleanupPredicate,
  DevCommand,
  DevError,
  DevErrorCode,
  DevOperation,
  DevRuntimePage,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import { DevAuthorityError } from '../authority'
import type { ChannelAuthority } from '../channel/authority'
import type { OwnerApprovalVerifier } from '../authority'
import { createDurableJsonStore } from '../host-store'

const POLICY_STORE_FILE = join('dev-runtime', 'resources', 'cleanup-policies.json')
const POLICY_SCHEMA_VERSION = 1

export type CleanupFacts = Readonly<Record<string, string>>

export type CleanupPolicyAuthorityInput = Readonly<{
  authority: ChannelAuthority
  dataDir: string
  scope: Scope
  /** Single-use owner approvals; without it approval fails closed. */
  approvalVerifier?: OwnerApprovalVerifier
  /** Live worktree facts (git state, leases, owned resources) for one
   *  worktree. Returning undefined fails the evaluation closed. The census
   *  seam may observe asynchronously, so the facts function may resolve a
   *  promise; either shape is awaited. */
  worktreeFacts?: (
    worktreeId: string
  ) => CleanupFacts | undefined | Promise<CleanupFacts | undefined>
  now?: () => number
  randomId?: () => string
}>

export type CleanupPolicyAuthority = Readonly<{
  providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>>
  /** Read-only projection for sibling slices and tests. */
  policies(): readonly CleanupPolicy[]
}>

const POLICY_STATES: ReadonlySet<string> = new Set([
  'draft',
  'approved',
  'disabled',
  'expired',
  'superseded',
])

type StoredPolicy = Readonly<{
  id: string
  scope: Scope
  projectId: string
  version: number
  state: CleanupPolicy['state']
  approvedBy?: string
  approvedAt?: string
  expiresAt?: string
  predicates: CleanupPredicate[]
  allowedSteps: CleanupPolicy['allowedSteps']
}>

function isScope(value: unknown): value is Scope {
  const record = value as Scope | undefined
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.accountId === 'string' &&
    typeof record.workspaceId === 'string' &&
    typeof record.runtimeNodeId === 'string'
  )
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function validateStoredPolicies(policies: readonly StoredPolicy[]): void {
  for (const policy of policies) {
    if (
      typeof policy !== 'object' ||
      policy === null ||
      typeof policy.id !== 'string' ||
      typeof policy.projectId !== 'string' ||
      !Number.isSafeInteger(policy.version) ||
      policy.version < 1 ||
      !POLICY_STATES.has(policy.state) ||
      !Array.isArray(policy.predicates) ||
      !Array.isArray(policy.allowedSteps) ||
      !isScope(policy.scope)
    )
      throw new DevAuthorityError('corrupt_state', 'cleanup policy failed to decode')
  }
}

function devError(code: DevErrorCode, message: string, currentVersion?: number): DevError {
  return {
    code,
    retryable: false,
    message,
    ...(currentVersion !== undefined ? { currentVersion } : {}),
  }
}

function page<T>(items: readonly T[]): DevRuntimePage<T> {
  return { items: [...items], observedAt: new Date().toISOString() }
}

/** Predicate → blocker code mapping for failed automatic-cleanup facts. */
const PREDICATE_BLOCKER: Record<CleanupPredicate['kind'], DevErrorCode> = {
  clean: 'dirty',
  pushed: 'unpushed',
  pull_request_merged: 'cleanup_blocked',
  no_active_leases: 'leased',
  no_active_owned_resources: 'external_ownership',
  archived_for: 'cleanup_blocked',
}

/** Pure predicate evaluation against the facts record. Every required fact
 * is a string; a missing fact fails that predicate (never defaults to
 * satisfied). */
export function evaluatePredicates(
  predicates: readonly CleanupPredicate[],
  facts: CleanupFacts
): { matched: boolean; blockers: CleanupBlocker[] } {
  const blockers: CleanupBlocker[] = []
  for (const predicate of predicates) {
    let satisfied: boolean
    switch (predicate.kind) {
      case 'clean':
        satisfied = facts['clean'] === 'true'
        break
      case 'pushed':
        satisfied = facts['pushed'] === 'true'
        break
      case 'pull_request_merged':
        satisfied = facts['pr_merged'] === 'true'
        break
      case 'no_active_leases':
        satisfied = facts['active_leases'] === '0'
        break
      case 'no_active_owned_resources':
        satisfied = facts['active_owned_resources'] === '0'
        break
      case 'archived_for': {
        const seconds = Number.parseInt(facts['archived_seconds'] ?? '', 10)
        satisfied = Number.isFinite(seconds) && seconds >= predicate.seconds
        break
      }
    }
    if (!satisfied) {
      blockers.push({
        code: PREDICATE_BLOCKER[predicate.kind],
        message: `automatic cleanup predicate '${predicate.kind}' is not satisfied by the current facts`,
      })
    }
  }
  return { matched: blockers.length === 0, blockers }
}

export function createCleanupPolicyAuthority(
  input: CleanupPolicyAuthorityInput
): CleanupPolicyAuthority {
  const now = input.now ?? Date.now
  const randomId = input.randomId ?? randomUUID
  const store = createDurableJsonStore<StoredPolicy>({
    file: join(input.dataDir, POLICY_STORE_FILE),
    schemaVersion: POLICY_SCHEMA_VERSION,
    label: 'cleanup policy',
  })
  const storeFile = join(input.dataDir, POLICY_STORE_FILE)
  let policies: StoredPolicy[] = existsSync(storeFile)
    ? (() => {
        const loaded = store.load().records
        validateStoredPolicies(loaded)
        for (const policy of loaded) {
          if (!sameScope(policy.scope, input.scope))
            throw new DevAuthorityError(
              'corrupt_state',
              'cleanup policy store belongs to another scope'
            )
        }
        return [...loaded]
      })()
    : []
  const save = () => store.save(policies)

  const findPolicy = (id: string): StoredPolicy => {
    const policy = policies.find((entry) => entry.id === id)
    if (!policy) throw devError('not_found', `cleanup policy ${id} is unknown`)
    return policy
  }

  function requireScope(command: DevCommand): void {
    if (!sameScope(command.scope, input.scope))
      throw devError('unauthorized', 'cleanup policy scope is not authorized')
  }

  const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
    'dev.cleanupPolicy.createDraft': (command) => {
      requireScope(command)
      if (command.resource !== undefined)
        throw devError('identity_mismatch', 'createDraft carries no resource binding')
      const body = devOperationDecoders['dev.cleanupPolicy.createDraft'].request(command.body)
      const expiresAt = body.expiresAt as string | undefined
      if (expiresAt !== undefined && Date.parse(expiresAt) <= now())
        throw devError('invalid_state', 'the policy expiry must be in the future')
      const policy: StoredPolicy = {
        id: randomId(),
        scope: input.scope,
        projectId: body.projectId as string,
        version: 1,
        state: 'draft',
        predicates: structuredClone(body.predicates) as CleanupPredicate[],
        allowedSteps: structuredClone(body.allowedSteps) as CleanupPolicy['allowedSteps'],
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      }
      policies = [...policies, policy]
      save()
      return policy
    },

    'dev.cleanupPolicy.approve': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.cleanupPolicy.approve'].request(command.body)
      const policy = findPolicy(body.cleanupPolicyId as string)
      if (command.resource === undefined || command.resource.kind !== 'cleanup_policy')
        throw devError('identity_mismatch', 'operation requires a cleanup_policy resource binding')
      if (command.resource.id !== policy.id)
        throw devError('identity_mismatch', 'resource id does not match the request body')
      if (command.resource.generation !== policy.version)
        throw devError('stale_generation', 'resource generation does not match the policy version')
      if (policy.version !== (body.expectedVersion as number))
        throw devError(
          'stale_version',
          `policy moved on: version ${policy.version}`,
          policy.version
        )
      if (policy.state === 'approved')
        throw devError('already_completed', 'the policy is already approved')
      if (policy.state !== 'draft')
        throw devError('invalid_state', `a ${policy.state} policy cannot be approved`)
      // Approving automatic background cleanup is a destructive policy and
      // requires a proven single-use owner approval: without a verifier (or
      // with an invalid one) this fails closed.
      const approvalVerifier = input.approvalVerifier
      if (!approvalVerifier)
        throw devError('auth_required', 'policy approval requires the owner approval authority')
      approvalVerifier.consume(
        { method: 'owner_setting', reference: body.approvalId as string },
        input.scope,
        'approve an automatic cleanup policy'
      )
      const next: StoredPolicy = {
        ...policy,
        state: 'approved',
        approvedBy: 'owner',
        approvedAt: new Date(now()).toISOString(),
        version: policy.version + 1,
      }
      policies = policies.map((entry) => (entry.id === policy.id ? next : entry))
      save()
      return next
    },

    'dev.cleanupPolicy.disable': (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.cleanupPolicy.disable'].request(command.body)
      const policy = findPolicy(body.cleanupPolicyId as string)
      if (command.resource === undefined || command.resource.kind !== 'cleanup_policy')
        throw devError('identity_mismatch', 'operation requires a cleanup_policy resource binding')
      if (command.resource.id !== policy.id)
        throw devError('identity_mismatch', 'resource id does not match the request body')
      if (command.resource.generation !== policy.version)
        throw devError('stale_generation', 'resource generation does not match the policy version')
      if (policy.version !== (body.expectedVersion as number))
        throw devError(
          'stale_version',
          `policy moved on: version ${policy.version}`,
          policy.version
        )
      if (policy.state === 'disabled')
        throw devError('already_completed', 'the policy is already disabled')
      const next: StoredPolicy = { ...policy, state: 'disabled', version: policy.version + 1 }
      policies = policies.map((entry) => (entry.id === policy.id ? next : entry))
      save()
      return next
    },

    'dev.cleanupPolicy.list': (command) => {
      requireScope(command)
      return page(policies)
    },

    'dev.cleanupPolicy.evaluate': async (command) => {
      requireScope(command)
      const body = devOperationDecoders['dev.cleanupPolicy.evaluate'].request(command.body)
      const policy = findPolicy(body.cleanupPolicyId as string)
      if (command.resource === undefined || command.resource.kind !== 'cleanup_policy')
        throw devError('identity_mismatch', 'operation requires a cleanup_policy resource binding')
      if (command.resource.id !== policy.id)
        throw devError('identity_mismatch', 'resource id does not match the request body')
      if (command.resource.generation !== policy.version)
        throw devError('stale_generation', 'resource generation does not match the policy version')
      if (policy.version !== (body.expectedVersion as number))
        throw devError(
          'stale_version',
          `policy moved on: version ${policy.version}`,
          policy.version
        )
      if (policy.state !== 'approved')
        throw devError(
          'invalid_state',
          `a ${policy.state} policy cannot be evaluated for execution`
        )
      const evaluatedAt = new Date(now()).toISOString()
      const expired = policy.expiresAt !== undefined && Date.parse(policy.expiresAt) <= now()
      const worktreeId = body.worktreeId as string
      const facts = expired ? undefined : await input.worktreeFacts?.(worktreeId)
      if (facts === undefined) {
        // Fail closed: no provable facts, no automatic cleanup.
        return {
          policyId: policy.id,
          worktreeId,
          matched: false,
          facts: {},
          blockers: [
            {
              code: 'capability_unavailable',
              message: expired
                ? 'the policy has expired and can no longer authorize automatic cleanup'
                : 'worktree facts are unavailable, so the policy cannot be proven satisfied',
            },
          ],
          evaluatedAt,
          executesNothing: true,
        } satisfies CleanupPolicyEvaluation
      }
      const { matched, blockers } = evaluatePredicates(policy.predicates, facts)
      return {
        policyId: policy.id,
        worktreeId,
        matched,
        facts: { ...facts },
        blockers,
        evaluatedAt,
        executesNothing: true,
      } satisfies CleanupPolicyEvaluation
    },
  }

  for (const [operation, provider] of Object.entries(providers)) {
    input.authority.registerCommandProvider(operation as DevOperation, provider)
  }
  return {
    providers,
    policies: () => [...policies],
  }
}
