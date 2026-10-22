// The host operations and the local note behind them (#188), with no JSX, so they can be
// exercised directly.
//
// This module holds only what the mounted view needs from the server and from the browser. It
// adds no pairing, revocation, credential, native or content-sync capability: the operations it
// connects are rename and the local note.
import type { AgentHqApiClient } from '@adea-ai/api-client'

import type { SelfHostedOperations } from './self-hosted-connection-panel'

/** The notice the rename reports. The list read decides what is true, so the refresh comes first. */
export type HostRenameNotice = Readonly<{
  tone: 'success'
  title: string
  text: string
}>

/**
 * Renames one registered host and then re-reads the host list.
 *
 * The list read decides what is true, exactly as it does for every other host change, so a rename
 * is never reported as applied on the strength of the request alone.
 */
export async function applyHostRename(input: {
  readonly renameHost: ((hostId: string, displayName: string) => Promise<void>) | undefined
  readonly hostId: string
  readonly displayName: string
  readonly refreshHosts: () => void | Promise<void>
  readonly notify: (notice: HostRenameNotice) => void
}): Promise<void> {
  if (!input.renameHost) throw new Error('HOST_RENAME_NOT_CONNECTED')
  await input.renameHost(input.hostId, input.displayName)
  await input.refreshHosts()
  input.notify({
    tone: 'success',
    title: 'Host renamed',
    text: `Now shown as ${input.displayName}.`,
  })
}

/**
 * The operations this build connects. Rename only: pairing and revocation are absent, so the pane
 * shows them as unavailable and the mounted actions cannot run them.
 */
export function selfHostedHostOperations(
  client: AgentHqApiClient | undefined,
  workspaceId: string
): SelfHostedOperations {
  if (!client) return {}
  return {
    renameHost: async (hostId: string, displayName: string) => {
      await client.renameRuntimeNode(workspaceId, hostId, displayName)
    },
  }
}

/**
 * This browser's note about a host.
 *
 * Reading storage can fail — a browser may refuse it, and the accessor itself can throw — so the
 * acquisition is guarded and a failure means "no note", never a broken view.
 */
export function browserHostPreferenceStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    // A browser that refuses storage simply has no note to keep.
    return undefined
  }
}
