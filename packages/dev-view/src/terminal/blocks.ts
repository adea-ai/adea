// Command blocks for the terminal (issue #396).
//
// Clean-room boundary: block behavior is implemented against the external
// OSC 133/7 shell-protocol observations that Adea's own authenticated
// wrapper emits (see the host's shell-integration). Warp's AGPL block
// implementation contributed nothing: no hook names, payload schemas,
// parser structure, fixtures, or UI strings. Command boundaries are only
// ever asserted by authenticated observations — never inferred from screen
// text, and unauthenticated output never opens, closes, or annotates a
// block.
export type CommandBlockState = 'running' | 'completed'

export type CommandBlock = Readonly<{
  id: string
  /** The command line as reported at preexec (bounded, display label). */
  command: string
  /** Sequence of the first output chunk after the command started. */
  startSequence: string
  /** UTC instant the observation arrived. */
  startedAt: string
  completedAt?: string
  exitCode?: number
  durationMs?: number
  state: CommandBlockState
}>

export type ShellObservation =
  | { kind: 'preexec'; command: string; at: string; sequence: string }
  | { kind: 'precmd'; exitCode: number; at: string; sequence: string }
  | { kind: 'cwd'; cwd: string; at: string }

export type BlocksState = Readonly<{
  blocks: readonly CommandBlock[]
  /** Latest authenticated cwd observation (display only, never authority). */
  cwd?: string
  /** Bounded retained block history. */
  maxBlocks: number
}>

const MAX_COMMAND_LABEL = 512
const MAX_CWD = 1024
const DEFAULT_MAX_BLOCKS = 200

let blockCounter = 0
function nextBlockId(): string {
  blockCounter += 1
  return `block-${blockCounter}`
}

export function createBlocksState(maxBlocks = DEFAULT_MAX_BLOCKS): BlocksState {
  return { blocks: [], maxBlocks }
}

export function applyObservation(state: BlocksState, observation: ShellObservation): BlocksState {
  if (observation.kind === 'cwd') {
    const cwd = observation.cwd.slice(0, MAX_CWD)
    return { ...state, cwd }
  }
  if (observation.kind === 'preexec') {
    const block: CommandBlock = {
      id: nextBlockId(),
      command: observation.command.slice(0, MAX_COMMAND_LABEL),
      startSequence: observation.sequence,
      startedAt: observation.at,
      state: 'running',
    }
    const blocks = [...state.blocks, block]
    return { ...state, blocks: blocks.slice(-state.maxBlocks) }
  }
  // precmd completes the newest running block; unmatched precmd observations
  // (e.g. wrapper started mid-command) are dropped rather than fabricated.
  const index = state.blocks.findLastIndex((block) => block.state === 'running')
  if (index < 0) return state
  const target = state.blocks[index]!
  const durationMs = Math.max(0, Date.parse(observation.at) - Date.parse(target.startedAt))
  if (!Number.isFinite(durationMs)) return state
  const completed: CommandBlock = {
    ...target,
    state: 'completed',
    exitCode: observation.exitCode,
    completedAt: observation.at,
    durationMs,
  }
  const blocks = [...state.blocks]
  blocks[index] = completed
  return { ...state, blocks }
}

/** Blocks visible in the block rail: newest last, bounded by maxBlocks. */
export function visibleBlocks(state: BlocksState): readonly CommandBlock[] {
  return state.blocks
}

/** A block can be copied/exported locally only once it completed. */
export function blockExportText(block: CommandBlock): string | null {
  if (block.state !== 'completed') return null
  return `${block.command}  # exit ${block.exitCode} · ${block.durationMs}ms`
}
