// Fault-path tests for the capture provisioning smoke lifecycle, run without Docker. A fake Docker keeps the names
// it is asked to create, and a fake child stands in for the helper's process. The file sits at the top level of
// scripts/, so the unit lane runs it. The real-Docker run is scripts/smoke/capture-provisioning.smoke.test.ts.

import { describe, expect, test } from 'bun:test'

import { runOwnedSmoke, smokeBounds } from './smoke/capture-provisioning-run.mjs'

const owned = 'adea-capture-prov-0123456789ab'
// Short bounds keep the timeout paths fast. Every other bound is the real one.
const fastBounds = {
  ...smokeBounds,
  ownedMs: 1_000,
  readyMs: 1_000,
  stopAfterTermMs: 50,
  stopAfterKillMs: 50,
}

type DockerReply = { error?: Error; status: number | null; stderr: string; stdout: string }

// Keeps the names Docker holds, and answers the run, inspect and rm calls the lifecycle makes. `run: 'refused'`
// fails the start and creates nothing. `run: 'partial'` fails the start after creating the container, as a daemon
// can. `removeFails` makes removal fail for the names it selects. `inspectFails` makes inspection fail, with an
// error that is not Docker's absent-container answer, for the names it selects.
function fakeDocker(
  plan: {
    inspectFails?: (name: string) => boolean
    removeFails?: (name: string) => boolean
    run?: 'partial' | 'refused'
  } = {}
) {
  const present = new Set<string>()
  const calls: string[][] = []
  const docker = (args: string[]): DockerReply => {
    calls.push(args)
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1]!
      if (plan.run !== 'refused') present.add(name)
      if (plan.run)
        return { status: 125, stderr: `the daemon failed the start (${plan.run})`, stdout: '' }
      return { status: 0, stderr: '', stdout: `${name}\n` }
    }
    if (args[0] === 'container') {
      const name = args.at(-1)!
      if (plan.inspectFails?.(name))
        return {
          status: 1,
          stderr:
            'Error response from daemon: permission denied while trying to connect to the Docker daemon socket',
          stdout: '',
        }
      if (!present.has(name)) return { status: 1, stderr: `No such object: ${name}`, stdout: '' }
      return { status: 0, stderr: '', stdout: args.includes('--format') ? 'true\n' : '' }
    }
    if (args[0] === 'rm') {
      const name = args.at(-1)!
      if (plan.removeFails?.(name)) return { status: 1, stderr: 'permission denied', stdout: '' }
      if (present.delete(name)) return { status: 0, stderr: '', stdout: '' }
      return { status: 1, stderr: `No such container: ${name}`, stdout: '' }
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`)
  }
  return { calls, docker, present }
}

type ChildOptions = {
  // Raw stdout pieces, sent as they are. When absent, each line is sent with its newline.
  chunks?: string[]
  closeStdout?: boolean
  ignoresKill?: boolean
  ignoresTerm?: boolean
  onTerm?: () => void
}

// A child stand-in. It prints the lines it is given, then exits when the lifecycle signals it, unless the options
// say it ignores that signal. The signals it receives are recorded.
function fakeChild(lines: string[], options: ChildOptions = {}) {
  const signals: string[] = []
  const { promise: exited, resolve: exitNow } = Promise.withResolvers<number>()
  const child = {
    exitCode: null as number | null,
    exited,
    kill(signal: string) {
      signals.push(signal)
      if (signal === 'SIGTERM' && options.ignoresTerm) return
      if (signal === 'SIGKILL' && options.ignoresKill) return
      if (signal === 'SIGTERM') options.onTerm?.()
      child.signalCode = signal
      exitNow(0)
    },
    signalCode: null as string | null,
    signals,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const piece of options.chunks ?? lines.map((line) => `${line}\n`)) {
          controller.enqueue(encoder.encode(piece))
        }
        if (options.closeStdout) controller.close()
      },
    }),
  }
  return child
}

// Every message in a failure, with nested AggregateErrors flattened.
function messagesOf(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(messagesOf)
  return [error instanceof Error ? error.message : String(error)]
}

// The names cleanup asked Docker to remove, in order.
function removalsOf(calls: string[][]) {
  return calls.filter((args) => args[0] === 'rm').map((args) => args.at(-1))
}

// The sentinel name the lifecycle chose, read from its run call.
function sentinelOf(calls: string[][]) {
  const run = calls.find((args) => args[0] === 'run')!
  return run[run.indexOf('--name') + 1]!
}

// Runs the lifecycle with the fakes, and returns what it threw, or undefined when it returned.
function failureOf(overrides: Partial<Parameters<typeof runOwnedSmoke>[0]>) {
  return runOwnedSmoke({ bounds: fastBounds, childPath: '/not-used', ...overrides }).then(
    () => undefined,
    (error: unknown) => error
  )
}

describe('capture provisioning smoke lifecycle, fault paths', () => {
  test('a clean run observes the helper removing its own instance, then removes the sentinel', async () => {
    const fake = fakeDocker()
    const child = fakeChild([`OWNED ${owned}`, `READY ${owned} 1`], {
      onTerm: () => fake.present.delete(owned),
    })
    const observed = await runOwnedSmoke({
      bounds: fastBounds,
      childPath: '/not-used',
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return child
      },
    })
    expect(observed).toMatchObject({
      owned,
      removed: true,
      running: true,
      sentinelRunning: true,
      signal: 'SIGTERM',
    })
    expect(fake.present.size).toBe(0)
    expect(removalsOf(fake.calls)).toEqual([owned, observed.sentinel])
  })

  test('a refused sentinel start still attempts the sentinel removal, and no child is spawned', async () => {
    const fake = fakeDocker({ run: 'refused' })
    let spawned = false
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        spawned = true
        return fakeChild([])
      },
    })
    expect(messagesOf(error).join('\n')).toContain('starting the sentinel container failed')
    expect(spawned).toBe(false)
    expect(removalsOf(fake.calls)).toEqual([sentinelOf(fake.calls)])
  })

  test('a partial sentinel start leaves no container behind', async () => {
    const fake = fakeDocker({ run: 'partial' })
    const error = await failureOf({ docker: fake.docker, spawnChild: () => fakeChild([]) })
    expect(messagesOf(error).join('\n')).toContain('starting the sentinel container failed')
    expect(fake.present.size).toBe(0)
  })

  test('a failed child spawn still removes the sentinel', async () => {
    const fake = fakeDocker()
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        throw new Error('spawn ENOENT')
      },
    })
    expect(messagesOf(error)).toEqual(['spawn ENOENT'])
    expect(fake.present.size).toBe(0)
    expect(removalsOf(fake.calls)).toEqual([sentinelOf(fake.calls)])
  })

  test('a failed owned removal does not skip the sentinel removal', async () => {
    const fake = fakeDocker({ removeFails: (name) => name === owned })
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return fakeChild([`OWNED ${owned}`, `READY ${owned} 1`])
      },
    })
    const sentinel = sentinelOf(fake.calls)
    expect(messagesOf(error)).toEqual([`removing ${owned} failed: permission denied`])
    expect(removalsOf(fake.calls)).toEqual([owned, sentinel])
    expect(fake.present.has(sentinel)).toBe(false)
  })

  test('when both removals fail, both failures are kept', async () => {
    const fake = fakeDocker({ removeFails: () => true })
    const child = fakeChild([`OWNED ${owned}`, `READY ${owned} 1`], {
      onTerm: () => fake.present.delete(owned),
    })
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return child
      },
    })
    const sentinel = sentinelOf(fake.calls)
    expect(error).toBeInstanceOf(AggregateError)
    expect(messagesOf(error)).toEqual([
      `removing ${owned} failed: permission denied`,
      `removing ${sentinel} failed: permission denied`,
    ])
    expect(removalsOf(fake.calls)).toEqual([owned, sentinel])
  })

  test('a child that survives SIGTERM and SIGKILL is reported within the bounds, and both removals are attempted', async () => {
    const fake = fakeDocker()
    const child = fakeChild([`OWNED ${owned}`, `READY ${owned} 1`], {
      ignoresKill: true,
      ignoresTerm: true,
    })
    const started = Date.now()
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return child
      },
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    const messages = messagesOf(error).join('\n')
    expect(messages).toContain('the helper child after SIGTERM did not finish within 50 ms')
    expect(messages).toContain('the helper child after SIGKILL did not finish within 50 ms')
    expect(removalsOf(fake.calls)).toEqual([owned, sentinelOf(fake.calls)])
    expect(fake.present.size).toBe(0)
  })

  test('a child that only exits on SIGKILL is a failure, not a clean stop', async () => {
    const fake = fakeDocker()
    const child = fakeChild([`OWNED ${owned}`, `READY ${owned} 1`], { ignoresTerm: true })
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return child
      },
    })
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(messagesOf(error).join('\n')).toContain('the child was killed with SIGKILL')
    expect(removalsOf(fake.calls)).toEqual([owned, sentinelOf(fake.calls)])
    expect(fake.present.size).toBe(0)
  })

  test('a failure before readiness is kept next to a failed sentinel removal', async () => {
    const fake = fakeDocker({ removeFails: () => true })
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => fakeChild([], { closeStdout: true }),
    })
    const messages = messagesOf(error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('the helper child ended before OWNED')
    expect(messages[1]).toContain(`removing ${sentinelOf(fake.calls)} failed`)
  })

  test('a name split across stdout chunks is read only once its line is complete', async () => {
    // The first chunk ends inside the hexadecimal name. A prefix match would name the wrong container.
    const fake = fakeDocker()
    const child = fakeChild([], {
      chunks: [`OWNED ${owned.slice(0, 20)}`, `${owned.slice(20)}\n`, `READY ${owned} 1\n`],
      onTerm: () => fake.present.delete(owned),
    })
    const observed = await runOwnedSmoke({
      bounds: fastBounds,
      childPath: '/not-used',
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return child
      },
    })
    expect(observed).toMatchObject({ owned, removed: true, running: true, signal: 'SIGTERM' })
    expect(removalsOf(fake.calls)).toEqual([owned, observed.sentinel])
  })

  test('an inspect failure other than the absent-container answer is an error, not proof of removal', async () => {
    // The helper has stopped its instance, and then inspection of that instance fails for a reason other than
    // "no such container". The lifecycle must not read that as removed.
    let stopped = false
    const fake = fakeDocker({ inspectFails: (name) => name === owned && stopped })
    const child = fakeChild([`OWNED ${owned}`, `READY ${owned} 1`], {
      onTerm: () => {
        stopped = true
        fake.present.delete(owned)
      },
    })
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return child
      },
    })
    expect(messagesOf(error)).toEqual([
      `inspecting ${owned} failed: Error response from daemon: permission denied while trying to connect to the Docker daemon socket`,
    ])
    expect(removalsOf(fake.calls)).toEqual([owned, sentinelOf(fake.calls)])
  })
})
