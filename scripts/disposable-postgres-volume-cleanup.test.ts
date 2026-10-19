import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  /** The anonymous volume each container owns; a removal takes it with it. */
  containerVolumes?: Readonly<Record<string, string>>
  fail?: readonly string[]
  unknown?: readonly string[]
  calls?: string[][]
}) {
  const containers = new Set(options.containers ?? [])
  const volumes = new Set(options.volumes ?? [])
  const containerVolumes = new Map(Object.entries(options.containerVolumes ?? {}))
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
      // `--volumes` takes the container's anonymous volume with it.
      if (args.includes('--volumes')) {
        const volume = containerVolumes.get(name)
        if (volume) volumes.delete(volume)
        containerVolumes.delete(name)
      }
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

  test('a container registered before its create is removed when a later step failed', () => {
    // The proof container was created, and the run failed before its volume was
    // discovered. The name was registered before the create, so the teardown
    // still removes the container, and the container's volume goes with it.
    const calls: string[][] = []
    const run = fakeDocker({
      containers: [CONTAINER],
      volumes: [VOLUME],
      containerVolumes: { [CONTAINER]: VOLUME },
      calls,
    })
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER],
      volumes: [],
      removeContainer,
      run,
    })
    expect(outcome.errors).toEqual([])
    expect(outcome.remaining).toEqual([])
    expect(outcome.removed).toEqual([CONTAINER])
    // The removal takes the volume with it, so the undiscovered volume is gone.
    expect(calls).toContainEqual(removeContainer(CONTAINER))
    expect(calls.some((call) => call[0] === 'volume' && call[1] === 'inspect')).toBe(false)
  })

  test('a container whose state cannot be read is still removed', () => {
    // The state is unknown, so the removal is the only way to take the
    // container and its volume with it. The unknown state is reported too.
    const calls: string[][] = []
    const run = fakeDocker({
      containers: [CONTAINER],
      volumes: [VOLUME],
      containerVolumes: { [CONTAINER]: VOLUME },
      unknown: [CONTAINER],
      calls,
    })
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER],
      volumes: [],
      removeContainer,
      run,
    })
    expect(calls).toContainEqual(removeContainer(CONTAINER))
    expect(outcome.errors.join(' ')).toContain('could not be read')
  })

  test('a volume whose state cannot be read is still removed', () => {
    const calls: string[][] = []
    const run = fakeDocker({ volumes: [VOLUME], unknown: [VOLUME], calls })
    const outcome = cleanupOwnedResources({
      containers: [],
      volumes: [VOLUME],
      removeContainer,
      run,
    })
    expect(calls).toContainEqual(['volume', 'rm', VOLUME])
    expect(outcome.errors.join(' ')).toContain('could not be read')
  })

  test('an uncertain timeout outcome is still cleaned up', () => {
    // The create timed out, so the container may or may not exist. Its name was
    // registered before the attempt, and the teardown removes it if it is there.
    const calls: string[][] = []
    const run = fakeDocker({ containers: [CONTAINER], calls })
    const outcome = cleanupOwnedResources({
      containers: [CONTAINER],
      volumes: [],
      removeContainer,
      run,
    })
    expect(calls).toContainEqual(removeContainer(CONTAINER))
    expect(outcome.errors).toEqual([])
    expect(outcome.remaining).toEqual([])
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

describe('the disposable volume proof registration', () => {
  const source = readFileSync(
    resolve(import.meta.dir, 'smoke/disposable-postgres-volume.smoke.test.ts'),
    'utf8'
  )

  test('every container name is owned before its create attempt', () => {
    // The proof container.
    const proofOwn = source.indexOf('ownContainer(proofContainer)')
    const proofCreate = source.indexOf("'create',\n    '--name',\n    proofContainer")
    expect(proofOwn).toBeGreaterThanOrEqual(0)
    expect(proofCreate).toBeGreaterThan(proofOwn)
    // The unrelated sentinel.
    const sentinelOwn = source.indexOf('ownContainer(sentinelContainer)')
    const sentinelCreate = source.indexOf("'create',\n    '--name',\n    sentinelContainer")
    expect(sentinelOwn).toBeGreaterThanOrEqual(0)
    expect(sentinelCreate).toBeGreaterThan(sentinelOwn)
  })

  test('every discovered volume is recorded immediately', () => {
    for (const name of ['ownedVolume', 'sentinelVolume']) {
      const discovery = source.indexOf(
        `ownedAnonymousVolume(containerMounts(${name === 'ownedVolume' ? 'proofContainer' : 'sentinelContainer'}))`
      )
      const record = source.indexOf(`ownVolume(${name})`)
      expect(discovery).toBeGreaterThanOrEqual(0)
      expect(record).toBeGreaterThan(discovery)
    }
  })

  test('no success receipt survives a failed cleanup', () => {
    // The cleanup failure is raised before the receipt is written.
    const failure = source.indexOf('the disposable volume proof left owned resources')
    const receipt = source.indexOf('DISPOSABLE_VOLUME_NO_LEAK')
    expect(failure).toBeGreaterThanOrEqual(0)
    expect(receipt).toBeGreaterThan(failure)
    // The receipt is only written once the teardown reported no failure.
    expect(source).toContain('if (outcome.errors.length > 0) {')
    expect(source).toContain('if (proofOutcome) {')
  })
})
