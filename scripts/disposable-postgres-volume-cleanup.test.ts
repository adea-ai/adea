import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

import {
  RESOURCE_STATE,
  cleanupOwnedResources,
  classifyContainer,
  classifyResource,
  classifyVolume,
  runBounded,
} from './disposable-postgres-volume-cleanup.mjs'

const CONTAINER = 'adea-ci-volume-proof-abcdef'
const SENTINEL = 'adea-ci-volume-sentinel-abcdef'
const VOLUME = 'ca1d3fd9000cc1ea57f4ee664ed7f29d56067cc6b03828cc44e2f61d3ec43f9'

type Result = {
  status: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const ok = (): Result => ({ status: 0, stdout: '', stderr: '', timedOut: false })

const absent = (what: string): Result => ({
  status: 1,
  stdout: '',
  stderr: `Error: No such ${what}: name`,
  timedOut: false,
})

const failed = (): Result => ({
  status: 1,
  stdout: '',
  stderr: 'docker: injected cleanup failure',
  timedOut: false,
})

/**
 * A Docker stand-in whose behaviour each test declares. `containers` and
 * `volumes` hold the resources that still exist; `fail` names the resources
 * whose removal fails; `unknown` names the resources whose state cannot be
 * read.
 */
function fakeDocker(options: {
  containers?: readonly string[]
  volumes?: readonly string[]
  fail?: readonly string[]
  unknown?: readonly string[]
  calls?: string[][]
}) {
  const containers = new Set(options.containers ?? [])
  const volumes = new Set(options.volumes ?? [])
  const fail = new Set(options.fail ?? [])
  const unknown = new Set(options.unknown ?? [])
  const calls: string[][] = options.calls ?? []
  return (args: string[]): Result => {
    calls.push(args)
    if (args[0] === 'inspect') {
      const name = args[1] ?? ''
      if (unknown.has(name)) return failed()
      return containers.has(name) ? ok() : absent('object')
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const name = args[2] ?? ''
      if (unknown.has(name)) return failed()
      return volumes.has(name) ? ok() : absent('volume')
    }
    if (args[0] === 'rm') {
      const name = args[args.length - 1] ?? ''
      if (fail.has(name)) return failed()
      containers.delete(name)
      return ok()
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      const name = args[2] ?? ''
      if (fail.has(name)) return failed()
      volumes.delete(name)
      return ok()
    }
    return ok()
  }
}

const removeContainer = (name: string) => ['rm', '--force', '--volumes', name]

/** A runner whose removals always time out. */
const timedOutRunner = (args: string[]): Result =>
  args[0] === 'inspect' ? ok() : { status: 1, stdout: '', stderr: '', timedOut: true }

/** A runner whose removals report success but change nothing. */
const ineffectiveRunner = (): Result => ok()

describe('the owned-resource teardown', () => {
  test('removes every owned container and volume and confirms they are gone', () => {
    const calls: string[][] = []
    const run = fakeDocker({ containers: [CONTAINER, SENTINEL], volumes: [VOLUME], calls })
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER, SENTINEL],
      volumes: [VOLUME],
      removeContainer,
      run,
    })
    expect(outcome.errors).toEqual([])
    expect(outcome.remaining).toEqual([])
    expect(outcome.removed).toEqual([CONTAINER, SENTINEL, VOLUME])
    // The volumes are removed by their own name, because a container that is
    // already gone does not carry its volume's identity.
    expect(calls).toContainEqual(['volume', 'rm', VOLUME])
  })

  test('an injected cleanup failure is reported and never reads as a pass', () => {
    const run = fakeDocker({
      containers: [CONTAINER, SENTINEL],
      volumes: [VOLUME],
      fail: [SENTINEL],
    })
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER, SENTINEL],
      volumes: [VOLUME],
      removeContainer,
      run,
    })
    expect(outcome.errors.join(' ')).toContain('the owned container')
    expect(outcome.errors.join(' ')).toContain(SENTINEL)
    // The failed container is still present, and that is an error of its own.
    expect(outcome.remaining).toContain(SENTINEL)
  })

  test('every owned cleanup is attempted even after one fails', () => {
    const calls: string[][] = []
    const run = fakeDocker({
      containers: [CONTAINER, SENTINEL],
      volumes: [VOLUME],
      fail: [CONTAINER],
      calls,
    })
    cleanupOwnedResources({
      containers: [CONTAINER, SENTINEL],
      volumes: [VOLUME],
      removeContainer,
      run,
    })
    // The sentinel removal and the volume removal both ran, even though the
    // first container removal failed.
    expect(calls).toContainEqual(removeContainer(SENTINEL))
    expect(calls).toContainEqual(['volume', 'rm', VOLUME])
  })

  test('a failed inspect is unknown, never absent', () => {
    const run = fakeDocker({ containers: [CONTAINER], unknown: [CONTAINER] })
    expect(classifyContainer(run, CONTAINER)).toBe(RESOURCE_STATE.unknown)
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER],
      volumes: [],
      removeContainer,
      run,
    })
    expect(outcome.errors.join(' ')).toContain('could not be read')
    expect(outcome.remaining).toContain(CONTAINER)
  })

  test('a volume whose state cannot be read is never treated as absent', () => {
    const run = fakeDocker({ volumes: [VOLUME], unknown: [VOLUME] })
    expect(classifyVolume(run, VOLUME)).toBe(RESOURCE_STATE.unknown)
    const outcome = cleanupOwnedResources({
      containers: [],
      volumes: [VOLUME],
      removeContainer,
      run,
    })
    expect(outcome.errors.join(' ')).toContain('could not be read')
    expect(outcome.remaining).toContain(VOLUME)
  })

  test('resources that are already absent are not an error', () => {
    const run = fakeDocker({ containers: [], volumes: [] })
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER],
      volumes: [VOLUME],
      removeContainer,
      run,
    })
    expect(outcome.errors).toEqual([])
    expect(outcome.remaining).toEqual([])
    expect(outcome.absent).toEqual([CONTAINER, VOLUME])
  })

  test('a timed-out removal is a failure, not a completed one', () => {
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER],
      volumes: [],
      removeContainer,
      run: timedOutRunner,
    })
    expect(outcome.errors.join(' ')).toContain('timed out')
    expect(outcome.remaining).toContain(CONTAINER)
  })

  test('a resource that survives a successful removal is reported', () => {
    // A removal that reports success but leaves the resource behind is caught
    // by the confirmation step.
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER],
      volumes: [],
      removeContainer,
      run: ineffectiveRunner,
    })
    expect(outcome.errors.join(' ')).toContain('still present')
    expect(outcome.remaining).toContain(CONTAINER)
  })

  test('the state classifier separates present, absent and unknown', () => {
    expect(classifyResource(ok(), /no such/iu)).toBe(RESOURCE_STATE.present)
    expect(classifyResource(absent('object'), /no such/iu)).toBe(RESOURCE_STATE.absent)
    expect(classifyResource(failed(), /no such/iu)).toBe(RESOURCE_STATE.unknown)
  })
})

describe('the bounded command runner', () => {
  test('a command that outlives its bound is killed and reported as a timeout', () => {
    const result = runBounded('sleep', ['5'], { spawnSync, timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(result.status).not.toBe(0)
  }, 30_000)

  test('a command that finishes in time is reported normally', () => {
    const result = runBounded('true', [], { spawnSync, timeoutMs: 10_000 })
    expect(result.timedOut).toBe(false)
    expect(result.status).toBe(0)
  })
})
