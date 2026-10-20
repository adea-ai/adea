import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  defaultPullBackoffMs,
  fallbackImages,
  isRegistryRateLimit,
} from './docker-pull-backoff.mjs'

// The migration-snapshot capture proofs build a disposable PostgreSQL scratch
// database per run: a capture inventories the whole app schema and the
// comparator refuses unbounded shared state. Creating and dropping that
// database needs CREATEDB, which the provisioned application roles
// deliberately do not have (the database health gate enforces it), so the
// instance the proofs run against is test infrastructure: a throwaway
// postgres container dedicated to this run, provisioned here and always
// removed afterwards. It is independent of DATABASE_URL — its admin URL is
// exported as MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL, the capture file
// refuses to run without it, and no destructive step in this lane ever
// targets the database DATABASE_URL names. A superuser inside an ephemeral,
// randomly-passworded container that exists only for this run is the point;
// widening an application role to make room for a test would not be.
//
// The canonical integration lane (scripts/test-integration.mjs) and the
// package runner (scripts/run-with-capture-provisioning.mjs) both start the
// instance through this module, so every route to the capture proofs and the
// clean-destination restore tests gets the same instance and the same cleanup.
export const captureProvisioningDatabaseUrlVariable = 'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL'
export const captureProvisioningImage =
  'public.ecr.aws/docker/library/postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'

// The signals that end a run early. Removal of the instance runs on these, on a
// normal exit and on an error exit, and only for the container this module
// created.
const interruptSignals = ['SIGINT', 'SIGTERM']

// The longest the whole capture image start may take, every registry attempt and every wait included.
// It sits inside the smoke lane's readiness bound, which also covers the readiness probe after the start.
export const captureStartBudgetMs = 120_000

// Bounds one removal, so a stuck Docker daemon cannot hold the caller, or a heavy-validation slot, forever.
const defaultRemovalTimeoutMs = 30_000

export function dockerDaemonAvailable() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return !result.error && result.status === 0
}

