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
    // Throttles the pull of the canonical ECR Public reference the way a shared-runner registry does.
    throttleEcr?: boolean
    // With throttleEcr, also fails the mirror with an unrelated error so only Docker Hub answers.
    failMirror?: boolean
    // Throttles every registry, so the start can only end by running out of its budget.
    throttleAll?: boolean
    // Fails the inspection of one volume, the way a daemon that refuses answers.
    volumeInspectFails?: (volume: string) => boolean
    // Times the inspection of one volume out, the way a client that never answers does.
    volumeInspectTimesOut?: (volume: string) => boolean
    // Fails the removal of one volume, the way a volume that is still in use answers.
    volumeRmFails?: (volume: string) => boolean
  } = {}
) {
  const present = new Set<string>()
  // The volumes Docker created for each container, the way the pinned image's declared data
  // directory appears: one anonymous volume per container.
  const volumes = new Map<string, string>()
  const calls: string[][] = []
  const timeouts: number[] = []
  const docker = (args: string[], timeoutMs?: number): DockerReply => {
    calls.push(args)
    if (args[0] === 'run') {
      timeouts.push(timeoutMs ?? Number.POSITIVE_INFINITY)
      const name = args[args.indexOf('--name') + 1]!
      if (plan.throttleAll)
        return {
          status: 125,
          stderr: 'docker: Error response from daemon: toomanyrequests: Data limit exceeded',
          stdout: '',
        }
      if (
        plan.throttleEcr &&
        args.includes('--entrypoint') &&
        args.at(-2)!.startsWith('public.ecr.aws/')
      )
        return {
          status: 125,
          stderr: 'docker: Error response from daemon: toomanyrequests: Data limit exceeded',
          stdout: '',
        }
      if (
        plan.throttleEcr &&
        plan.failMirror &&
        args.includes('--entrypoint') &&
        args.at(-2)!.startsWith('mirror.gcr.io/')
      )
        return {
          status: 125,
          stderr: 'docker: Error response from daemon: manifest unknown',
          stdout: '',
        }
      if (plan.run !== 'refused') {
        present.add(name)
        volumes.set(`volume-${name}`, name)
      }
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
      const format = args[args.indexOf('--format') + 1]
      if (format === '{{json .Mounts}}') {
        // Every container of the pinned image carries the anonymous data volume,
        // including one the test put there itself.
        if (!volumes.has(`volume-${name}`)) volumes.set(`volume-${name}`, name)
        const mounts = [...volumes.entries()]
          .filter(([, owner]) => owner === name)
          .map(([volume]) => ({
            Type: 'volume',
            Name: volume,
            Destination: '/var/lib/postgresql',
          }))
        return { status: 0, stderr: '', stdout: `${JSON.stringify(mounts)}\n` }
      }
      return { status: 0, stderr: '', stdout: args.includes('--format') ? 'true\n' : '' }
    }
    if (args[0] === 'volume') {
      const name = args.at(-1)!
      if (args[1] === 'inspect') {
        if (plan.volumeInspectTimesOut?.(name))
          return {
            error: new Error('spawnSync docker ETIMEDOUT'),
            status: null,
            stderr: '',
            stdout: '',
          }
        if (plan.volumeInspectFails?.(name))
          return { status: 1, stderr: 'permission denied', stdout: '' }
        if (!volumes.has(name)) return { status: 1, stderr: `no such volume: ${name}`, stdout: '' }
        return { status: 0, stderr: '', stdout: '' }
      }
      if (args[1] === 'rm') {
        if (plan.volumeRmFails?.(name))
          return {
            status: 1,
            stderr: `Error response from daemon: volume is in use - [volume ${name}]`,
            stdout: '',
          }
        volumes.delete(name)
        return { status: 0, stderr: '', stdout: name }
      }
      throw new Error(`unexpected docker call: ${args.join(' ')}`)
    }
    if (args[0] === 'rm') {
      const name = args.at(-1)!
      if (plan.removeFails?.(name)) return { status: 1, stderr: 'permission denied', stdout: '' }
      if (present.delete(name)) return { status: 0, stderr: '', stdout: '' }
      return { status: 1, stderr: `No such container: ${name}`, stdout: '' }
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`)
  }
  return { calls, docker, present, timeouts, volumes }
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

  test('a rate-limited sentinel pull falls over to the same digest on the mirror', async () => {
    const fake = fakeDocker({ throttleEcr: true })
    const child = fakeChild([`OWNED ${owned}`, `READY ${owned} 1`], {
      onTerm: () => fake.present.delete(owned),
    })
    await runOwnedSmoke({
      bounds: fastBounds,
      childPath: '/not-used',
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return child
      },
    })
    const images = fake.calls.filter((args) => args[0] === 'run').map((args) => args.at(-2))
    expect(images).toHaveLength(2)
    expect(images[0]).toStartWith('public.ecr.aws/docker/library/postgres:18-alpine@sha256:')
    expect(images[1]).toStartWith('mirror.gcr.io/library/postgres:18-alpine@sha256:')
    expect(images[1]!.split('@')[1]).toBe(images[0]!.split('@')[1])
  })

  test('a failing mirror does not hide Docker Hub for the sentinel', async () => {
    const fake = fakeDocker({ throttleEcr: true, failMirror: true })
    const child = fakeChild([`OWNED ${owned}`, `READY ${owned} 1`], {
      onTerm: () => fake.present.delete(owned),
    })
    await runOwnedSmoke({
      bounds: fastBounds,
      childPath: '/not-used',
      docker: fake.docker,
      spawnChild: () => {
        fake.present.add(owned)
        return child
      },
    })
    const images = fake.calls.filter((args) => args[0] === 'run').map((args) => args.at(-2))
    expect(images).toHaveLength(3)
    expect(images[2]).toStartWith('docker.io/library/postgres:18-alpine@sha256:')
  })

  test('a throttled sentinel start stays inside its budget and still removes the sentinel', async () => {
    const fake = fakeDocker({ throttleAll: true })
    const startedAt = Date.now()
    const failure = await failureOf({
      bounds: { ...fastBounds, startSentinelMs: 1_000 },
      docker: fake.docker,
      spawnChild: () => {
        throw new Error('no child is spawned when the sentinel does not start')
      },
    })
    expect(String(failure)).toContain('starting the sentinel container failed')
    // The default 15 s backoff does not fit in a 1 s budget, so there is no wait and no further pass.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(fake.timeouts.length).toBeGreaterThan(0)
    expect(fake.timeouts.every((ms) => ms <= 1_000)).toBe(true)
    expect(removalsOf(fake.calls)).toEqual([sentinelOf(fake.calls)])
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

  test('a child that never becomes ready still takes the sentinel volume with it', async () => {
    const fake = fakeDocker()
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => fakeChild([`OWNED ${owned}`], { closeStdout: true }),
    })
    expect(messagesOf(error).join('\n')).toContain('the helper child ended before READY')
    const sentinel = sentinelOf(fake.calls)
    // The sentinel's own volume is removed, because its identity was captured when it was created.
    const volumeRemovals = fake.calls
      .filter((args) => args[0] === 'volume' && args[1] === 'rm')
      .map((args) => args.at(-1))
    expect(volumeRemovals).toContain(`volume-${sentinel}`)
    expect(fake.volumes.size).toBe(0)
    expect(fake.present.size).toBe(0)
  })

  test('a child that fails to start still takes the sentinel volume with it', async () => {
    const fake = fakeDocker()
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        throw new Error('spawn ENOENT')
      },
    })
    expect(messagesOf(error)).toEqual(['spawn ENOENT'])
    const sentinel = sentinelOf(fake.calls)
    const volumeRemovals = fake.calls
      .filter((args) => args[0] === 'volume' && args[1] === 'rm')
      .map((args) => args.at(-1))
    expect(volumeRemovals).toContain(`volume-${sentinel}`)
    expect(fake.volumes.size).toBe(0)
  })

  test('a failed volume deletion is retained, retried, and reported when it fails again', async () => {
    const fake = fakeDocker({ volumeRmFails: () => true })
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
    const volumeRemovals = fake.calls
      .filter((args) => args[0] === 'volume' && args[1] === 'rm')
      .map((args) => args.at(-1))
    // The identity of a volume that could not be removed is retained and retried.
    expect(volumeRemovals.filter((name) => name === `volume-${sentinel}`)).toHaveLength(2)
    expect(messagesOf(error).join('\n')).toContain(`removing the volume volume-${sentinel} failed`)
    // A named volume is never removed, and nothing outside the tracked ones is touched.
    expect(volumeRemovals.every((name) => name?.startsWith('volume-'))).toBe(true)
  })

  test('a child that never becomes ready still takes the owned volume with it', async () => {
    const fake = fakeDocker()
    const error = await failureOf({
      docker: fake.docker,
      spawnChild: () => {
        // The helper's own instance, with the anonymous volume Docker gives it.
        fake.present.add(owned)
        return fakeChild([`OWNED ${owned}`], { closeStdout: true })
      },
    })
    expect(messagesOf(error).join('\n')).toContain('the helper child ended before READY')
    const volumeRemovals = fake.calls
      .filter((args) => args[0] === 'volume' && args[1] === 'rm')
      .map((args) => args.at(-1))
    // The owned volume's identity is recovered before the child is stopped, so
    // the volume is removed even though the child never became ready.
    expect(volumeRemovals).toContain(`volume-${owned}`)
    expect(fake.volumes.size).toBe(0)
    expect(fake.present.size).toBe(0)
  })

  test('a partial sentinel start still takes the sentinel volume with it', async () => {
    const fake = fakeDocker({ run: 'partial' })
    const error = await failureOf({ docker: fake.docker, spawnChild: () => fakeChild([]) })
    expect(messagesOf(error).join('\n')).toContain('starting the sentinel container failed')
    const sentinel = sentinelOf(fake.calls)
    const volumeRemovals = fake.calls
      .filter((args) => args[0] === 'volume' && args[1] === 'rm')
      .map((args) => args.at(-1))
    // A start that fails after the container was created leaves it and its
    // volume behind, and the cleanup takes both.
    expect(volumeRemovals).toContain(`volume-${sentinel}`)
    expect(fake.volumes.size).toBe(0)
    expect(fake.present.size).toBe(0)
  })

  test('a volume inspection that times out is not an absence', async () => {
    const fake = fakeDocker({ volumeInspectTimesOut: () => true })
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
    // The volume could not be inspected, so it is never reported as gone.
    expect(messagesOf(error).join('\n')).toContain('inspecting the volume')
    expect(messagesOf(error).join('\n')).toContain('ETIMEDOUT')
  })

  test('a volume inspection that is refused is not an absence', async () => {
    const fake = fakeDocker({ volumeInspectFails: () => true })
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
    expect(messagesOf(error).join('\n')).toContain(
      `inspecting the volume volume-${owned} failed: permission denied`
    )
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
      // The volumes of that container could not be read either, and an unreadable inspection is a
      // failure, never an empty list.
      `inspecting the volumes of ${owned} failed: Error response from daemon: permission denied while trying to connect to the Docker daemon socket`,
    ])
    expect(removalsOf(fake.calls)).toEqual([owned, sentinelOf(fake.calls)])
  })
})
