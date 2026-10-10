import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

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
export const captureProvisioningImage = 'postgres:18-alpine'

// The signals that end a run early. Removal of the instance runs on these, on a
// normal exit and on an error exit, and only for the container this module
// created.
const interruptSignals = ['SIGINT', 'SIGTERM']

export function dockerDaemonAvailable() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return !result.error && result.status === 0
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

// Removes one container by its exact name. A container Docker reports as absent
// is already removed. Any other failure throws and names the container, so a
// leaked instance fails the run and the operator knows which one to remove.
function removeNamedContainer(name) {
  const result = spawnSync('docker', ['rm', '-f', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status === 0 || result.stderr.includes('No such container')) return
  throw new Error(
    `removing the throwaway capture provisioning container ${name} failed: ${result.stderr.trim() || `exit code ${result.status}`}`
  )
}

// Ties one handle's removal to the process. The exit listener covers a normal exit and an error exit (an
// uncaught exception also emits `exit`), and it is detached once the handle is stopped. The signal listeners
// stay attached for the life of the process: a SIGINT or SIGTERM removes the instance once, detaches the
// signal listeners, and re-raises the signal, so the process ends by that signal. A signal that arrives while
// the caller is blocked in a synchronous Docker call is dispatched when the event loop next runs, so it still
// ends the process by that signal. Detaching the signal listeners on a normal stop would drop such a pending
// signal and let the process carry on, so they are kept. Removal is idempotent per handle, so the instance is
// stopped exactly once however these paths interleave.
function attachRemoval(handle) {
  const onExit = () => {
    try {
      handle.stop()
    } catch (error) {
      console.error(error.message)
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

/**
 * Starts the throwaway instance, or returns null when Docker is unavailable.
 * `register` receives the handle before the container exists, so a timeout or
 * crash anywhere after `docker run` still reaches the caller's cleanup and a
 * slow or failed start can never leak the container. The stop throws on failure
 * so the caller can report it: a leaked container must fail a green run instead
 * of being ignored. The handle also removes its container on a normal exit, an
 * error exit, and SIGINT or SIGTERM, and only that container.
 */
export function startCaptureProvisioning(register = () => {}) {
  if (!dockerDaemonAvailable()) return null
  // Random hex doubles as URL-safe: no percent-encoding concerns in the URL.
  const password = randomBytes(24).toString('hex')
  const name = `adea-capture-prov-${randomBytes(6).toString('hex')}`
  let stopped = false
  const handle = {
    containerName: name,
    databaseUrl: null,
    stop() {
      if (stopped) return
      stopped = true
      detachExit()
      removeNamedContainer(name)
    },
  }
  const detachExit = attachRemoval(handle)
  register(handle)
  try {
    dockerCaptureRun(
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
        captureProvisioningImage,
      ],
      `starting the throwaway capture provisioning container (${captureProvisioningImage})`,
      120_000
    )
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
      const probe = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      if (probe.error) throw probe.error
      if (probe.status === 0) {
        ready = true
        break
      }
      // Synchronous sleep between readiness probes; the runner is single-
      // threaded and the next step needs the instance healthy.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
    }
    if (!ready) throw new Error('the throwaway capture provisioning instance never became ready')
    handle.databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`
    return handle
  } catch (error) {
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
