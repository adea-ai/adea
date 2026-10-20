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

import { startFromCaptureImage } from '../capture-provisioning.mjs'

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
function absentAnswer(result, _name) {
  // Docker's own answer for a name that is not there, in either spelling it uses.
  return result.status !== 0 && /no such (object|container)/iu.test(result.stderr)
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
  const observed = { sentinel, ownedVolumes: [], sentinelVolumes: [], pendingVolumes: [] }
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
  // The volumes Docker created for one container. The pinned image declares its data directory as a volume, so
  // every container carries one anonymous volume. They are read from that container's own mounts, so a container
  // that is already gone contributes nothing and takes no volume's identity with it.
  //
  // An inspection that cannot be trusted is a failure, never an empty list: a container whose volumes could not
  // be read has unknown volumes, and unknown volumes are never removed on a guess.
  const containerVolumes = (name) => {
    const result = docker(
      ['container', 'inspect', '--format', '{{json .Mounts}}', name],
      bounds.dockerCommandMs
    )
    if (result.error)
      throw new Error(`inspecting the volumes of ${name} failed: ${result.error.message}`)
    if (result.status !== 0) {
      // Only Docker's own answer for this name proves that the container is gone.
      if (absentAnswer(result, name)) return []
      throw new Error(`inspecting the volumes of ${name} failed: ${failureText(result)}`)
    }
    let mounts
    try {
      mounts = JSON.parse(result.stdout)
    } catch {
      throw new Error(`inspecting the volumes of ${name} failed: the answer was unreadable`)
    }
    if (!Array.isArray(mounts))
      throw new Error(`inspecting the volumes of ${name} failed: the answer was unreadable`)
    return mounts
      .filter((mount) => mount?.Type === 'volume' && typeof mount?.Name === 'string' && mount.Name)
      .map((mount) => mount.Name)
  }
  // What a volume inspection answered: the volume is there, Docker confirmed it
  // is gone, or the answer could not be trusted. Only the second is an absence.
  const inspectVolume = (volume) => {
    const result = docker(['volume', 'inspect', volume], bounds.dockerCommandMs)
    if (result.error) return { state: 'unreadable', reason: result.error.message }
    if (result.status === 0) return { state: 'present' }
    if (/no such volume/iu.test(result.stderr)) return { state: 'absent' }
    return { state: 'unreadable', reason: failureText(result) }
  }
  // Whether every tracked volume is confirmed gone. An inspection that could not
  // be trusted fails the run: an unknown volume is never an absent one.
  const volumesConfirmedGone = (volumes) => {
    const failures = []
    let gone = true
    for (const volume of volumes) {
      const inspection = inspectVolume(volume)
      if (inspection.state === 'absent') continue
      if (inspection.state === 'present') {
        gone = false
        continue
      }
      failures.push(new Error(`inspecting the volume ${volume} failed: ${inspection.reason}`))
    }
    if (failures.length > 0) throw failures[0]
    return gone
  }
  // Recovers the volumes of one container before anything removes it.
  //
  // A container that is not there contributes nothing, and a known identity is
  // never replaced by an empty list. An inspection that cannot be trusted is a
  // failure: an unknown volume is never an absent one.
  const recoverVolumes = (name, known) => {
    try {
      const volumes = containerVolumes(name)
      if (volumes.length > 0) known.push(...volumes.filter((volume) => !known.includes(volume)))
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  // Whether every tracked volume is confirmed still there. An inspection that
  // could not be trusted fails the run, the same way.
  const volumesConfirmedPresent = (volumes) => {
    const failures = []
    let present = true
    for (const volume of volumes) {
      const inspection = inspectVolume(volume)
      if (inspection.state === 'present') continue
      if (inspection.state === 'absent') {
        present = false
        continue
      }
      failures.push(new Error(`inspecting the volume ${volume} failed: ${inspection.reason}`))
    }
    if (failures.length > 0) throw failures[0]
    return present
  }
  // Removes one volume this lifecycle owns, by its exact name. A volume Docker already removed is gone.
  const removeVolume = (volume) => {
    const result = docker(['volume', 'rm', volume], bounds.removeMs)
    if (result.error)
      throw new Error(`removing the volume ${volume} failed: ${result.error.message}`)
    if (result.status === 0) return
    if (/no such volume/iu.test(result.stderr)) return
    throw new Error(`removing the volume ${volume} failed: ${failureText(result)}`)
  }
  const removeNamed = (name) => {
    const result = docker(['rm', '-f', name], bounds.removeMs)
    if (result.error) throw new Error(`removing ${name} failed: ${result.error.message}`)
    if (result.status === 0 || absentAnswer(result, name)) return
    throw new Error(`removing ${name} failed: ${failureText(result)}`)
  }
  const startSentinel = () => {
    // The sentinel pulls the same pinned image as the helper, so it takes the same registry fallback.
    const result = startFromCaptureImage(
      (image, remainingMs) =>
        docker(
          ['run', '-d', '--name', sentinel, '--entrypoint', 'sleep', image, '600'],
          Math.max(1, Math.min(bounds.startSentinelMs, remainingMs))
        ),
      { budgetMs: bounds.startSentinelMs }
    )
    if (result.error)
      throw new Error(`starting the sentinel container failed: ${result.error.message}`)
    if (result.status !== 0) {
      // A start that fails after the container was created leaves that container and its
      // volume behind, so the provenance is recovered before the cleanup removes it.
      recoverVolumes(sentinel, observed.sentinelVolumes)
      throw new Error(`starting the sentinel container failed: ${failureText(result)}`)
    }
    // The sentinel's own volumes are captured the moment it exists, so an early failure in the child
    // still leaves the cleanup with the identity it has to remove.
    observed.sentinelVolumes = containerVolumes(sentinel)
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
    // The owned container's volumes are read while it still exists, so its identity is known before
    // anything stops or removes it.
    observed.ownedVolumes = containerVolumes(ownedName)
    childStopAttempted = true
    await stopChild(child, bounds)
    observed.signal = child.signalCode
    observed.removed = !exists(ownedName)
    // The helper took its own container's anonymous volume with it, and left the sentinel's volume alone.
    observed.ownedVolumeRemoved = volumesConfirmedGone(observed.ownedVolumes)
    observed.sentinelVolumeKept = volumesConfirmedPresent(observed.sentinelVolumes)
    observed.sentinelRunning = isRunning(sentinel)
  } catch (error) {
    failure = error
  } finally {
    // The owned container's volumes are recovered before the child is stopped, because the
    // child removes its own instance on SIGTERM and the identity would be lost with it.
    if (ownedName !== undefined) recoverVolumes(ownedName, observed.ownedVolumes)
    // The sentinel's volumes are recovered before the sentinel is removed, the same way.
    recoverVolumes(sentinel, observed.sentinelVolumes)
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
      // The owned container's volumes were recovered before the child was stopped, so the
      // identity it owned is known here even when the child removed it.
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
    // The volumes of both containers are this lifecycle's own, so it removes them by the identity it tracked.
    const volumes = [
      ...new Set([...(observed.ownedVolumes ?? []), ...(observed.sentinelVolumes ?? [])]),
    ]
    for (const volume of volumes) {
      try {
        removeVolume(volume)
      } catch (error) {
        cleanupErrors.push(error)
        // The identity is retained, so a later attempt takes it.
        observed.pendingVolumes.push(volume)
      }
    }
    // A volume that could not be removed is retried once, and it stays pending when it still fails.
    const stillPending = []
    for (const volume of observed.pendingVolumes) {
      try {
        removeVolume(volume)
      } catch (error) {
        cleanupErrors.push(error)
        stillPending.push(volume)
      }
    }
    observed.pendingVolumes = stillPending
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
