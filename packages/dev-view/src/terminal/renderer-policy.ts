// Renderer policy for the terminal (issue #396): lazy WebGL with a truthful
// DOM fallback. The decision logic is pure so the fallback ladder is
// unit-testable without a canvas; the Solid component applies it.
export type RendererKind = 'webgl' | 'dom'

export type RendererPolicyState = Readonly<{
  active: RendererKind
  contextLosses: number
  /** After this many unrecoverable context losses WebGL stays disabled. */
  maxWebglRecoveries: number
  webglDisabled: boolean
}>

export function createRendererPolicy(maxWebglRecoveries = 2) {
  let state: RendererPolicyState = {
    active: 'dom',
    contextLosses: 0,
    maxWebglRecoveries,
    webglDisabled: false,
  }

  return {
    snapshot(): RendererPolicyState {
      return state
    },

    /** Called after the DOM terminal mounts. First choice is lazy WebGL. */
    mounted(): RendererPolicyState {
      state = state.webglDisabled ? state : { ...state, active: 'webgl' }
      return state
    },

    /** WebGL addon failed to load or initialize: fall back to DOM. */
    webglInitFailed(reason: string): RendererPolicyState {
      void reason
      state = { ...state, active: 'dom', webglDisabled: true }
      return state
    },

    /** The WebGL context was lost: try one recovery, then stay on DOM. */
    contextLost(): { policy: RendererPolicyState; retryWebgl: boolean } {
      const contextLosses = state.contextLosses + 1
      if (contextLosses > state.maxWebglRecoveries) {
        state = { ...state, active: 'dom', contextLosses, webglDisabled: true }
        return { policy: state, retryWebgl: false }
      }
      state = { ...state, active: 'dom', contextLosses }
      return { policy: state, retryWebgl: true }
    },

    /** WebGL recovered after context loss. */
    webglRestored(): RendererPolicyState {
      state = { ...state, active: 'webgl' }
      return state
    },
  }
}

export type RendererPolicy = ReturnType<typeof createRendererPolicy>
