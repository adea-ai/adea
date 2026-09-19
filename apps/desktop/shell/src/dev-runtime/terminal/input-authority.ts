// TerminalInputAuthority (issue #396): one input source owns one terminal
// generation at a time, and every write chunk is re-admitted against the
// current ownership so a partial paste or prompt stream cannot cross an
// ownership change (docs/specs/dev-runtime.md, "Shell integration and
// input").
//
// The reducer is pure: no clock, no I/O. #400 later binds real harness
// ownership to this seam; the denied/allowed fixtures here are its contract.
export type TerminalInputSource =
  | 'terminal_user'
  | 'chat_user'
  | 'prompt_delivery'
  | 'browser_takeover'

export type InputAuthorityError =
  | { ok: false; code: 'stale_generation'; message: string }
  | { ok: false; code: 'invalid_state'; message: string }

export type InputFence = Readonly<{
  /** Opaque write fence; validated against the authority before every chunk. */
  readonly fenceId: string
  readonly terminalId: string
  readonly source: TerminalInputSource
  readonly generation: number
}>

export type InputAuthorityState = Readonly<{
  terminalId: string
  owner: { source: TerminalInputSource; generation: number } | null
  /** Monotonic within the authority; each ownership change creates a new fence epoch. */
  epoch: number
}>

export function createInputAuthority(terminalId: string) {
  let state: InputAuthorityState = { terminalId, owner: null, epoch: 0 }

  function admit(
    source: TerminalInputSource,
    generation: number
  ): { ok: true; fence: InputFence } | InputAuthorityError {
    if (state.owner && state.owner.generation > generation) {
      return {
        ok: false,
        code: 'stale_generation',
        message: `generation ${generation} is behind the active owner generation ${state.owner.generation}`,
      }
    }
    state = { ...state, owner: { source, generation }, epoch: state.epoch + 1 }
    return { ok: true, fence: { fenceId: `${state.epoch}`, terminalId, source, generation } }
  }

  function release(
    source: TerminalInputSource,
    generation: number
  ): InputAuthorityError | { ok: true } {
    if (!state.owner) return { ok: true }
    if (state.owner.source !== source || state.owner.generation !== generation) {
      return {
        ok: false,
        code: 'invalid_state',
        message: 'release does not match the current owner',
      }
    }
    state = { ...state, owner: null, epoch: state.epoch + 1 }
    return { ok: true }
  }

  /**
   * Re-admission for one chunk: a fence from an older epoch, a stale
   * generation, or a foreign source is inert. Called after every
   * asynchronous yield and before every chunk, so a partial paste cannot
   * cross an ownership change.
   */
  function admitChunk(fence: InputFence): InputAuthorityError | { ok: true } {
    if (fence.terminalId !== state.terminalId) {
      return { ok: false, code: 'invalid_state', message: 'fence is bound to another terminal' }
    }
    if (!state.owner || Number(fence.fenceId) !== state.epoch) {
      return { ok: false, code: 'invalid_state', message: 'write fence is no longer current' }
    }
    if (state.owner.source !== fence.source) {
      return {
        ok: false,
        code: 'invalid_state',
        message: `input ownership moved to ${state.owner.source}`,
      }
    }
    if (state.owner.generation !== fence.generation) {
      return {
        ok: false,
        code: 'stale_generation',
        message: `fence generation ${fence.generation} is not the owned generation ${state.owner.generation}`,
      }
    }
    return { ok: true }
  }

  function releaseFence(fence: InputFence): InputAuthorityError | { ok: true } {
    const current = admitChunk(fence)
    if (!current.ok) return current
    return release(fence.source, fence.generation)
  }

  function snapshot(): InputAuthorityState {
    return state
  }

  return { admit, release, releaseFence, admitChunk, snapshot }
}

export type TerminalInputAuthority = ReturnType<typeof createInputAuthority>

/**
 * Fenced chunk writer: splits a payload and revalidates the fence before
 * every chunk, invoking `write` only while ownership holds.
 */
export function fencedWrite(
  authority: TerminalInputAuthority,
  fence: InputFence,
  chunks: readonly Uint8Array[],
  write: (chunk: Uint8Array) => void
): { written: number; stopped: boolean } {
  let written = 0
  for (const chunk of chunks) {
    if (!authority.admitChunk(fence).ok) return { written, stopped: true }
    write(chunk)
    written += 1
  }
  return { written, stopped: false }
}
