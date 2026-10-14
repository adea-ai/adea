// Creating and ending runtime terminals from the Dev View. Loaded on first use
// (it ships with the terminal pane chunk) so the command builders, shell
// profiles and toolbar preferences stay out of the Dev View shell.
import type {
  DevCommand,
  DevErrorCode,
  DevReply,
  Scope,
  TerminalRecord,
} from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_terminal_create,
  devOperationMetadataFor_dev_terminal_terminate,
} from '@adea-ai/types/dev-runtime-operation-metadata'

import { buildDevCommandFromMetadata } from '../browser/command-core'
import { resolveSelectedTerminal } from './selected-terminal'
import { listShellProfiles } from './shell-profiles'
import { resolveDefaultShellProfileId, toolbarPreferences } from './toolbar-preferences'

/**
 * End one runtime terminal instance: revalidate the exact record (the
 * terminate command binds its generation), then issue the privileged
 * `dev.terminal.terminate` with an explicit confirmation id. Resolves false
 * without issuing anything when the record can no longer be verified.
 */
export async function terminateSessionTerminal(options: {
  execute: (command: DevCommand) => Promise<DevReply>
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  terminalId: string
}): Promise<boolean> {
  const resolved = await resolveSelectedTerminal({
    execute: options.execute,
    scope: options.scope,
    selection: {
      runtimeSessionId: options.runtimeSessionId,
      worktreeId: options.worktreeId,
      terminalId: options.terminalId,
    },
  })
  if (resolved.status !== 'ready') return false
  const terminal = resolved.terminal
  const command = buildDevCommandFromMetadata(devOperationMetadataFor_dev_terminal_terminate, {
    scope: options.scope,
    body: {
      terminalId: terminal.id,
      expectedGeneration: terminal.generation,
      confirmationId: `close-${terminal.id}-${terminal.generation}`,
    },
    resource: { kind: 'terminal', id: terminal.id, generation: terminal.generation },
  })
  try {
    const reply = await options.execute(command)
    return reply.ok
  } catch {
    return false
  }
}

/**
 * Create a fresh terminal instance for the selected session's worktree. The
 * standard first-unbound binding cannot resurrect a terminated primary (its
 * projected id fails resolution), so the new-terminal action binds the
 * created record explicitly on the leaf.
 */
export async function createSessionTerminal(options: {
  execute: (command: DevCommand) => Promise<DevReply>
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  /** A host-advertised shell profile; absent starts the host default. */
  shellProfileId?: string
}): Promise<
  | Readonly<{ status: 'ready'; terminal: TerminalRecord }>
  | Readonly<{ status: 'unavailable'; reason: DevErrorCode }>
> {
  const command = buildDevCommandFromMetadata(devOperationMetadataFor_dev_terminal_create, {
    scope: options.scope,
    body: {
      runtimeSessionId: options.runtimeSessionId,
      worktreeId: options.worktreeId,
      cols: 80,
      rows: 24,
      ...(options.shellProfileId !== undefined ? { shellProfileId: options.shellProfileId } : {}),
    },
  })
  try {
    const reply = await options.execute(command)
    if (!reply.ok) return { status: 'unavailable', reason: 'unavailable' }
    const terminal = reply.value as TerminalRecord
    if (
      !terminal ||
      typeof terminal.id !== 'string' ||
      terminal.id.length === 0 ||
      !Number.isSafeInteger(terminal.generation)
    )
      return { status: 'unavailable', reason: 'incompatible' }
    return { status: 'ready', terminal }
  } catch {
    return { status: 'unavailable', reason: 'unavailable' }
  }
}

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
