import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

function bounded(promise, milliseconds, code) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), milliseconds)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Owns only the Bun fixture child; diagnostic text from its stderr is discarded. */
export async function startConnectedFixtureChild({ bun, cwd, env }) {
  const script = new URL('./lead-role-choices-connected-fixture-server.mjs', import.meta.url)
  const child = spawn(bun, ['--conditions=react-server', script.pathname], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let readyResolve
  let readyReject
  let didClose = false
  const closePromise = new Promise((resolve) => child.once('close', resolve))
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const rejectPending = () => {
    for (const value of pending.values()) value.reject(new Error('CONNECTED_FIXTURE_CLOSED'))
    pending.clear()
  }
  child.once('error', () => readyReject(new Error('CONNECTED_FIXTURE_SPAWN_FAILED')))
  child.once('close', () => {
    didClose = true
    readyReject(new Error('CONNECTED_FIXTURE_CLOSED_BEFORE_READY'))
    rejectPending()
  })
  child.stderr.on('data', () => {})
  child.stderr.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (message?.schemaVersion === 'adea-connected-role-fixture/v1') {
        if (message.failure) {
          const allowedPhases = new Set([
            'configuration',
            'candidate-archive-verification',
            'candidate-source-verification',
            'module-loading',
            'runtime-configuration',
            'database-module-loading',
            'db-package-import',
            'db-driver-import',
            'temporary-session-import',
            'reader-imports',
            'reader-handler-import',
            'service-verifier-import',
            'admin-dependencies-import',
            'lead-product-composition-import',
            'application-database-import',
            'request-scope-import',
            'workspace-principal-import',
            'workspace-authorization-import',
            'desktop-request-guard-import',
            'workspace-response-import',
            'conversation-error-import',
            'route-handlers-import',
            'lead-target-import',
            'sdk-ports-import',
            'database-connection',
            'database-seed',
            'product-reader-setup',
            'signed-reader-start',
            'candidate-host-start',
            'candidate-host-spawn',
            'candidate-host-ready',
            'candidate-host-identity',
            'candidate-host-workspace',
            'candidate-host-principal',
            'candidate-host-profile',
            'candidate-profile-profileid',
            'candidate-profile-profileversion',
            'candidate-profile-profilerevision',
            'application-database',
            'lead-product-dependencies',
            'lead-product-composition',
            'fixture-api-start',
            'startup',
          ])
          const phase = allowedPhases.has(message.phase) ? message.phase : 'startup'
          const reason = [
            'MODULE_NOT_FOUND',
            'PACKAGE_EXPORT_MISSING',
            'FIXTURE_ASSERTION_FAILED',
            'FIXTURE_INITIALIZATION_FAILED',
            'HOST_BINARY_MISSING',
            'HOST_BINARY_NOT_EXECUTABLE',
            'HOST_SPAWN_FAILED',
            'HOST_EXIT_BEFORE_READY',
            'HOST_EXIT_BEFORE_CONTROL_REPLY',
            'HOST_CONTROL_UNAVAILABLE',
            'HOST_LAUNCH_TIMEOUT',
            'HOST_CONTROL_TIMEOUT',
            'HOST_CLOSE_TIMEOUT',
            'HOST_REAP_TIMEOUT',
          ].includes(message.reason)
            ? message.reason
            : 'FIXTURE_INITIALIZATION_FAILED'
          const missingPackage =
            typeof message.missingPackage === 'string' &&
            /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/u.test(
              message.missingPackage
            )
              ? message.missingPackage
              : undefined
          const failureClass =
            typeof message.failureClass === 'string' &&
            /^[A-Za-z][A-Za-z0-9]{0,48}$/u.test(message.failureClass)
              ? message.failureClass
              : 'Error'
          readyReject(
            new Error(
              `CONNECTED_FIXTURE_START_FAILED:${phase}:${reason}:${failureClass}${missingPackage ? `:${missingPackage}` : ''}`
            )
          )
        } else readyResolve(message)
      } else if (typeof message?.controlId === 'string' && pending.has(message.controlId)) {
        const control = pending.get(message.controlId)
        pending.delete(message.controlId)
        if (message.failure) control.reject(new Error('CONNECTED_FIXTURE_CONTROL_FAILED'))
        else control.resolve(message.data)
      }
    } catch {
      // Ignore non-protocol output; never echo child diagnostics into the test log.
    }
  })

  const writeCommand = (command, fields = {}) => {
    if (didClose) throw new Error('CONNECTED_FIXTURE_CLOSED')
    const id = randomUUID()
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ id, command, ...fields })}\n`, (error) => {
      if (error) {
        pending.get(id)?.reject(new Error('CONNECTED_FIXTURE_CONTROL_WRITE_FAILED'))
        pending.delete(id)
      }
    })
    return bounded(
      promise,
      command === 'close' ? 20_000 : 10_000,
      'CONNECTED_FIXTURE_CONTROL_TIMEOUT'
    )
  }

  const ready = await bounded(readyPromise, 60_000, 'CONNECTED_FIXTURE_START_TIMEOUT')
  if (!ready?.baseUrl || !ready?.workspaceId || !ready?.channelId || !ready?.credential) {
    await child.close?.()
    throw new Error('CONNECTED_FIXTURE_INVALID_READY_RECORD')
  }
  return {
    ...ready,
    evidence: () => writeCommand('evidence'),
    snapshot: (intentId) => writeCommand('snapshot', { intentId }),
    async close() {
      if (didClose) return
      try {
        await writeCommand('close')
      } catch {
        if (!didClose && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      }
      if (!didClose) {
        await bounded(closePromise, 20_000, 'CONNECTED_FIXTURE_CLOSE_TIMEOUT').catch(() => {
          if (!didClose && child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
        })
      }
    },
  }
}
