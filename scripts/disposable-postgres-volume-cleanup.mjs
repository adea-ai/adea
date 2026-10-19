// The owned-resource teardown of the disposable PostgreSQL volume proof.
//
// It is deliberately separate from the proof body so it can be exercised
// without a Docker daemon: the command runner is injected, and every outcome
// is aggregated. One failed removal never hides the others, a removal that
// cannot be confirmed never counts as absent, and a failed teardown never
// leaves the proof green.
//
// The teardown is scoped to the resources the proof created. It never prunes,
// never removes every container, and never names a resource it did not track.

/** The outcome of reading one resource's state. */
export const RESOURCE_STATE = {
  present: 'present',
  absent: 'absent',
  unknown: 'unknown',
}

/** A container Docker reports as absent. */
const ABSENT_CONTAINER = /no such (object|container)/iu

/** A volume Docker reports as absent. */
const ABSENT_VOLUME = /no such volume/iu

/**
 * Runs one command with a bounded lifetime.
 *
 * A child that outlives its bound is killed, and the result says so, so a
 * hung Docker call can never be mistaken for a completed one.
 */
export function runBounded(
  command,
  args,
  { spawnSync, timeoutMs = 120_000, killSignal = 'SIGKILL' } = {}
) {
  if (typeof spawnSync !== 'function') {
    throw new Error('the bounded runner needs a spawn implementation')
  }
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    killSignal,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
  const error = result?.error
  return {
    status: result?.status ?? 1,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? (error ? error.message : ''),
    timedOut: error?.code === 'ETIMEDOUT' || result?.signal === killSignal,
  }
}

/**
 * Reads one resource's state.
 *
 * A confirmed not-found is a state; a failed read is not. A Docker call that
 * could not reach the daemon, or answered something else, leaves the state
 * unknown, and an unknown state is never treated as absent.
 */
export function classifyResource(result, absentPattern) {
  if (result.status === 0) return RESOURCE_STATE.present
  if (absentPattern.test(result.stderr ?? '')) return RESOURCE_STATE.absent
  return RESOURCE_STATE.unknown
}

/** The state of one owned container. */
export function classifyContainer(run, name) {
  return classifyResource(run(['inspect', name]), ABSENT_CONTAINER)
}

/** The state of one owned volume. */
export function classifyVolume(run, name) {
  return classifyResource(run(['volume', 'inspect', name]), ABSENT_VOLUME)
}

/**
 * Removes every owned resource and proves that it is gone.
 *
 * Every owned container and every owned volume is attempted, even when an
 * earlier attempt failed, so one failure cannot strand the rest. The volume
 * names are the ones tracked before anything was deleted, so a container that
 * is already gone does not take its volume's identity with it.
 *
 * The result carries the failures rather than throwing, so the caller can
 * decide how to report them; an empty `errors` list means every owned
 * resource was confirmed absent afterwards.
 */
export function cleanupOwnedResources({ containers = [], volumes = [], removeContainer, run }) {
  const errors = []
  const removed = []
  const absent = []

  for (const name of containers) {
    const state = classifyContainer(run, name)
    if (state === RESOURCE_STATE.absent) {
      absent.push(name)
      continue
    }
    if (state === RESOURCE_STATE.unknown) {
      errors.push(`the state of the owned container ${name} could not be read`)
      continue
    }
    const result = run(removeContainer(name))
    if (result.timedOut) {
      errors.push(`removing the owned container ${name} timed out`)
      continue
    }
    if (result.status !== 0) {
      errors.push(`removing the owned container ${name} failed with exit code ${result.status}`)
      continue
    }
    removed.push(name)
  }

  for (const volume of volumes) {
    const state = classifyVolume(run, volume)
    if (state === RESOURCE_STATE.absent) {
      absent.push(volume)
      continue
    }
    if (state === RESOURCE_STATE.unknown) {
      errors.push(`the state of the owned volume ${volume} could not be read`)
      continue
    }
    const result = run(['volume', 'rm', volume])
    if (result.timedOut) {
      errors.push(`removing the owned volume ${volume} timed out`)
      continue
    }
    if (result.status !== 0) {
      errors.push(`removing the owned volume ${volume} failed with exit code ${result.status}`)
      continue
    }
    removed.push(volume)
  }

  // The teardown is only complete when every owned resource is confirmed gone.
  const remaining = []
  for (const name of containers) {
    if (classifyContainer(run, name) !== RESOURCE_STATE.absent) remaining.push(name)
  }
  for (const volume of volumes) {
    if (classifyVolume(run, volume) !== RESOURCE_STATE.absent) remaining.push(volume)
  }
  if (remaining.length > 0) {
    errors.push(`owned resources are still present: ${remaining.join(', ')}`)
  }

  return { absent, errors, remaining, removed }
}
