import { AsyncLocalStorage } from 'node:async_hooks'

type Closer = () => Promise<void> | void

type Scope = {
  readonly closers: Set<Closer>
  readonly values: Map<symbol, unknown>
  /** Set the moment teardown starts; nothing may be registered or created after. */
  closed: boolean
}

const scope = new AsyncLocalStorage<Scope>()

/** Thrown when work reaches for a request resource after its scope began closing. */
export class RequestScopeClosedError extends Error {
  constructor() {
    super('The request scope is closed')
    this.name = 'RequestScopeClosedError'
  }
}

/**
 * One request's collection of per-request cleanup callbacks (short-lived
 * database connections) and per-request memoized values. The scope closes once
 * the handler has returned AND every `retain()` has been released, so a
 * streaming response can keep the scope open for exactly as long as its
 * producer runs.
 *
 * Teardown happens once. `completion` is that one teardown's promise: it
 * resolves after every closer has settled, however many callers ask and
 * whichever of them started it.
 */
export type RequestScope = Readonly<{
  /** Runs `work` (and everything it starts) inside this scope. */
  run<T>(work: () => T): T
  /**
   * Keeps the scope open past the handler's return (a streaming body). The
   * returned function releases the hold; it is idempotent. Call it before the
   * handler returns, and release it when the work that uses the scope has
   * unwound. Throws once the scope has begun closing.
   */
  retain(): () => void
  /**
   * Marks the handler finished. Resolves when the scope has fully closed, or
   * straight away while a hold still keeps it open (use `completion` to wait
   * for the hold's teardown).
   */
  end(): Promise<void>
  /** Resolves when teardown has finished; never rejects. */
  readonly completion: Promise<void>
}>

export function openRequestScope(): RequestScope {
  const state: Scope = { closers: new Set<Closer>(), values: new Map(), closed: false }
  let holds = 0
  let ended = false
  let teardown: Promise<void> | undefined
  let finish!: () => void
  const completion = new Promise<void>((resolve) => {
    finish = resolve
  })

  function closeIfIdle(): Promise<void> {
    // One teardown, however many callers: a caller that arrives while it is
    // still running waits for it instead of resolving early.
    if (teardown) return teardown
    if (!ended || holds > 0) return Promise.resolve()
    state.closed = true
    const pending = [...state.closers]
    state.closers.clear()
    state.values.clear()
    teardown = Promise.allSettled(pending.map(async (close) => close())).then(finish)
    return teardown
  }

  return {
    run: (work) => scope.run(state, work),
    retain() {
      if (state.closed) throw new RequestScopeClosedError()
      holds += 1
      let released = false
      return () => {
        if (released) return
        released = true
        holds -= 1
        void closeIfIdle()
      }
    },
    end() {
      ended = true
      return closeIfIdle()
    },
    completion,
  }
}

/**
 * Runs one API request inside a scope that collects per-request cleanup
 * callbacks (short-lived database connections) and runs them once the
 * response has been produced — the replacement for Next's request `after()`.
 */
export async function withRequestScope<T>(work: () => Promise<T> | T): Promise<T> {
  const requestScope = openRequestScope()
  try {
    return await requestScope.run(work)
  } finally {
    await requestScope.end()
  }
}

/**
 * Registers `closer` to run when the current request scope closes. Outside a
 * scope there is nothing to close it, so it is dropped. Registering into a
 * scope that already closed runs the closer at once instead: a resource that
 * would otherwise outlive the request is released, not leaked.
 */
export function registerRequestCleanup(closer: Closer): void {
  const store = scope.getStore()
  if (!store) return
  if (store.closed) {
    void Promise.resolve()
      .then(closer)
      .catch(() => undefined)
    return
  }
  store.closers.add(closer)
}

/**
 * Memoizes `create()` for the lifetime of the current request scope, keyed by
 * `key`. Outside a scope there is nothing to share across, so every call
 * creates a fresh value. A value is never visible to another request: each
 * scope owns its own map and drops it when it closes. Once a scope has begun
 * closing, nothing new is created in it (`RequestScopeClosedError`): a late
 * continuation must not open a replacement resource nobody will close.
 */
export function requestScopedValue<T>(key: symbol, create: () => T): T {
  const store = scope.getStore()
  if (!store) return create()
  if (store.closed) throw new RequestScopeClosedError()
  if (store.values.has(key)) return store.values.get(key) as T
  const value = create()
  store.values.set(key, value)
  return value
}
