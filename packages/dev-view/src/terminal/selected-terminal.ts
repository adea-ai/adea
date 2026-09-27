// Application-owned selection resolution. No PTY is created or grant minted here.
import { decodeDevReply } from '@adea-ai/types/dev-runtime'
import type {
  DevCommand,
  DevErrorCode,
  DevReply,
  DevRuntimePage,
  Scope,
  TerminalRecord,
} from '@adea-ai/types/dev-runtime'
import { devOperationMetadataFor_dev_terminal_list } from '@adea-ai/types/dev-runtime-operation-metadata'
import { buildDevCommandFromMetadata } from '../browser/command-core'

export type SelectedTerminalIdentity = Readonly<{
  runtimeSessionId: string
  worktreeId: string
  terminalId?: string
}>
export type SelectedTerminalResult =
  | Readonly<{ status: 'ready'; terminal: TerminalRecord }>
  | Readonly<{ status: 'unavailable'; reason: DevErrorCode }>

const unavailable = (reason: DevErrorCode): SelectedTerminalResult => ({
  status: 'unavailable',
  reason,
})
const sameScope = (left: Scope, right: Scope) =>
  left.accountId === right.accountId &&
  left.workspaceId === right.workspaceId &&
  left.runtimeNodeId === right.runtimeNodeId

/** Resolve an explicit primary or split-leaf terminal within the selected session.
 * Scan the complete bounded listing to reject ambiguous identities. Selection
 * changes retire the caller's AbortSignal; pending replies cannot revive it.
 */
export async function resolveSelectedTerminal(options: {
  execute: (command: DevCommand) => Promise<DevReply>
  scope: Scope
  selection: SelectedTerminalIdentity
  signal?: AbortSignal
}): Promise<SelectedTerminalResult> {
  const { scope, selection, signal } = options
  if (signal?.aborted) return unavailable('cancelled')
  if (!selection.terminalId || !selection.runtimeSessionId || !selection.worktreeId)
    return unavailable('not_found')
  let match: TerminalRecord | undefined
  let cursor: string | undefined
  const cursors = new Set<string>()
  try {
    for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
      if (signal?.aborted) return unavailable('cancelled')
      const command = buildDevCommandFromMetadata(devOperationMetadataFor_dev_terminal_list, {
        scope,
        body: {
          runtimeSessionId: selection.runtimeSessionId,
          worktreeId: selection.worktreeId,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        },
      })
      const reply = await options.execute(command)
      if (signal?.aborted) return unavailable('cancelled')
      if (
        reply.schemaVersion !== 1 ||
        reply.operation !== command.operation ||
        reply.requestId !== command.requestId
      )
        return unavailable('incompatible')
      // Preserve the explicit bound result before the canonical DTO decoder
      // rejects the page. All remaining reply/record shape checks belong to it.
      if (
        reply.ok &&
        Array.isArray((reply.value as { items?: unknown })?.items) &&
        (reply.value as { items: unknown[] }).items.length > 500
      )
        return unavailable('limit_exceeded')
      const decoded = decodeDevReply(reply)
      if (!decoded.ok) return unavailable(decoded.error.code)
      const page = decoded.value as DevRuntimePage<TerminalRecord>
      for (const terminal of page.items) {
        if (
          !sameScope(terminal.scope, scope) ||
          terminal.runtimeSessionId !== selection.runtimeSessionId ||
          terminal.worktreeId !== selection.worktreeId
        )
          return unavailable('identity_mismatch')
        if (terminal.id !== selection.terminalId) continue
        if (match) return unavailable('incompatible')
        match = terminal
      }
      if (page.nextCursor === undefined) {
        if (!match) return unavailable('not_found')
        if ((match.state !== 'running' && match.state !== 'detached') || match.health === 'faulted')
          return unavailable('unavailable')
        return { status: 'ready', terminal: match }
      }
      if (
        typeof page.nextCursor !== 'string' ||
        page.nextCursor.length === 0 ||
        cursors.has(page.nextCursor)
      )
        return unavailable('incompatible')
      cursor = page.nextCursor
      cursors.add(cursor)
    }
    return unavailable('limit_exceeded')
  } catch {
    return unavailable(signal?.aborted ? 'cancelled' : 'incompatible')
  }
}