// Synchronous sleep; the runner is single-threaded and the next step needs the instance healthy.
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export function dockerCaptureRun(args, what, timeoutMs) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${what} failed: ${result.stderr.trim() || `exit code ${result.status}`}`)
  }
  return result.stdout.trim()
}

// What an inspection answered.
//
// The three answers are kept apart. Only the second one is an absence. An
// answer that could not be read is never read as "there is nothing there",
// because an uncertain inspection must never be reported as a clean cleanup.
const INSPECTED = 'inspected'
const ABSENT = 'absent'
const UNREADABLE = 'unreadable'

// The bound on one inspection, and on one removal.
const defaultInspectionTimeoutMs = 10_000
const volumeRemovalTimeoutMs = 30_000

// Docker's own answers for an object that is not there. The spelling differs between the commands and
// between the versions, so the answer is matched the way the repository matches it elsewhere.
const ABSENT_CONTAINER = /no such (object|container)/iu
const ABSENT_VOLUME = /no such volume/iu

// Reads the mounts of one container.
//
// Docker answers with the mounts of a container that exists, with "No such
// object" for one that does not, and with a failure, a timeout or unreadable
// output when the answer could not be trusted. The last group is never an
// absence.
function inspectContainerMounts(name, timeoutMs) {
  const result = spawnSync('docker', ['inspect', '--format', '{{json .Mounts}}', name], {
    encoding: 'utf8',
    // SIGKILL, because the bound holds only if the killed client exits.
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
  if (result.error?.code === 'ETIMEDOUT')
    return { state: UNREADABLE, reason: 'the inspection timed out' }
  if (result.error) return { state: UNREADABLE, reason: 'the inspection failed' }
  if (result.status === 0) {
    let mounts
    try {
      mounts = JSON.parse(result.stdout)
    } catch {
      return { state: UNREADABLE, reason: 'the inspection returned unreadable output' }
    }
    if (!Array.isArray(mounts)) {
      return { state: UNREADABLE, reason: 'the inspection returned unreadable output' }
    }
    return { state: INSPECTED, mounts }
  }
  // Docker's own answer for a container that is not there, in either spelling it uses.
  if (ABSENT_CONTAINER.test(result.stderr)) return { state: ABSENT }
  return { state: UNREADABLE, reason: 'the inspection was refused' }
}

// Whether Docker created one volume itself.
//
// A volume Docker reports as absent is gone. A volume whose labels cannot be
// read is not an answer either: an unreadable volume is never removed, and
// never reported as one that is not there.
function inspectVolumeOwnership(volume, timeoutMs) {
  const result = spawnSync(
    'docker',
    ['volume', 'inspect', '--format', '{{json .Labels}}', volume],
    {
      encoding: 'utf8',
      // SIGKILL, because the bound holds only if the killed client exits.
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }
  )
  if (result.error?.code === 'ETIMEDOUT')
    return { state: UNREADABLE, reason: 'the inspection timed out' }
  if (result.error) return { state: UNREADABLE, reason: 'the inspection failed' }
  if (result.status === 0) {
    let labels
    try {
      labels = JSON.parse(result.stdout)
    } catch {
      return { state: UNREADABLE, reason: 'the inspection returned unreadable output' }
    }
    if (labels === null || typeof labels !== 'object') {
      return { state: UNREADABLE, reason: 'the inspection returned unreadable output' }
    }
    return {
      state: INSPECTED,
      anonymous: Object.prototype.hasOwnProperty.call(labels, 'com.docker.volume.anonymous'),
    }
  }
  // Docker's own answer for a volume that is not there.
  if (ABSENT_VOLUME.test(result.stderr)) return { state: ABSENT }
  return { state: UNREADABLE, reason: 'the inspection was refused' }
}

// Removes one container by its exact name. A container Docker reports as absent
// is already removed. A removal that outlives its bound is killed with SIGKILL
// and throws, and every other failure throws too. Each error names the container,
// so a leaked instance fails the run and the operator knows which one to remove.
function removeNamedContainer(name, timeoutMs) {
  const result = spawnSync('docker', ['rm', '-f', name], {
    encoding: 'utf8',
    // SIGKILL, because the bound holds only if the killed client exits.
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
  const subject = `removing the throwaway capture provisioning container ${name}`
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${subject} timed out after ${timeoutMs} ms`)
  }
  if (result.error) throw new Error(`${subject} failed: ${result.error.message}`)
  if (result.status === 0 || result.stderr.includes('No such container')) return
  const detail =
    result.stderr.trim() ||
    (result.signal ? `ended by ${result.signal}` : `exit code ${result.status}`)
  throw new Error(`${subject} failed: ${detail}`)
}

