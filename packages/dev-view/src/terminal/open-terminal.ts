// Opening a runtime terminal from the Dev View. Loaded on first use so the
// shell-profile and toolbar-preference code stays out of the Dev View shell.
import type {
  DevCommand,
  DevErrorCode,
  DevReply,
  Scope,
  TerminalRecord,
} from '@adea-ai/types/dev-runtime'

import { listShellProfiles } from './shell-profiles'
import { createSessionTerminal, terminateSessionTerminal } from './terminal-close'
import { resolveDefaultShellProfileId, toolbarPreferences } from './toolbar-preferences'

export type OpenedTerminalOutcome =
  | Readonly<{ status: 'attached'; terminal: TerminalRecord }>
  | Readonly<{ status: 'unavailable'; reason: DevErrorCode }>
  /** The context changed while the create was in flight; the new terminal was ended. */
  | Readonly<{ status: 'discarded' }>
  /** The context changed and the new terminal could not be ended; it is still running. */
  | Readonly<{ status: 'orphaned'; terminal: TerminalRecord }>

/**
 * Create a runtime terminal and bind it only if the world it was requested in
 * still holds. The create is an await, so the selected session, the layout
 * and its pane capacity can all change before it resolves; `canAttach` is
 * rechecked after the await, and a terminal that can no longer be shown is
 * ended through `discard` instead of being left running without a pane.
 */
export async function openCreatedTerminal(options: {
  create: () => ReturnType<typeof createSessionTerminal>
  /** Re-evaluated after the create resolves: same session, room for the pane. */
  canAttach: () => boolean
  attach: (terminal: TerminalRecord) => void
  discard: (terminal: TerminalRecord) => Promise<boolean>
}): Promise<OpenedTerminalOutcome> {
  const created = await options.create()
  if (created.status !== 'ready') return created
  if (options.canAttach()) {
    options.attach(created.terminal)
    return { status: 'attached', terminal: created.terminal }
  }
  let ended = false
  try {
    ended = await options.discard(created.terminal)
  } catch {
    ended = false
  }
  return ended ? { status: 'discarded' } : { status: 'orphaned', terminal: created.terminal }
}

const OUTCOME_MESSAGES: Readonly<Record<OpenedTerminalOutcome['status'], string>> = {
  attached: 'New terminal opened',
  discarded: 'The new terminal was closed because the view changed.',
  orphaned: 'A new terminal started but could not be closed. End it from the terminal list.',
  unavailable: 'The runtime could not open a new terminal.',
}

export type OpenTerminalOptions = {
  execute: (command: DevCommand) => Promise<DevReply>
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  shellProfileId: string | 'device-default'
  canAttach: () => boolean
  attach: (terminal: TerminalRecord) => void
}

/**
 * Start a terminal for one session worktree and hand it to `attach` only while
 * `canAttach` still holds. `shellProfileId` picks a shell; `'device-default'`
 * uses the device default while the host still advertises it. Resolves the
 * announcement for the outcome.
 */
export async function openTerminal(options: OpenTerminalOptions): Promise<string> {
  const { execute, scope, runtimeSessionId, worktreeId } = options
  const shellProfileId =
    options.shellProfileId === 'device-default'
      ? resolveDefaultShellProfileId(
          await listShellProfiles({ execute, scope }),
          toolbarPreferences().defaultShellProfileId
        )
      : options.shellProfileId
  const outcome = await openCreatedTerminal({
    create: () =>
      createSessionTerminal({
        execute,
        scope,
        runtimeSessionId,
        worktreeId,
        ...(shellProfileId !== undefined ? { shellProfileId } : {}),
      }),
    canAttach: options.canAttach,
    attach: options.attach,
    discard: (terminal) =>
      terminateSessionTerminal({
        execute,
        scope,
        runtimeSessionId,
        worktreeId,
        terminalId: terminal.id,
      }),
  })
  return OUTCOME_MESSAGES[outcome.status]
}
