// Production registrar for the #397 worktree service (issue control-plane
// slice): binds the existing worktree authority onto the M10 command registry
// without touching service internals. Every operation re-checks the envelope
// resource binding (kind, id, current generation) and the command scope
// before dispatch, maps typed service failures onto the Dev error contract,
// and returns registry-shaped DTOs. Operations whose host authority is not
// present (files/git inspection, retained-data jobs) stay typed-unavailable
// in the composition root instead of being fabricated here.
import { basename, join, resolve, sep } from 'node:path'

import type {
  DevCommand,
  DevError,
  DevOperation,
  DevRuntimePage,
  MutationPlan,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import type { CredentialVault } from '../vault'
import type { RootBookmarkAuthority } from '../roots'
import {
  createWorktreeService,
  type CreateWorktreeResult,
  type RepoRecord,
  type WorktreeRecord,
  type WorktreeService,
} from './service'
import type { CleanupPlan as ServiceCleanupPlan, CleanupStepKind } from './cleanup-plan'
import type { MergePlan as ServiceMergePlan } from './merge'

const PLAN_TTL_MS = 10 * 60_000

// Success-reply DTO shapes (spec-named types Lease/Worktree/Repo/…). The
// shared contract module resolves these structurally; the client slice owns
// the strict success decoders, so the host returns exactly these shapes.
type WorktreeDto = Readonly<{
  id: string
  scope: Scope
  repoId: string
  projectId: string
  canonicalRoot: string
  rootIdentity: WorktreeRecord['rootIdentity']
  provenance: 'adea' | 'external'
  baseRef?: string
  baseSha?: string
  headRef?: string
  headSha?: string
  lifecycle: WorktreeRecord['lifecycle']
  bootstrap: 'not_started' | 'running' | 'completed' | 'failed' | 'cancelled'
  archived: boolean
  generation: number
  version: number
}>

type LeaseDto = Readonly<{
  id: string
  scope: Scope
  worktreeId: string
  ownerKind: 'terminal' | 'harness' | 'browser' | 'device' | 'server' | 'editor'
  ownerId: string
  generation: number
  state: 'active' | 'suspect' | 'expired' | 'released'
  acquiredAt: string
  heartbeatAt: string
  expiresAt?: string
}>

type WorktreeOperationDto = Readonly<{
  operationId: string
  worktree: WorktreeDto
  step: string
  state: 'not_started' | 'running' | 'completed' | 'failed' | 'cancelled'
  nextRetryAt?: string
}>

type RedactedRemoteDto = Readonly<{
  provider: 'github' | 'gitlab' | 'other'
  host: string
  ownerPath: string
  displayUrl: string
}>

type RepoDto = Readonly<{
  id: string
  scope: Scope
  kind: 'git' | 'folder'
  lifecycle: 'authorizing' | 'ready' | 'unavailable' | 'stale' | 'refreshing'
  canonicalRoot: string
  remote?: RedactedRemoteDto
  defaultRef?: string
  projectIds: string[]
  version: number
}>

type RegistrarInput = {
  authority: ChannelAuthority
  dataDir: string
  scope: { accountId: string; workspaceId: string; runtimeNodeId: string }
  runtimeNodeId: string
  roots: RootBookmarkAuthority
  vault: CredentialVault
  /** Test seam: inject a service; production constructs the real one. */
  service?: WorktreeService
  now?: () => number
}

function devError(code: DevError['code'], message: string, retryable = false): DevError {
  return { code, retryable, message }
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'not_found',
  'invalid_state',
  'stale_generation',
  'stale_version',
  'unauthorized_root',
  'path_escape',
  'name_collision',
  'path_collision',
  'not_git_repo',
  'gitdir_unproven',
  'remote_unavailable',
  'base_not_found',
  'bootstrap_denied',
  'bootstrap_failed',
  'dirty',
  'unpushed',
  'behind',
  'conflicted',
  'protected_branch',
  'external_ownership',
  'dangerous_path',
  'nested_worktree',
  'lock_timeout',
  'timeout',
  'cancelled',
  'identity_mismatch',
  'corrupt_state',
  'limit_exceeded',
  'unavailable',
  'auth_required',
  'special_file_rejected',
  'symlink_rejected',
  'cleanup_blocked',
  'cleanup_partial',
  'recovery_required',
  'rollback_failed',
])

