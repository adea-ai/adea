// The host operations and the local note behind them (#188), with no JSX, so they can be
// exercised directly.
//
// This module holds only what the mounted view needs from the server and from the browser. It
// adds no pairing, revocation, credential, native or content-sync capability: the operations it
// connects are rename and the local note.
import type { AgentHqApiClient, ApiRuntimeNode } from '@adea-ai/api-client'

import type { HostListRefresh, SelfHostedOperations } from './self-hosted-connection-panel'

/** The notice the rename reports. The list read decides what is true, so the refresh comes first. */
export type HostRenameNotice = Readonly<{
  tone: 'success' | 'warning'
  title: string
  text: string
}>

/**
 * Renames one registered host and then re-reads the host list.
 *
 * The list read decides what is true, exactly as it does for every other host change, so a rename
 * is never reported as applied on the strength of the request alone. When the list cannot be read
 * again, the notice reports the request result and says the name is unconfirmed; when the list
 * shows a different name, the list is what the notice reports.
 */
export async function applyHostRename(input: {
  readonly renameHost: ((hostId: string, displayName: string) => Promise<void>) | undefined
  readonly hostId: string
  readonly displayName: string
  readonly refreshHosts: HostListRefresh
  readonly notify: (notice: HostRenameNotice) => void
}): Promise<void> {
  if (!input.renameHost) throw new Error('HOST_RENAME_NOT_CONNECTED')
  await input.renameHost(input.hostId, input.displayName)
  // The refresh comes before the notice, because the notice is about what the list shows.
  let refreshed: readonly ApiRuntimeNode[] | undefined
  try {
    const read = await input.refreshHosts()
    refreshed = read as readonly ApiRuntimeNode[] | undefined
  } catch {
    // A read that fails leaves the request result as the only thing known.
    refreshed = undefined
  }
  const confirmed = refreshed?.find((node) => node.id === input.hostId)
  if (confirmed?.displayName === input.displayName) {
    input.notify({
      tone: 'success',
      title: 'Host renamed',
      text: `Now shown as ${input.displayName}.`,
    })
    return
  }
  if (confirmed) {
    // The list is authoritative: it shows what the host is called now, which is not necessarily
    // what this rename asked for.
    input.notify({
      tone: 'warning',
      title: 'Host renamed',
      text: `Renamed to ${input.displayName}, but the host list now shows ${confirmed.displayName}.`,
    })
    return
  }
  if (refreshed) {
    input.notify({
      tone: 'warning',
      title: 'Host renamed',
      text: `Renamed to ${input.displayName}, but the host list no longer shows this host.`,
    })
    return
  }
  input.notify({
    tone: 'warning',
    title: 'Rename request accepted',
    text: `The rename request for ${input.displayName} was accepted, but the host list was not read again, so the new name is not confirmed.`,
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
