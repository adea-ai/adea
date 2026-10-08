// Application-owned terminal close semantics. Closing the last center leaf
// substitutes a placeholder; when that leaf carried the session's primary
// terminal and the runtime grants `dev.terminal.manage`, the close ends the
// runtime terminal instance instead of leaving it running headless. No PTY
// is created or stopped here without the runtime's own command gate.
import type {
  DevCommand,
  DevErrorCode,
  DevReply,
  PaneLeaf,
  PaneNode,
  Scope,
  TerminalRecord,
} from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_terminal_create,
  devOperationMetadataFor_dev_terminal_terminate,
} from '@adea-ai/types/dev-runtime-operation-metadata'

import { buildDevCommandFromMetadata } from '../browser/command-core'
import { resolveSelectedTerminal } from './selected-terminal'

/** The layout model's close placeholder: closing the last center leaf swaps
 *  in one of these terminal leaves, and the pane renderer shows the
 *  standardized "no terminal open" state for it. */
export const TERMINAL_PLACEHOLDER_PREFIX = 'dev-placeholder-'

export function isTerminalPlaceholderLeaf(leaf: PaneLeaf): boolean {
  return leaf.pane === 'terminal' && leaf.id.startsWith(TERMINAL_PLACEHOLDER_PREFIX)
}

/**
 * Whether closing a leaf must terminate the runtime terminal instance.
 *
 * True only when the closed leaf was the center's last leaf (the close
 * substitutes the placeholder), the session projects a primary terminal, and
 * the leaf was bound to it — either explicitly (`resourceId`) or as the first
 * unbound leaf that resolves the primary. Closing one of several leaves, or a
 * leaf bound to a split terminal, never terminates: the instance stays live
 * for its other surfaces, and the remaining split pane keeps its own binding.
 */
export function terminatesOnLastClose(input: {
  /** Leaf count in the center before the close. */
  leafCountBefore: number
  closedLeaf: PaneLeaf
  primaryTerminalId: string | undefined
}): boolean {
  return (
    input.leafCountBefore === 1 &&
    input.closedLeaf.pane === 'terminal' &&
    input.primaryTerminalId !== undefined &&
    (input.closedLeaf.resourceId === undefined ||
      input.closedLeaf.resourceId === input.primaryTerminalId)
  )
}

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

/** Swap one leaf by id inside the center tree, keeping every other node —
 *  ratios, split ids and surviving leaves — untouched. Used to bind a fresh
 *  terminal record onto the placeholder's position. */
export function replaceLeaf(node: PaneNode, leafId: string, next: PaneLeaf): PaneNode {
  if (node.kind === 'leaf') return node.id === leafId ? next : node
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], leafId, next),
      replaceLeaf(node.children[1], leafId, next),
    ],
  }
}
