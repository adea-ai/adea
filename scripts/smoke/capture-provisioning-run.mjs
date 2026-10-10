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

// The helper names its instance with a fixed prefix and twelve hex digits. A line counts only when it matches whole,
// so a name is never read from part of a line.
const ownedLine = /^OWNED (adea-capture-prov-[0-9a-f]{12})$/
const readyLine = /^READY (adea-capture-prov-[0-9a-f]{12}) 1$/

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

// Reads one child's stdout as complete lines. A line is complete only once its newline has arrived, so a name split
// across chunks is never matched in part. The text after the last newline waits for the next chunk.
function lineReader(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let fragment = ''
  const lines = []
  return async (label, pattern) => {
    for (;;) {
      const index = lines.findIndex((line) => pattern.test(line))
      if (index !== -1) {
        const consumed = lines.splice(0, index + 1)
        return consumed[index].match(pattern)
      }
      const { value, done } = await reader.read()
      if (done) {
        throw new Error(
          `the helper child ended before ${label}: ${[...lines, fragment].join('\n')}`
        )
      }
      fragment += decoder.decode(value, { stream: true })
      const parts = fragment.split('\n')
      fragment = parts.pop()
      lines.push(...parts)
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

// Docker's answer for a container that does not exist, naming that container. Only this answer proves absence. Any
// other failure, including a nonzero exit without this message, is an error.
function absentAnswer(result, name) {
  return (
    result.status !== 0 &&
    (result.stderr.includes(`No such container: ${name}`) ||
      result.stderr.includes(`No such object: ${name}`))
  )
}

// What a Docker command that did not succeed reported.
function failureText(result) {
  return (
    result.stderr.trim() ||
    (result.signal ? `ended by ${result.signal}` : `exit code ${result.status}`)
  )
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

  // Inspection finds the container present, finds it absent, or fails. Only Docker's absent-container answer for this
  // name counts as absent. Every other failure throws, so a failing Docker can never pass for a removed container.
  const inspect = (name, format) => {
    const args = format === undefined ? [name] : ['--format', format, name]
    const result = docker(['container', 'inspect', ...args], bounds.dockerCommandMs)
    if (result.error) throw new Error(`inspecting ${name} failed: ${result.error.message}`)
    if (result.status === 0) return { present: true, stdout: result.stdout }
    if (absentAnswer(result, name)) return { present: false, stdout: '' }
    throw new Error(`inspecting ${name} failed: ${failureText(result)}`)
  }
  const isRunning = (name) => {
    const state = inspect(name, '{{.State.Running}}')
    return state.present && state.stdout.trim() === 'true'
  }
  const exists = (name) => inspect(name).present
  const removeNamed = (name) => {
    const result = docker(['rm', '-f', name], bounds.removeMs)
    if (result.error) throw new Error(`removing ${name} failed: ${result.error.message}`)
    if (result.status === 0 || absentAnswer(result, name)) return
    throw new Error(`removing ${name} failed: ${failureText(result)}`)
  }
  const startSentinel = () => {
    const result = docker(
      ['run', '-d', '--name', sentinel, '--entrypoint', 'sleep', captureProvisioningImage, '600'],
      bounds.startSentinelMs
    )
    if (result.error)
      throw new Error(`starting the sentinel container failed: ${result.error.message}`)
    if (result.status !== 0) {
      throw new Error(`starting the sentinel container failed: ${failureText(result)}`)
    }
  }

  try {
    startSentinel()
    child = spawnChild(childPath)
    const lines = lineReader(child.stdout)
    ownedName = (
      await within(
        lines('OWNED', ownedLine),
        bounds.ownedMs,
        'the helper child naming its instance'
      )
    )[1]
    observed.owned = ownedName
    const ready = (
      await within(lines('READY', readyLine), bounds.readyMs, 'the helper child becoming ready')
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
