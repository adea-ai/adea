// Signed-window prepare/commit protocol for workspace device cleanup. A cloud
// owner receipt is re-proven before recovery cleanup; prepare intent is never proof.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Scope } from '../../../../packages/types/src/dev-runtime'
import type { WorkspaceMembershipCredential } from './dev-runtime/channel/identity'
import { createDurableJsonStore } from './dev-runtime/host-store'
import { isUuid } from './dev-runtime/authority'

type Step = 'sessions' | 'data' | 'identity'
type Receipt = {
  operationId: string
  scope: Scope
  state: 'prepared' | 'deleting' | 'failed' | 'local_complete' | 'complete' | 'cancelled'
  completed: Step[]
  updatedAt: string
}
export type WorkspaceCleanup = ReturnType<typeof createWorkspaceCleanup>
export function createWorkspaceCleanup(input: {
  dataDir: string
  currentScope(): Scope
  verify(
    workspaceId: string,
    credential: WorkspaceMembershipCredential
  ): Promise<'active' | 'cleanup_pending' | 'deleted'>
  assertIdle(scope: Scope): Promise<void>
  /** Enter a shell-owned receipt scope only after fresh owner deletion proof. */
  activateScope?(scope: Scope): Promise<() => void>
  planData(scope: Scope): void
  archiveSessions(scope: Scope): void
  purgeData(scope: Scope): void | Promise<void>
  forgetWorkspace(workspaceId: string): void
}) {
  const store = createDurableJsonStore<Receipt>({
    file: join(input.dataDir, 'workspace-deletions', 'cleanup.json'),
    schemaVersion: 1,
    label: 'workspace deletion cleanup',
  })
  let busy = false
  function receipts() {
    const records = [...store.load().records]
    for (const r of records)
      if (
        !r ||
        !isUuid(r.operationId) ||
        !isUuid(r.scope?.workspaceId) ||
        typeof r.scope.accountId !== 'string' ||
        typeof r.scope.runtimeNodeId !== 'string' ||
        !['prepared', 'deleting', 'failed', 'local_complete', 'complete', 'cancelled'].includes(
          r.state
        ) ||
        !Array.isArray(r.completed) ||
        r.completed.some((step) => !['sessions', 'data', 'identity'].includes(step))
      )
        throw new Error('workspace_cleanup_unavailable')
    return records
  }
  function save(receipt: Receipt) {
    receipt.updatedAt = new Date().toISOString()
    store.save([...receipts().filter((r) => r.operationId !== receipt.operationId), receipt])
  }
  function ownedScope(workspaceId: string) {
    if (!isUuid(workspaceId)) throw new Error('workspace_cleanup_invalid_input')
    const scope = input.currentScope()
    if (scope.workspaceId !== workspaceId) throw new Error('workspace_cleanup_scope_unavailable')
    return { ...scope }
  }
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (busy) throw new Error('workspace_cleanup_busy')
    busy = true
    try {
      return await run()
    } finally {
      busy = false
    }
  }
  return {
    isPaused(scope: Scope) {
      return receipts().some(
        (r) => r.scope.workspaceId === scope.workspaceId && r.state !== 'cancelled'
      )
    },
    pending() {
      return receipts()
        .filter((r) => !['complete', 'cancelled'].includes(r.state))
        .map(({ operationId, scope, state }) => ({
          operationId,
          workspaceId: scope.workspaceId,
          state,
        }))
    },
    prepare(workspaceId: string, credential: WorkspaceMembershipCredential) {
      return exclusive(async () => {
        const state = await input.verify(workspaceId, credential)
        if (state === 'deleted') throw new Error('workspace_cleanup_already_deleted')
        const existing = receipts().find(
          (r) => r.scope.workspaceId === workspaceId && !['cancelled', 'complete'].includes(r.state)
        )
        if (existing && state === 'cleanup_pending')
          return { operationId: existing.operationId, workspaceId }
        const scope = ownedScope(workspaceId)
        let receipt = receipts().find(
          (r) => r.scope.workspaceId === workspaceId && r.state === 'prepared'
        )
        receipt ??= {
          operationId: randomUUID(),
          scope,
          state: 'prepared',
          completed: [],
          updatedAt: '',
        }
        save(receipt) // Fence new commands before observing in-flight work.
        try {
          await input.assertIdle(scope)
          input.planData(scope)
        } catch (error) {
          save({ ...receipt, state: 'cancelled' })
          throw error
        }
        return { operationId: receipt.operationId, workspaceId }
      })
    },
    cancel(operationId: string, credential: WorkspaceMembershipCredential) {
      return exclusive(async () => {
        const receipt = receipts().find((r) => r.operationId === operationId)
        if (!receipt || receipt.state !== 'prepared')
          throw new Error('workspace_cleanup_invalid_state')
        // An uncertain cloud outcome cannot reopen local writes. Only an owner
        // proof that the workspace still exists releases the deletion fence.
        if ((await input.verify(receipt.scope.workspaceId, credential)) !== 'active')
          throw new Error('workspace_cleanup_pending')
        save({ ...receipt, state: 'cancelled' })
      })
    },
    commit(operationId: string, credential: WorkspaceMembershipCredential) {
      return exclusive(async () => {
        const receipt = receipts().find((r) => r.operationId === operationId)
        if (!receipt || receipt.state === 'cancelled')
          throw new Error('workspace_cleanup_invalid_state')
        const state = await input.verify(receipt.scope.workspaceId, credential)
        if (state === 'active') throw new Error('workspace_cleanup_not_deleted')
        // Pending is an intent, not completion authorization. Never purge data
        // or detach identity while an unverified cloud root still exists.
        if (state === 'cleanup_pending') throw new Error('workspace_cleanup_completion_unverified')
        if (receipt.state === 'complete')
          return { workspaceId: receipt.scope.workspaceId, complete: true as const }
        let restoreScope: (() => void) | undefined
        try {
          if (input.activateScope) restoreScope = await input.activateScope(receipt.scope)
          else ownedScope(receipt.scope.workspaceId)
          await input.assertIdle(receipt.scope)
          if (!receipt.completed.includes('data')) input.planData(receipt.scope)
          receipt.state = 'deleting'
          save(receipt)
          const steps: ReadonlyArray<readonly [Step, () => void | Promise<void>]> = [
            ['sessions', () => input.archiveSessions(receipt.scope)],
            ['data', () => input.purgeData(receipt.scope)],
            ['identity', () => input.forgetWorkspace(receipt.scope.workspaceId)],
          ]
          for (const [step, run] of steps) {
            if (receipt.completed.includes(step)) continue
            await run()
            receipt.completed.push(step)
            save(receipt)
          }
          save({ ...receipt, state: 'complete' })
          return { workspaceId: receipt.scope.workspaceId, complete: true as const }
        } catch {
          save({ ...receipt, state: 'failed' })
          throw new Error('workspace_cleanup_pending')
        } finally {
          restoreScope?.()
        }
      })
    },
  }
}
