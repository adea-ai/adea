// The lifecycle of the real-Docker capture provisioning smoke test: one sentinel container, one helper child, a
// SIGTERM, and the cleanup that goes with them. The sentinel name is fixed before the first side effect, and the
// cleanup scope covers every path after that, including a refused or partial sentinel start and a failed spawn.
// The child and the helper's instance are optional until they exist. Cleanup touches only the sentinel, the child
// this module spawned, and the instance that child named. Both removals are attempted even when an earlier step
// fails, and every failure is kept in the error that is thrown. Every wait is bounded.
//
// Docker and the child are injectable, so the failure paths run without Docker in the unit lane.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { captureProvisioningImage } from '../capture-provisioning.mjs'

export const smokeBounds = Object.freeze({
  dockerCommandMs: 60_000,
  startSentinelMs: 180_000,
  ownedMs: 60_000,
  readyMs: 200_000,
  stopAfterTermMs: 60_000,
  stopAfterKillMs: 30_000,
  removeMs: 60_000,
})

const ownedPattern = /OWNED (adea-capture-prov-[0-9a-f]+)/
const readyPattern = /READY (adea-capture-prov-[0-9a-f]+) 1/

// The default Docker command. It is killed with SIGKILL on timeout, so the bound holds only if the killed client exits.
export function dockerCommand(args, timeoutMs) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
}

// The default child. Its stderr is inherited, so its failures appear in the run output.
export function spawnHelperChild(childPath) {
  return Bun.spawn([process.execPath, childPath], { stderr: 'inherit', stdout: 'pipe' })
}

// Rejects when the work outlives its bound. The timer is cleared either way, so a finished wait keeps nothing alive.
async function within(work, ms, what) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

// Reads one child's stdout in order, so the OWNED and READY lines come from the same stream.
function lineReader(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  return async (label, pattern) => {
    for (;;) {
      const match = pending.match(pattern)
      if (match) {
        pending = pending.slice(match.index + match[0].length)
        return match
      }
      const { value, done } = await reader.read()
      if (done) throw new Error(`the helper child ended before ${label}: ${pending}`)
      pending += decoder.decode(value, { stream: true })
    }
  }
}

// Stops the child this module spawned, and nothing else. SIGTERM lets the helper remove its own instance. A child
// that has not exited within the bound is killed with SIGKILL, and that is a failure, because the helper cannot
// remove its instance after SIGKILL. The wait after SIGKILL is bounded too.
async function stopChild(child, bounds) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await within(child.exited, bounds.stopAfterTermMs, 'the helper child after SIGTERM')
  } catch (termError) {
    child.kill('SIGKILL')
    try {
      await within(child.exited, bounds.stopAfterKillMs, 'the helper child after SIGKILL')
    } catch (killError) {
      throw new AggregateError(
        [termError, killError],
        'the helper child did not exit, even after SIGKILL',
        { cause: killError }
      )
    }
    throw new Error(`${termError.message}; the child was killed with SIGKILL`, { cause: termError })
  }
}

// Runs the lifecycle and returns what it observed. It throws the failure when the run fails, and throws the failure
// together with every cleanup error when cleanup fails too.
export async function runOwnedSmoke({
  childPath,
  docker = dockerCommand,
  spawnChild = spawnHelperChild,
  bounds = smokeBounds,
} = {}) {
  const sentinel = `adea-capture-prov-${randomBytes(6).toString('hex')}`
  const observed = { sentinel }
  const cleanupErrors = []
  let child
  let childStopAttempted = false
  let ownedName
  let failure

  const inspect = (args) => {
    const result = docker(['container', 'inspect', ...args], bounds.dockerCommandMs)
    if (result.error) throw new Error(`inspecting ${args.at(-1)} failed: ${result.error.message}`)
    return result
  }
  const isRunning = (name) => {
    const result = inspect(['--format', '{{.State.Running}}', name])
    return result.status === 0 && result.stdout.trim() === 'true'
  }
  const exists = (name) => inspect([name]).status === 0
  const removeNamed = (name) => {
    const result = docker(['rm', '-f', name], bounds.removeMs)
    if (result.error) throw new Error(`removing ${name} failed: ${result.error.message}`)
    if (result.status === 0 || result.stderr.includes('No such container')) return
    throw new Error(
      `removing ${name} failed: ${result.stderr.trim() || `exit code ${result.status}`}`
    )
  }
  const startSentinel = () => {
    const result = docker(
      ['run', '-d', '--name', sentinel, '--entrypoint', 'sleep', captureProvisioningImage, '600'],
      bounds.startSentinelMs
    )
    if (result.error)
      throw new Error(`starting the sentinel container failed: ${result.error.message}`)
    if (result.status !== 0) {
      throw new Error(
        `starting the sentinel container failed: ${result.stderr.trim() || `exit code ${result.status}`}`
      )
    }
  }

  try {
    startSentinel()
    child = spawnChild(childPath)
    const lines = lineReader(child.stdout)
    ownedName = (
      await within(
        lines('OWNED', ownedPattern),
        bounds.ownedMs,
        'the helper child naming its instance'
      )
    )[1]
    observed.owned = ownedName
    const ready = (
      await within(lines('READY', readyPattern), bounds.readyMs, 'the helper child becoming ready')
    )[1]
    if (ready !== ownedName)
      throw new Error(`the helper child named ${ownedName} and then reported ${ready}`)
    observed.running = isRunning(ownedName)
    childStopAttempted = true
    await stopChild(child, bounds)
    observed.signal = child.signalCode
    observed.removed = !exists(ownedName)
    observed.sentinelRunning = isRunning(sentinel)
  } catch (error) {
    failure = error
  } finally {
    // The child goes first, so the helper can remove its own instance on SIGTERM. Then both removals run, even
    // when an earlier step failed, and each failure is kept.
    if (child !== undefined && !childStopAttempted) {
      try {
        await stopChild(child, bounds)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (ownedName !== undefined) {
      try {
        removeNamed(ownedName)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      removeNamed(sentinel)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (failure === undefined && cleanupErrors.length === 0) return observed
  if (cleanupErrors.length === 0) throw failure
  if (failure === undefined)
    throw new AggregateError(cleanupErrors, 'capture provisioning smoke cleanup failed')
  throw new AggregateError(
    [failure, ...cleanupErrors],
    'capture provisioning smoke failed, and its cleanup failed too'
  )
}