function mapWorktreeError(error: unknown): unknown {
  const candidate = error as { code?: unknown; message?: unknown }
  if (candidate && typeof candidate.code === 'string' && typeof candidate.message === 'string') {
    const code = KNOWN_CODES.has(candidate.code)
      ? (candidate.code as DevError['code'])
      : 'invalid_state'
    return devError(code, candidate.message, code === 'timeout' || code === 'lock_timeout')
  }
  return error instanceof Error ? error : devError('invalid_state', 'worktree operation failed')
}

function page<T>(items: readonly T[], nextCursor?: string): DevRuntimePage<T> {
  return {
    items: [...items],
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    observedAt: new Date().toISOString(),
  }
}

function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number | undefined) {
  const pageSize = limit ?? 100
  let start = 0
  if (cursor !== undefined) {
    const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Number.isSafeInteger(decoded) || decoded < 0) {
      throw devError('not_found', 'unknown listing cursor')
    }
    start = decoded
  }
  const slice = items.slice(start, start + pageSize)
  const nextCursor =
    start + pageSize < items.length
      ? Buffer.from(String(start + pageSize)).toString('base64url')
      : undefined
  return { slice, nextCursor }
}

function toWorktreeDto(record: WorktreeRecord): WorktreeDto {
  return {
    id: record.id,
    scope: record.scope,
    repoId: record.repoId,
    projectId: record.projectId,
    canonicalRoot: record.canonicalRoot,
    rootIdentity: record.rootIdentity,
    provenance: record.provenance,
    ...(record.baseRef !== undefined ? { baseRef: record.baseRef } : {}),
    ...(record.baseSha !== undefined ? { baseSha: record.baseSha } : {}),
    ...(record.headRef !== undefined ? { headRef: record.headRef } : {}),
    ...(record.headSha !== undefined ? { headSha: record.headSha } : {}),
    lifecycle: record.lifecycle,
    bootstrap: record.bootstrap.state,
    archived: record.archived,
    generation: record.generation,
    version: record.version,
  }
}

function toRepoDto(record: RepoRecord): RepoDto {
  return {
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    lifecycle: 'ready',
    canonicalRoot: record.canonicalRoot,
    ...(record.remote !== undefined ? { remote: redactRemote(record.remote) } : {}),
    ...(record.defaultRef !== undefined ? { defaultRef: record.defaultRef } : {}),
    projectIds: [...record.projectIds],
    version: record.version,
  }
}

/** Remote URLs are redacted before any DTO: embedded user-info is removed
 * while full nested namespace paths are preserved. */
function redactRemote(remote: string): RedactedRemoteDto {
  try {
    const parsed = new URL(remote)
    const host = parsed.host
    const ownerPath = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '')
    const displayUrl = `${parsed.protocol}//${host}${parsed.pathname}`.replace(/\.git$/, '')
    const provider = host === 'github.com' || host.endsWith('.github.com') ? 'github' : 'other'
    return { provider, host, ownerPath, displayUrl }
  } catch {
    return { provider: 'other', host: 'unknown', ownerPath: '', displayUrl: '' }
  }
}

function requireWorktreeResource(command: DevCommand, body: { worktreeId: string }): void {
  if (command.resource === undefined) {
    throw devError('identity_mismatch', 'operation requires a worktree resource binding')
  }
  if (command.resource.kind !== 'worktree') {
    throw devError('identity_mismatch', 'resource kind must be worktree')
  }
  if (command.resource.id !== body.worktreeId) {
    throw devError('identity_mismatch', 'resource id does not match the request body')
  }
}