// Removes one anonymous volume this helper owns, by its exact name.
//
// A volume Docker already removed is gone, and nothing is left to do. Any other
// failure throws, so a volume that survives fails the run instead of leaving a
// green result behind a leaked instance.
function removeOwnedVolume(volume) {
  const result = spawnSync('docker', ['volume', 'rm', volume], {
    encoding: 'utf8',
    // SIGKILL, because the bound holds only if the killed client exits.
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: volumeRemovalTimeoutMs,
  })
  const subject = `removing the throwaway volume ${volume}`
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${subject} timed out after ${volumeRemovalTimeoutMs} ms`)
  }
  if (result.error) throw new Error(`${subject} failed: ${result.error.message}`)
  if (result.status === 0) return
  if (ABSENT_VOLUME.test(result.stderr)) return
  const detail =
    result.stderr.trim() ||
    (result.signal ? `ended by ${result.signal}` : `exit code ${result.status}`)
  throw new Error(`${subject} failed: ${detail}`)
}

// Removes the volumes that are still on the host, by their exact identities.
//
// Every known volume is attempted, even when an earlier one failed, and the
// ones that could not be removed stay pending, so a later attempt takes them.
// The pending set is the handle's own: it holds the exact identities that are
// still there.
function removePendingVolumes(pending) {
  const failures = []
  for (const volume of pending) {
    try {
      removeOwnedVolume(volume)
      pending.delete(volume)
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

// Inspects the ownership of the candidates again, now that the container that
// held them is gone.
//
// A candidate is a mount id whose ownership could not be read. It is never
// removed without a verified anonymous ownership, and it is never lost either:
// an ownership that is still unreadable keeps the candidate, and the failure
// with it, so a later attempt can read it again.
function resolveCandidates(state, inspectionTimeoutMs) {
  const failures = []
  for (const candidate of state.candidates) {
    const ownership = inspectVolumeOwnership(candidate, inspectionTimeoutMs)
    if (ownership.state === UNREADABLE) {
      state.discoveryCertain = false
      state.discoveryReason = `the volume ${candidate} could not be inspected: ${ownership.reason}`
      failures.push(
        new Error(`the throwaway volume ${candidate} could not be inspected: ${ownership.reason}`)
      )
      continue
    }
    if (ownership.state === ABSENT) {
      // The volume is gone, so there is nothing left to remove.
      state.candidates.delete(candidate)
      continue
    }
    if (!ownership.anonymous) {
      // A named volume can belong to the operator or to another lane, and it is
      // never this helper's to remove.
      state.candidates.delete(candidate)
      continue
    }
    state.candidates.delete(candidate)
    state.pendingVolumes.add(candidate)
  }
  return failures
}

// Removes the owned container and the anonymous volumes Docker created for it.
//
// The container's mounts are read first, so the volumes that belong to it are
// known before it goes. An inspection that cannot be trusted is never read as
// an absent object: the container is still removed, because it is known and
// owned, and the cleanup fails, because the volumes it owned are then unknown.
//
// The state the handle keeps is updated as the cleanup runs: whether the
// container was created at all, whether its removal was verified, whether the
// volumes it owns are known, the mount ids whose ownership is still unreadable,
// and the exact identities that are still on the host. A failure is retained
// until the removal it belongs to is verified, so a later attempt tries it
// again.
function cleanupOwnedResources(name, state, timeoutMs, inspectionTimeoutMs) {
  const failures = []
  const inspection = inspectContainerMounts(name, inspectionTimeoutMs)
  if (inspection.state === UNREADABLE) {
    // The volumes this container owns are unknown, and unknown is not absent.
    state.discoveryCertain = false
    state.discoveryReason = `the container could not be inspected: ${inspection.reason}`
    failures.push(
      new Error(
        `the throwaway capture provisioning container ${name} could not be inspected: ${inspection.reason}`
      )
    )
  }
  if (inspection.state === ABSENT && !state.discoveryComplete) {
    if (state.creation === 'not-created') {
      // The container was never created, so it owned nothing and there is
      // nothing of it left behind.
      state.discoveryComplete = true
    } else {
      // The creation was never confirmed, so the container may have been
      // created and removed again, and what it owned is unknown.
      state.discoveryCertain = false
      state.discoveryReason =
        'the container may have been created and removed before its volumes could be read'
      failures.push(
        new Error(
          `the anonymous volumes of the throwaway capture provisioning container ${name} are still unknown: ${state.discoveryReason}`
        )
      )
    }
  }
  if (inspection.state === INSPECTED) {
    state.discoveryComplete = true
    for (const mount of inspection.mounts) {
      if (mount?.Type !== 'volume') continue
      if (typeof mount?.Name !== 'string' || !mount.Name) continue
      const ownership = inspectVolumeOwnership(mount.Name, inspectionTimeoutMs)
      if (ownership.state === UNREADABLE) {
        // The candidate is kept: its ownership is not verified, so it is never
        // removed, and it is not lost either.
        state.candidates.add(mount.Name)
        state.discoveryCertain = false
        state.discoveryReason = `the volume ${mount.Name} could not be inspected: ${ownership.reason}`
        failures.push(
          new Error(
            `the throwaway volume ${mount.Name} could not be inspected: ${ownership.reason}`
          )
        )
        continue
      }
      if (ownership.state === ABSENT) continue
      if (!ownership.anonymous) {
        // A named volume can belong to the operator or to another lane, and it is
        // never this helper's to remove.
        state.candidates.delete(mount.Name)
        continue
      }
      state.candidates.delete(mount.Name)
      state.pendingVolumes.add(mount.Name)
    }
  }
  // The container is known and owned, so it is removed even when the
  // inspection of its mounts was uncertain.
  try {
    removeNamedContainer(name, timeoutMs)
    // The removal is verified only when Docker confirmed it.
    state.containerRemoved = true
  } catch (error) {
    state.containerRemoved = false
    // The volumes that are still on the host are named, so the operator knows
    // what the failed removal left behind.
    const owned = [...state.pendingVolumes]
    failures.push(
      owned.length
        ? new Error(
            `${error.message}; its anonymous volume ${owned.join(', ')} was not removed with it`,
            { cause: error }
          )
        : error
    )
  }
  // The candidates are inspected again now that the container that held them is
  // gone, so a volume whose ownership is only unknown right now can still be
  // removed.
  failures.push(...resolveCandidates(state, inspectionTimeoutMs))
  // Every known volume is attempted, even when an earlier one failed.
  failures.push(...removePendingVolumes(state.pendingVolumes))
  // The volumes are known when the container's mounts were read and no mount id
  // is left unaccounted for.
  state.discoveryCertain = state.discoveryComplete && state.candidates.size === 0
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  // The message carries every failure, so the operator learns what is still on the host.
  throw new AggregateError(
    failures,
    `the throwaway capture provisioning cleanup did not finish: ${failures
      .map((failure) => failure.message)
      .join('; ')}`
  )
}

// Ties one handle's removal to the process. The exit listener covers a normal exit and an error exit (an
// uncaught exception also emits `exit`), and it is detached once the container's removal is verified. A removal that fails
// there turns an exit that would succeed into status 1, and keeps a failure status that is already set. The signal listeners
// stay attached for the life of the process: a SIGINT or SIGTERM removes the instance once, detaches the
// signal listeners, and re-raises the signal, so the process ends by that signal. A signal that arrives while
// the caller is blocked in a synchronous Docker call is dispatched when the event loop next runs, so it still
// ends the process by that signal. Detaching the signal listeners on a normal stop would drop such a pending
// signal and let the process carry on, so they are kept. Removal is idempotent per handle, so the instance is
// stopped exactly once however these paths interleave.
function attachRemoval(handle) {
  const onExit = (code) => {
    try {
      handle.stop()
    } catch (error) {
      console.error(error.message)
      // The instance may still be running, so an exit that would succeed must not report success.
      if (code === 0) process.exitCode = 1
    }
  }
  const signalListeners = interruptSignals.map((signal) => [
    signal,
    () => {
      for (const [other, listener] of signalListeners) process.off(other, listener)
      try {
        handle.stop()
      } catch (error) {
        console.error(error.message)
      }
      process.kill(process.pid, signal)
    },
  ])
  process.on('exit', onExit)
  for (const [signal, listener] of signalListeners) process.on(signal, listener)
  return () => process.off('exit', onExit)
}

function limited(result) {
  return result.status !== 0 && isRegistryRateLimit(`${result.stdout}\n${result.stderr}`)
}

// Runs `start(image)` against the digest-pinned capture image. Anonymous pulls from shared hosted
// runners are throttled per registry (`toomanyrequests`), so a rate-limited start falls over to the
// same digest on the other registries the main database uses (see docker-pull-backoff.mjs), then
// retries with the same bounded backoff. A digest names the content, so a fallback cannot change
// which image runs. Only a registry rate limit on the canonical reference moves on; a failing fallback
// is logged and the next registry is tried. `start` returns a spawnSync result; every
// caller that starts a container from this image goes through here, so none pulls it bare.
export function startFromCaptureImage(
  start,
  {
    backoffMs = defaultPullBackoffMs,
    budgetMs = captureStartBudgetMs,
    now = Date.now,
    sleep = sleepSync,
  } = {}
) {
  const [canonical, ...fallbacks] = [
    captureProvisioningImage,
    ...fallbackImages(captureProvisioningImage),
  ]
  // One deadline covers every attempt and every wait, so the retries can never outlast the caller's
  // startup budget. Each attempt is told how long it has left and must bound itself to that.
  const deadline = now() + budgetMs
  const remaining = () => deadline - now()
  let last
  for (let retry = 0; ; retry += 1) {
    last = start(canonical, remaining())
    // Only a rate limit on the canonical reference moves on: any other outcome there is final.
    if (last.error || !limited(last)) return last
    console.warn(`Container registry rate-limited an image pull for ${canonical}.`)
    for (const image of fallbacks) {
      if (remaining() <= 0) return last
      last = start(image, remaining())
      if (last.error || last.status === 0) return last
      // A fallback that fails, rate-limited or not, must not hide the registries after it.
      console.warn(`Starting from ${image} failed: ${last.stderr.trim() || `exit ${last.status}`}`)
    }
    // A wait that would leave no time for another attempt ends the retries instead of sleeping.
    if (retry >= backoffMs.length || remaining() <= backoffMs[retry]) return last
    console.warn(
      `Container registries rate-limited the capture image pull; retry ${retry + 1} of ${backoffMs.length} in ${backoffMs[retry] / 1000}s.`
    )
    sleep(backoffMs[retry])
  }
}

// Runs the throwaway container. The container name is fixed up front, so every attempt is removed by
// the same cleanup, and a start that fails before the container exists leaves nothing to remove.
function runCaptureContainer(name, password, options) {
  const result = startFromCaptureImage(
    (image, remainingMs) =>
      spawnSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
          // Loopback-only ephemeral host port: a plain `-P` publishes the port on
          // every host interface, which would put the throwaway instance on the
          // LAN. The mapping is read back below instead of guessing a port.
          '-p',
          '127.0.0.1::5432',
          '--name',
          name,
          '-e',
          `POSTGRES_PASSWORD=${password}`,
          image,
        ],
        {
          encoding: 'utf8',
          // SIGKILL, because the bound holds only if the killed client exits.
          killSignal: 'SIGKILL',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: Math.max(1, remainingMs),
        }
      ),
    options
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `starting the throwaway capture provisioning container (${captureProvisioningImage}) failed: ${result.stderr.trim() || `exit code ${result.status}`}`
    )
  }
}

/**
 * Starts the throwaway instance, or returns null when Docker is unavailable.
 * `register` receives the handle before the container exists, so a timeout or
 * crash anywhere after `docker run` still reaches the caller's cleanup and a
 * slow or failed start can never leak the container. The stop throws on failure
 * so the caller can report it: a leaked container must fail a green run instead
 * of being ignored. The handle also removes its container on a normal exit, an
 * error exit, and SIGINT or SIGTERM, and only that container. `removalTimeoutMs`
 * bounds each removal.
 */
export function startCaptureProvisioning(
  register = () => {},
  {
    removalTimeoutMs = defaultRemovalTimeoutMs,
    inspectionTimeoutMs = defaultInspectionTimeoutMs,
    backoffMs = defaultPullBackoffMs,
    budgetMs = captureStartBudgetMs,
  } = {}
) {
  if (!dockerDaemonAvailable()) return null
  // Random hex doubles as URL-safe: no percent-encoding concerns in the URL.
  const password = randomBytes(24).toString('hex')
  const name = `adea-capture-prov-${randomBytes(6).toString('hex')}`
  // What the cleanup has established so far.
  const state = {
    // Whether the container was created at all: 'not-attempted' before the run
    // is issued, 'not-created' when the image never arrived, 'attempted' when
    // the run was issued but never confirmed the creation, and 'created' when
    // the run succeeded. Only a proved non-creation clears the uncertainty
    // about the volumes the container owned.
    creation: 'not-attempted',
    // Whether the container's removal was verified. It is verified only when
    // Docker confirmed it, so a removal that failed is tried again.
    containerRemoved: false,
    // Whether the container's mounts were read at least once.
    discoveryComplete: false,
    // Whether every mount id is accounted for: the mounts were read and no
    // candidate is unresolved. An unresolved discovery is not an absence, and
    // it keeps failing until a discovery completes.
    discoveryCertain: false,
    discoveryReason: 'the container was never inspected',
    // The mount ids whose ownership could not be read. They are never removed
    // without a verified anonymous ownership, and they are never lost.
    candidates: new Set(),
    // The exact identities of the volumes that are still on the host.
    pendingVolumes: new Set(),
  }
  const handle = {
    containerName: name,
    databaseUrl: null,
    stop() {
      if (!state.containerRemoved) {
        // The container's removal was not verified, so it is tried again, and
        // the volumes it owns are discovered again.
        try {
          cleanupOwnedResources(name, state, removalTimeoutMs, inspectionTimeoutMs)
        } finally {
          // The exit listener is detached only once the container is verified
          // gone, so a removal that failed is retried when the process ends.
          if (state.containerRemoved) detachExit()
        }
        return
      }
      // The container is verified gone. The volumes that are still pending are
      // retried, and the candidates whose ownership could not be read are
      // inspected again, now that nothing holds them.
      const failures = removePendingVolumes(state.pendingVolumes)
      failures.push(...resolveCandidates(state, inspectionTimeoutMs))
      state.discoveryCertain = state.discoveryComplete && state.candidates.size === 0
      if (!state.discoveryCertain) {
        failures.push(
          new Error(
            `the anonymous volumes of the throwaway capture provisioning container ${name} are still unknown: ${state.discoveryReason}`
          )
        )
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `the throwaway capture provisioning cleanup did not finish: ${failures
            .map((failure) => failure.message)
            .join('; ')}`
        )
      }
    },
  }
  const detachExit = attachRemoval(handle)
  register(handle)
  try {
    // The creation is attempted from here on. A run that fails can still have
    // created the container, so the attempt is what is tracked, not the success.
    state.creation = 'attempted'
    runCaptureContainer(name, password, { backoffMs, budgetMs })
    // The container exists from here on, so it may own a volume.
    state.creation = 'created'
    // Read the loopback ephemeral host port mapping back instead of guessing
    // one. The image's default POSTGRES_USER (postgres, superuser) owns the
    // default `postgres` admin database.
    const mapping = dockerCaptureRun(
      ['port', name, '5432/tcp'],
      'reading the provisioning port mapping'
    )
    const port = mapping.split(/\r?\n/).at(-1)?.split(':').at(-1)
    if (!port) throw new Error(`unreadable provisioning port mapping: ${mapping}`)
    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline) {
      // Probe over TCP inside the container. The image's init phase runs a temporary server that
      // listens on its socket only, so a socket probe can succeed before the final server starts.
      const probe = spawnSync(
        'docker',
        ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        }
      )
      if (probe.error) throw probe.error
      if (probe.status === 0) {
        ready = true
        break
      }
      // Wait between readiness probes.
      sleepSync(1_000)
    }
    if (!ready) throw new Error('the throwaway capture provisioning instance never became ready')
    handle.databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`
    return handle
  } catch (error) {
    // An image that never arrived never created the container, and that is a
    // positive proof that there is nothing of it behind. Any other failure may
    // have created it, and the uncertainty stays.
    if (isRegistryRateLimit(error instanceof Error ? error.message : String(error))) {
      state.creation = 'not-created'
    }
    // A container that started but never became healthy must not leak. The
    // removal failure is surfaced on stderr but never replaces the original
    // error — the caller's cleanup would report it again anyway.
    try {
      handle.stop()
    } catch (cleanupError) {
      console.error(`capture provisioning cleanup failed: ${cleanupError.message}`)
    }
    throw error
  }
}
