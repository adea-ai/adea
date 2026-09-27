import type { Scope } from '../dev-runtime/channel/identity'

type RuntimeSessionView = Readonly<{ id: string; archived: boolean }>

type PresentedRuntimeSessionOptions = Readonly<{
  currentScope(): Scope | undefined
  resolveSession(id: string): RuntimeSessionView | undefined
}>

function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId])
}

/**
 * Keeps an ephemeral visible-session hint only while the authenticated scope
 * and current host projection continue to validate it. The hint is not a
 * command grant and never supplies an operation scope.
 */
export function createPresentedRuntimeSession(options: PresentedRuntimeSessionOptions) {
  let presented: Readonly<{ id: string; scopeKey: string }> | undefined

  function set(candidate: string | undefined): void {
    presented = undefined
    if (!candidate || candidate.length > 128) return

    const scope = options.currentScope()
    if (!scope) return
    try {
      const session = options.resolveSession(candidate)
      if (session?.id === candidate && !session.archived)
        presented = { id: candidate, scopeKey: scopeKey(scope) }
    } catch {
      // A stale or unbound renderer hint simply clears presentation state.
    }
  }

  function current(): string | undefined {
    if (!presented) return undefined
    const scope = options.currentScope()
    if (!scope || scopeKey(scope) !== presented.scopeKey) {
      presented = undefined
      return undefined
    }
    try {
      const session = options.resolveSession(presented.id)
      if (session?.id === presented.id && !session.archived) return presented.id
    } catch {
      // The hint is optional and expires when its host projection is unavailable.
    }
    presented = undefined
    return undefined
  }

  function revalidateAfterComposition(): void {
    const previous = presented
    presented = undefined
    if (!previous) return
    const scope = options.currentScope()
    if (!scope || scopeKey(scope) !== previous.scopeKey) return
    set(previous.id)
  }

  return { current, revalidateAfterComposition, set }
}