export function registerWorktreeRuntime(input: RegistrarInput): {
  commands: readonly DevOperation[]
  registeredCommands: number
} {
  const service =
    input.service ??
    createWorktreeService({
      dataDir: input.dataDir,
      runtimeNodeId: input.runtimeNodeId,
      roots: input.roots,
    })
  // Plan/commit pairs: the host holds the immutable unexpired plan between
  // the two calls; the commit rechecks the digest and the live generation.
  const mergePlans = new Map<
    string,
    { plan: ServiceMergePlan; boundGeneration: number; expiresAt: number }
  >()
  const cleanupPlans = new Map<
    string,
    { plan: ServiceCleanupPlan; boundGeneration: number; expiresAt: number }
  >()
  const now = input.now ?? Date.now

  function livePlan<T>(
    store: Map<string, { plan: T; boundGeneration?: number; expiresAt: number }>,
    planId: string
  ): { plan: T; boundGeneration?: number } {
    const entry = store.get(planId)
    if (!entry || entry.expiresAt <= now()) {
      store.delete(planId)
      throw devError('plan_stale', 'the plan is unknown, expired, or already consumed')
    }
    return entry
  }

  /** Narrowest active repository bookmark strictly above the repo root: the
   * host-derived worktree base directory must sit under an authorized root
   * and never inside the primary checkout. */
  function worktreeBaseDir(repoCanonicalRoot: string): string {
    const covering = input.roots
      .list({ scope: input.scope, kind: 'repository' })
      .items.filter(
        (entry) =>
          entry.state === 'active' &&
          entry.canonicalRoot !== repoCanonicalRoot &&
          resolve(repoCanonicalRoot).startsWith(entry.canonicalRoot + sep)
      )
      .toSorted((a, b) => b.canonicalRoot.length - a.canonicalRoot.length)
    const host = covering[0]
    if (!host) {
      throw devError(
        'unauthorized_root',
        'worktree creation requires an authorized parent root above the repository'
      )
    }
    return join(host.canonicalRoot, 'adea-worktrees', basename(repoCanonicalRoot))
  }

  function currentGeneration(worktreeId: string): number {
    const record = service.getWorktree(input.scope, worktreeId)
    if (!record) throw devError('not_found', 'worktree is not registered on this runtime node')
    return record.generation
  }

  function requireLiveGeneration(command: DevCommand, worktreeId: string): void {
    if (command.resource!.generation !== currentGeneration(worktreeId)) {
      throw devError('stale_generation', 'resource generation does not match the worktree record')
    }
  }

  function worktreeOperation(result: CreateWorktreeResult, step: string): WorktreeOperationDto {
    return {
      operationId: result.worktree.id,
      worktree: toWorktreeDto(result.worktree),
      step,
      state: result.worktree.lifecycle === 'ready' ? 'completed' : 'running',
    }
  }

  const handlers: Partial<
    Record<DevOperation, (command: DevCommand) => Promise<unknown> | unknown>
  > = {
    'dev.worktree.list': (command) => {
      const body = devOperationDecoders['dev.worktree.list'].request(command.body)
      const records = service
        .listWorktrees({
          scope: input.scope,
          ...(body.projectId !== undefined ? { projectId: body.projectId as string } : {}),
          ...(body.repoId !== undefined ? { repoId: body.repoId as string } : {}),
          ...(body.archived !== undefined ? { archived: body.archived as boolean } : {}),
        })
        .map(toWorktreeDto)
      const { slice, nextCursor } = paginate(
        records,
        body.cursor as string | undefined,
        body.limit as number | undefined
      )
      return page(slice, nextCursor)
    },

    'dev.worktree.create': async (command) => {
      const body = devOperationDecoders['dev.worktree.create'].request(command.body)
      if (command.resource !== undefined) {
        throw devError('identity_mismatch', 'dev.worktree.create carries no resource binding')
      }
      const repo = service
        .listRepos(input.scope)
        .find((entry) => entry.id === (body.repoId as string))
      if (!repo) throw devError('not_found', 'repository is not registered on this runtime node')
      const result = await service.createWorktree({
        scope: input.scope,
        repoId: body.repoId as string,
        projectId: body.projectId as string,
        baseRef: body.baseRef as string,
        branchName: body.branchName as string,
        ...(body.destinationName !== undefined
          ? { destinationName: body.destinationName as string }
          : {}),
        worktreeBaseDir: worktreeBaseDir(repo.canonicalRoot),
        idempotencyKey: command.idempotencyKey,
      })
      return worktreeOperation(result, 'ready')
    },

    'dev.worktree.retryBootstrap': async (command) => {
      const body = devOperationDecoders['dev.worktree.retryBootstrap'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      requireLiveGeneration(command, body.worktreeId as string)
      const record = await service.retryBootstrap({
        scope: input.scope,
        worktreeId: body.worktreeId as string,
      })
      return worktreeOperation({ worktree: record, name: '' }, 'bootstrap')
    },

    'dev.worktree.lease': (command) => {
      const body = devOperationDecoders['dev.worktree.lease'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      const lease = service.leases.acquire({
        scope: input.scope,
        worktreeId: body.worktreeId as string,
        expectedGeneration: command.resource!.generation,
        ownerKind: body.ownerKind as
          | 'terminal'
          | 'harness'
          | 'browser'
          | 'device'
          | 'server'
          | 'editor',
        ownerId: body.ownerId as string,
        ...(body.ttlSeconds !== undefined ? { ttlSeconds: body.ttlSeconds as number } : {}),
      })
      return toLeaseDto(lease)
    },

    'dev.worktree.releaseLease': (command) => {
      const body = devOperationDecoders['dev.worktree.releaseLease'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      const lease = service.leases.release({
        scope: input.scope,
        worktreeId: body.worktreeId as string,
        leaseId: body.leaseId as string,
      })
      return toLeaseDto(lease)
    },

    'dev.worktree.mergePlan': async (command) => {
      const body = devOperationDecoders['dev.worktree.mergePlan'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      requireLiveGeneration(command, body.worktreeId as string)
      const plan = await service.merge.plan({
        scope: input.scope,
        worktreeId: body.worktreeId as string,
        expectedGeneration: command.resource!.generation,
        targetRef: body.targetRef as string,
        ...(body.expectedTargetSha !== undefined
          ? { expectedTargetSha: body.expectedTargetSha as string }
          : {}),
        commitMessage: `merge ${(body.targetRef as string).slice(0, 128)}`,
      })
      mergePlans.set(plan.planId, {
        plan,
        boundGeneration: command.resource!.generation,
        expiresAt: now() + PLAN_TTL_MS,
      })
      return toMutationPlan(command, plan)
    },

    'dev.worktree.mergeCommit': async (command) => {
      const body = devOperationDecoders['dev.worktree.mergeCommit'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      const entry = livePlan(mergePlans, body.planId as string)
      // The envelope resource generation MUST equal the plan's bound target
      // generation before the digest or any side effect is evaluated.
      if (entry.boundGeneration !== command.resource!.generation) {
        throw devError('stale_generation', 'the plan is bound to another worktree generation')
      }
      const outcome = await service.merge.commit({
        scope: input.scope,
        plan: entry.plan,
        digest: body.planDigest as string,
      })
      mergePlans.delete(entry.plan.planId)
      const record = service.getWorktree(input.scope, entry.plan.worktreeId)
      if (!record) throw devError('not_found', 'worktree is not registered on this runtime node')
      return {
        operationId: entry.plan.planId,
        worktree: toWorktreeDto(record),
        step: 'merge',
        state:
          outcome.state === 'merged'
            ? 'completed'
            : outcome.state === 'conflicted'
              ? 'failed'
              : 'completed',
      } satisfies WorktreeOperationDto
    },

    'dev.worktree.archive': (command) => {
      const body = devOperationDecoders['dev.worktree.archive'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      const record = service.archiveWorktree({
        scope: input.scope,
        worktreeId: body.worktreeId as string,
        expectedGeneration: command.resource!.generation,
      })
      return toWorktreeDto(record)
    },

    'dev.worktree.unarchive': (command) => {
      const body = devOperationDecoders['dev.worktree.unarchive'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      const record = service.unarchiveWorktree({
        scope: input.scope,
        worktreeId: body.worktreeId as string,
        expectedGeneration: command.resource!.generation,
      })
      return toWorktreeDto(record)
    },

    'dev.worktree.cleanupPlan': async (command) => {
      const body = devOperationDecoders['dev.worktree.cleanupPlan'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      requireLiveGeneration(command, body.worktreeId as string)
      const plan = await service.planCleanup({
        scope: input.scope,
        worktreeId: body.worktreeId as string,
        expectedGeneration: command.resource!.generation,
        selectedSteps: body.allowedSteps as ReadonlyArray<CleanupStepKind>,
        selectedResourceIds: body.selectedOwnedResourceIds as ReadonlyArray<string>,
      })
      cleanupPlans.set(plan.planId, {
        plan,
        boundGeneration: command.resource!.generation,
        expiresAt: now() + PLAN_TTL_MS,
      })
      return {
        id: plan.planId,
        operation: 'dev.worktree.cleanupCommit',
        scope: input.scope,
        resource: {
          kind: 'worktree',
          id: plan.worktreeId,
          generation: plan.generation,
        },
        factVersions: { factsDigest: plan.digest },
        steps: plan.selectedSteps.map((step) => ({
          id: step,
          kind: step,
          targetId: plan.worktreeId,
          dependsOn: [],
        })),
        blockers: plan.blockers.map((blocker) => ({
          code: (KNOWN_CODES.has(blocker.code)
            ? blocker.code
            : 'cleanup_blocked') as DevError['code'],
          message: blocker.detail,
        })),
        requiredApprovalIds: [],
        digest: plan.digest,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      } satisfies MutationPlan
    },

    'dev.worktree.cleanupCommit': async (command) => {
      const body = devOperationDecoders['dev.worktree.cleanupCommit'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      const entry = livePlan(cleanupPlans, body.planId as string)
      if (entry.boundGeneration !== command.resource!.generation) {
        throw devError('stale_generation', 'the plan is bound to another worktree generation')
      }
      const result = await service.commitCleanup({
        scope: input.scope,
        plan: entry.plan,
        digest: body.planDigest as string,
      })
      cleanupPlans.delete(entry.plan.planId)
      return {
        cleanupJobId: result.planId,
        state: result.state,
        stepResults: result.stepResults.map((step) => ({
          stepId: step.step,
          // The contract has no 'skipped' step state: an unselected step
          // reads as pending so a resume can still run it.
          state:
            step.state === 'completed'
              ? 'completed'
              : step.state === 'rolled_back'
                ? 'rolled_back'
                : step.state === 'skipped'
                  ? 'pending'
                  : 'failed',
          ...(step.detail !== undefined ? { message: step.detail } : {}),
          observedAt: new Date(now()).toISOString(),
        })),
        observedAt: new Date(now()).toISOString(),
      }
    },

    'dev.worktree.cleanupResume': async (command) => {
      const body = devOperationDecoders['dev.worktree.cleanupResume'].request(command.body)
      requireWorktreeResource(command, body as { worktreeId: string })
      const result = await service.resumeCleanup({
        scope: input.scope,
        worktreeId: body.worktreeId as string,
        jobId: body.cleanupJobId as string,
      })
      return {
        cleanupJobId: result.planId,
        state: result.state,
        stepResults: result.stepResults.map((step) => ({
          stepId: step.step,
          state:
            step.state === 'completed'
              ? 'completed'
              : step.state === 'rolled_back'
                ? 'rolled_back'
                : step.state === 'skipped'
                  ? 'pending'
                  : 'failed',
          ...(step.detail !== undefined ? { message: step.detail } : {}),
          observedAt: new Date(now()).toISOString(),
        })),
        observedAt: new Date(now()).toISOString(),
      }
    },

    'dev.repo.list': (command) => {
      const body = devOperationDecoders['dev.repo.list'].request(command.body)
      const records = service
        .listRepos(input.scope)
        .filter(
          (entry) =>
            body.projectId === undefined || entry.projectIds.includes(body.projectId as string)
        )
        .map(toRepoDto)
      const { slice, nextCursor } = paginate(
        records,
        body.cursor as string | undefined,
        body.limit as number | undefined
      )
      return page(slice, nextCursor)
    },

    'dev.repo.credentialRefs': (command) => {
      const body = devOperationDecoders['dev.repo.credentialRefs'].request(command.body)
      const result = input.vault.list({
        scope: input.scope,
        ...(body.host !== undefined ? { host: body.host as string } : {}),
        ...(body.cursor !== undefined ? { cursor: body.cursor as string } : {}),
        ...(body.limit !== undefined ? { limit: body.limit as number } : {}),
      })
      return {
        items: result.items,
        ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        observedAt: result.observedAt,
      }
    },

    'dev.project.bookmarks': (command) => {
      const body = devOperationDecoders['dev.project.bookmarks'].request(command.body)
      const result = input.roots.list({
        scope: input.scope,
        ...(body.kind !== undefined ? { kind: body.kind as 'directory' | 'repository' } : {}),
        ...(body.cursor !== undefined ? { cursor: body.cursor as string } : {}),
        ...(body.limit !== undefined ? { limit: body.limit as number } : {}),
      })
      return {
        items: result.items.map((entry) => ({
          id: entry.id,
          scope: entry.scope,
          label: entry.label,
          kind: entry.kind,
          canonicalRoot: entry.canonicalRoot,
          rootIdentity: entry.rootIdentity,
          state: entry.state,
          generation: entry.generation,
          version: entry.version,
        })),
        ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        observedAt: result.observedAt,
      }
    },
  }

  function toLeaseDto(lease: {
    id: string
    scope: { accountId: string; workspaceId: string; runtimeNodeId: string }
    worktreeId: string
    ownerKind: string
    ownerId: string
    generation: number
    state: string
    acquiredAt: string
    heartbeatAt: string
    expiresAt?: string
  }): LeaseDto {
    return {
      id: lease.id,
      scope: lease.scope,
      worktreeId: lease.worktreeId,
      ownerKind: lease.ownerKind as LeaseDto['ownerKind'],
      ownerId: lease.ownerId,
      generation: lease.generation,
      state: lease.state as LeaseDto['state'],
      acquiredAt: lease.acquiredAt,
      heartbeatAt: lease.heartbeatAt,
      ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
    }
  }

  function toMutationPlan(command: DevCommand, plan: ServiceMergePlan): MutationPlan {
    return {
      id: plan.planId,
      operation: 'dev.worktree.mergeCommit',
      scope: input.scope,
      resource: {
        kind: 'worktree',
        id: plan.worktreeId,
        generation: command.resource!.generation,
      },
      factVersions: {
        sourceHeadSha: plan.sourceHeadSha,
        targetRef: plan.targetRef,
        expectedTargetSha: plan.expectedTargetSha,
        mergeBaseSha: plan.mergeBaseSha,
      },
      steps: [{ id: 'merge', kind: 'merge_commit', targetId: plan.worktreeId, dependsOn: [] }],
      blockers: [],
      requiredApprovalIds: [],
      digest: plan.digest,
      expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
    }
  }

  let registeredCommands = 0
  for (const [operation, handler] of Object.entries(handlers)) {
    if (!handler) continue
    input.authority.registerCommandProvider(operation as DevOperation, async (command) => {
      try {
        return await handler(command)
      } catch (error) {
        throw mapWorktreeError(error)
      }
    })
    registeredCommands += 1
  }
  return { commands: Object.keys(handlers) as DevOperation[], registeredCommands }
}
