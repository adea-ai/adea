import { describe, expect, test } from 'bun:test'
import { createSceneLoadScope } from '../src/loading'

describe('scene load scope', () => {
  test('starts active and exposes a shared abort signal', () => {
    const scope = createSceneLoadScope()

    expect(scope.signal.aborted).toBe(false)
    expect(scope.isAborted()).toBe(false)
  })

  test('aborts all consumers exactly once', () => {
    const scope = createSceneLoadScope()
    let abortEvents = 0
    scope.signal.addEventListener('abort', () => {
      abortEvents += 1
    })

    scope.abort()
    scope.abort()

    expect(scope.signal.aborted).toBe(true)
    expect(scope.isAborted()).toBe(true)
    expect(abortEvents).toBe(1)
  })
})
