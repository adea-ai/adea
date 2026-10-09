import type { AgentHqApiClient } from '@adea-ai/api-client'
import { invoke as bridgeInvoke } from './desktop-bridge'
import type { DevScopeCredential } from './desktop-dev-scope'

export type PendingWorkspaceCleanup = Readonly<{
  operationId: string
  workspaceId: string
  state: string
}>
export class WorkspaceCleanupRefusal extends Error {
  constructor(code?: string) {
    super(
      code === 'workspace_cleanup_completion_unverified'
        ? 'Adea cannot verify workspace cleanup completion yet. The workspace and its remaining data have been kept.'
        : code === 'workspace_cleanup_running_work'
          ? 'Stop running workspace sessions before deleting this workspace. The workspace has been kept.'
          : code === 'workspace_cleanup_managed_worktrees_pending'
            ? 'Finish managed worktree cleanup before deleting this workspace. The workspace has been kept.'
            : code === 'workspace_cleanup_legacy_data_pending'
              ? 'This workspace has retained legacy device data whose cleanup is not supported yet. The workspace has been kept.'
              : [
                    'workspace_cleanup_ambiguous_data',
                    'workspace_cleanup_additional_scope',
                    'memory_unavailable',
                  ].includes(code ?? '')
                ? 'Device resource ownership could not be verified. Resolve local data recovery before deleting this workspace; the workspace has been kept.'
                : 'Adea could not verify device cleanup. Keep this device online and retry with an app that supports workspace cleanup. The workspace has been kept.'
    )
    this.name = 'WorkspaceCleanupRefusal'
  }
}

export class WorkspaceCleanupPending extends Error {
  constructor() {
    super(
      'Workspace cleanup is pending. The workspace has been kept. Retry deletion after resolving local cleanup.'
    )
    this.name = 'WorkspaceCleanupPending'
  }
}

/** The signed shell proves ownership and fences work before cloud deletion. */
export function desktopWorkspaceDeletion(options: {
  credential(): DevScopeCredential | undefined
  pending(records: readonly PendingWorkspaceCleanup[]): void
  invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
}) {
  const invoke = options.invoke ?? bridgeInvoke
  const attached = new WeakSet<AgentHqApiClient>()
  async function refreshPending() {
    const records = await invoke<PendingWorkspaceCleanup[]>(
      'desktop_identity_workspace_cleanup_pending'
    )
    options.pending(records)
    return records
  }
  function credential() {
    const value = options.credential()
    if (!value) throw new WorkspaceCleanupRefusal()
    return value
  }
  async function resume() {
    const proof = credential()
    for (const receipt of await refreshPending()) {
      try {
        await invoke('desktop_identity_workspace_cleanup_commit', {
          operationId: receipt.operationId,
          credential: proof,
        })
      } catch {
        // Only a fresh owner proof of an existing workspace can cancel a
        // prepared operation. An uncertain/deleted outcome stays fenced.
        await invoke('desktop_identity_workspace_cleanup_cancel', {
          operationId: receipt.operationId,
          credential: proof,
        }).catch(() => undefined)
      }
    }
    return refreshPending()
  }
  return {
    refreshPending,
    resume,
    attach(client: AgentHqApiClient) {
      if (attached.has(client)) return client
      attached.add(client)
      const cloudDelete = client.deleteWorkspace.bind(client)
      client.deleteWorkspace = async (workspaceId, input) => {
        const proof = credential()
        let receipt: { operationId: string }
        try {
          receipt = await invoke('desktop_identity_workspace_cleanup_prepare', {
            workspaceId,
            credential: proof,
          })
        } catch (error) {
          const code =
            error instanceof Error
              ? /(?:workspace_cleanup_[a-z_]+|memory_unavailable)/.exec(error.message)?.[0]
              : undefined
          throw new WorkspaceCleanupRefusal(code)
        }
        try {
          await client.prepareWorkspaceDeletion(workspaceId, input)
        } catch (error) {
          await invoke('desktop_identity_workspace_cleanup_cancel', {
            operationId: receipt.operationId,
            credential: proof,
          }).catch(() => undefined)
          await refreshPending().catch(() =>
            options.pending([{ ...receipt, workspaceId, state: 'prepared' }])
          )
          throw error
        }
        options.pending([{ ...receipt, workspaceId, state: 'deleting' }])
        try {
          await invoke('desktop_identity_workspace_cleanup_commit', {
            operationId: receipt.operationId,
            credential: proof,
          })
        } catch {
          await refreshPending().catch(() =>
            options.pending([{ ...receipt, workspaceId, state: 'failed' }])
          )
          throw new WorkspaceCleanupPending()
        }
        const result = await cloudDelete(workspaceId, input)
        // The second owner proof observes the final cloud receipt and only then
        // forgets the native identity. A late failure remains a visible retry.
        await invoke('desktop_identity_workspace_cleanup_commit', {
          operationId: receipt.operationId,
          credential: proof,
        }).catch(() => undefined)
        await refreshPending().catch(() => undefined)
        return result
      }
      return client
    },
  }
}
