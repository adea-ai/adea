import { describe, expect, test } from 'bun:test'

import {
  openRequestScope,
  registerRequestCleanup,
  RequestScopeClosedError,
  requestScopedValue,
  withRequestScope,
} from '../src/server/request-scope'

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('request scope', () => {
  test('memoizes a value for one scope and never shares it with another', async () => {
    const key = Symbol('value')
    let created = 0
    const create = () => ({ id: ++created })

    const first = await withRequestScope(() => {
      const a = requestScopedValue(key, create)
      const b = requestScopedValue(key, create)
      expect(b).toBe(a)
      return a
    })
    const second = await withRequestScope(() => requestScopedValue(key, create))

    expect(second).not.toBe(first)
    expect(created).toBe(2)
  })

  test('concurrent requests each get their own value', async () => {
    const key = Symbol('value')
    let created = 0
    const seen = await Promise.all(
      [1, 2, 3].map((n) =>
        withRequestScope(async () => {
          const value = requestScopedValue(key, () => ({ n, id: ++created }))
          await Promise.resolve()
          // Still the same value after an await, and still this request's.
          expect(requestScopedValue(key, () => ({ n: -1, id: -1 }))).toBe(value)
          return value
        })
      )
    )
    expect(new Set(seen).size).toBe(3)
    expect(seen.map((value) => value.n)).toEqual([1, 2, 3])
  })

  test('outside a scope every call creates a fresh value', () => {
    const key = Symbol('value')
    let created = 0
    const a = requestScopedValue(key, () => ++created)
    const b = requestScopedValue(key, () => ++created)
    expect([a, b]).toEqual([1, 2])
  })

  test('runs cleanup once when the handler returns', async () => {
    let closed = 0
    await withRequestScope(() => {
      registerRequestCleanup(() => {
        closed += 1
      })
      expect(closed).toBe(0)
    })
    expect(closed).toBe(1)
  })

  test('drops cleanup registered outside any scope', () => {
    expect(() => registerRequestCleanup(() => undefined)).not.toThrow()
  })

  test('a retained scope stays open after the handler returns, until released', async () => {
    const scope = openRequestScope()
    let closed = 0
    const holds: Array<() => void> = []
    await scope
      .run(async () => {
        registerRequestCleanup(() => {
          closed += 1
        })
        holds.push(scope.retain())
        return 'response'
      })
      .finally(() => scope.end())

    // The handler is done, but a stream still holds the scope.
    expect(closed).toBe(0)

    // Work started inside the stream still sees the same scope.
    const key = Symbol('late')
    let late: unknown
    await scope.run(async () => {
      late = requestScopedValue(key, () => 'late')
    })
    expect(late).toBe('late')
    expect(closed).toBe(0)

    holds[0]!()
    await Promise.resolve()
    expect(closed).toBe(1)
    holds[0]!()
    await Promise.resolve()
    expect(closed).toBe(1)
  })

  test('closes once all holds are released, whichever order they end in', async () => {
    const scope = openRequestScope()
    let closed = 0
    scope.run(() =>
      registerRequestCleanup(() => {
        closed += 1
      })
    )
    const releaseA = scope.retain()
    const releaseB = scope.retain()
    await scope.end()
    releaseA()
    await Promise.resolve()
    expect(closed).toBe(0)
    releaseB()
    await Promise.resolve()
    expect(closed).toBe(1)
  })

  test('a release before the handler returns does not close early', async () => {
    const scope = openRequestScope()
    let closed = 0
    scope.run(() =>
      registerRequestCleanup(() => {
        closed += 1
      })
    )
    const release = scope.retain()
    release()
    await Promise.resolve()
    expect(closed).toBe(0)
    await scope.end()
    expect(closed).toBe(1)
  })

  test('a throwing cleanup does not stop the others', async () => {
    let closed = 0
    await withRequestScope(() => {
      registerRequestCleanup(() => {
        throw new Error('boom')
      })
      registerRequestCleanup(() => {
        closed += 1
      })
    })
    expect(closed).toBe(1)
  })

  describe('teardown completes once and late work is refused', () => {
    test('an end() that arrives while a release-started teardown is running waits for it', async () => {
      const scope = openRequestScope()
      const slow = gate()
      let closerFinished = false
      scope.run(() =>
        registerRequestCleanup(async () => {
          await slow.promise
          closerFinished = true
        })
      )
      const release = scope.retain()
      await scope.end() // the handler returned; the hold keeps the scope open
      release() // starts the (slow, asynchronous) teardown

      let ended = false
      const second = scope.end().then(() => {
        ended = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(ended).toBe(false)
      slow.open()
      await second
      expect(closerFinished).toBe(true)
    })

    test('completion settles after the last closer, rejecting closers included', async () => {
      const scope = openRequestScope()
      const slow = gate()
      let ran = 0
      scope.run(() => {
        registerRequestCleanup(() => {
          ran += 1
          return Promise.reject(new Error('close failed'))
        })
        registerRequestCleanup(async () => {
          await slow.promise
          ran += 1
        })
      })
      void scope.end()
      let settled = false
      void scope.completion.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(settled).toBe(false)
      slow.open()
      await scope.completion
      expect(ran).toBe(2)
    })

    test('end() while a hold remains resolves now; completion waits for the hold', async () => {
      const scope = openRequestScope()
      const release = scope.retain()
      await scope.end()
      let settled = false
      void scope.completion.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      release()
      await scope.completion
      expect(settled).toBe(true)
    })

    test('after teardown starts, nothing new is created, retained or left unclosed', async () => {
      const scope = openRequestScope()
      let early = 0
      scope.run(() =>
        registerRequestCleanup(() => {
          early += 1
        })
      )
      await scope.end()
      expect(early).toBe(1)

      const key = Symbol('late')
      expect(() => scope.run(() => requestScopedValue(key, () => 'late'))).toThrow(
        RequestScopeClosedError
      )
      expect(() => scope.retain()).toThrow(RequestScopeClosedError)

      // A resource registered late is closed immediately rather than leaked.
      let lateClosed = 0
      scope.run(() =>
        registerRequestCleanup(() => {
          lateClosed += 1
        })
      )
      await Promise.resolve()
      await Promise.resolve()
      expect(lateClosed).toBe(1)
      expect(early).toBe(1)
    })

    test('a second end() on a closed scope is a no-op', async () => {
      const scope = openRequestScope()
      let closed = 0
      scope.run(() =>
        registerRequestCleanup(() => {
          closed += 1
        })
      )
      await scope.end()
      await scope.end()
      expect(closed).toBe(1)
    })
  })
})
