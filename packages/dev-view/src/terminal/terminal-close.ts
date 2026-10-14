// Application-owned terminal close semantics. Closing the last center leaf
// substitutes a placeholder; when that leaf carried the session's primary
// terminal and the runtime grants `dev.terminal.manage`, the close ends the
// runtime terminal instance instead of leaving it running headless. No PTY
// is created or stopped here without the runtime's own command gate.
import type { PaneLeaf, PaneNode } from '@adea-ai/types/dev-runtime'

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
 * A single-flight guard: `run` starts the task unless one is already in
 * flight, and resolves `undefined` for the ignored call. The flag is set
 * synchronously, so two picks in the same tick cannot both pass.
 */
export function createExclusiveRunner() {
  let running = false
  return {
    running: () => running,
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (running) return undefined
      running = true
      try {
        return await task()
      } finally {
        running = false
      }
    },
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
