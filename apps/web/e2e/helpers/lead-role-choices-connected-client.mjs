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

function safeSpawnReason(error) {
  if (error?.code === 'ENOENT') return 'HOST_BINARY_MISSING'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'HOST_BINARY_NOT_EXECUTABLE'
  return 'HOST_SPAWN_FAILED'
}

function startupError(phase, reason) {
  return new Error(`CONNECTED_FIXTURE_START_FAILED:${phase}:${reason}:Error`)
}

/** Owns only the Bun fixture child; diagnostic text from its stderr is discarded. */
export async function startConnectedFixtureChild({
  bun,
  cwd,
  env,
  spawnProcess = spawn,
  startupTimeoutMs = 60_000,
  controlTimeoutMs = 10_000,
  closeCommandTimeoutMs = 20_000,
  closeWaitMs = 20_000,
  terminateWaitMs = 5_000,
  reapWaitMs = 5_000,
}) {
  const script = new URL('./lead-role-choices-connected-fixture-server.mjs', import.meta.url)
  let child
  try {
    child = spawnProcess(bun, ['--conditions=react-server', script.pathname], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    throw startupError('spawn', 'HOST_SPAWN_FAILED')
  }
  const pending = new Map()
  let readyResolve
  let readyReject
  let didClose = false
  let readySettled = false
  let closeResult
  let cleanupPromise
  let childUnavailable = false
  let readyRecordReceived = false
  let childFailureReason
  let resolveClose
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve
  })
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const settleReady = (settle, value) => {
    if (readySettled) return false
    readySettled = true
    settle(value)
    return true
  }
  const rejectPending = (error = new Error('CONNECTED_FIXTURE_CLOSED')) => {
    for (const value of pending.values()) value.reject(error)
    pending.clear()
  }

  const signalChild = (signal) => {
    if (didClose || child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill(signal)
    } catch {
      // The close event below is the only proof that this owned process exited.
    }
  }

  const terminateAndReap = () => {
    if (didClose) return closePromise
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      signalChild('SIGTERM')
      try {
        return await bounded(closePromise, terminateWaitMs, 'HOST_TERMINATE_TIMEOUT')
      } catch {
        signalChild('SIGKILL')
        try {
          return await bounded(closePromise, reapWaitMs, 'HOST_REAP_TIMEOUT')
        } catch {
          throw new Error('HOST_REAP_TIMEOUT')
        }
      }
    })()
    return cleanupPromise
  }

  const failChild = (phase, reason) => {
    if (didClose) return
    childUnavailable = true
    childFailureReason = reason
    settleReady(readyReject, startupError(phase, reason))
    rejectPending(new Error('CONNECTED_FIXTURE_CONTROL_FAILED'))
    void terminateAndReap().catch(() => {})
  }
  const handleChildError = (error) =>
    failChild(
      readyRecordReceived ? 'startup' : 'spawn',
      readyRecordReceived ? 'HOST_CONTROL_UNAVAILABLE' : safeSpawnReason(error)
    )
  const handleStreamError = () => failChild('startup', 'HOST_CONTROL_UNAVAILABLE')

  // ChildProcess may emit an asynchronous spawn/kill error after an earlier
  // error event. Keep the listener installed so no later error escapes.
  child.on('error', handleChildError)
  child.once('close', (code, signal) => {
    didClose = true
    closeResult = { code, signal }
    settleReady(readyReject, startupError('startup', 'HOST_EXIT_BEFORE_READY'))
    rejectPending()
    resolveClose(closeResult)
  })
  child.stderr.on('data', () => {})
  child.stderr.on('error', handleStreamError)
  child.stdin.on('error', handleStreamError)
  child.stdout.on('error', handleStreamError)
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
            'DATABASE_URL_REQUIRED',
            'DATABASE_URL_INVALID',
            'DATABASE_URL_PROTOCOL_INVALID',
            'DATABASE_URL_INCOMPLETE',
            'DATABASE_CLIENT_URL_ENV_PRESENT',
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
          settleReady(
            readyReject,
            new Error(
              `CONNECTED_FIXTURE_START_FAILED:${phase}:${reason}:${failureClass}${missingPackage ? `:${missingPackage}` : ''}`
            )
          )
        } else {
          readyRecordReceived = true
          settleReady(readyResolve, message)
        }
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

  const writeCommand = async (command, fields = {}) => {
    if (didClose || childUnavailable) throw new Error('CONNECTED_FIXTURE_CLOSED')
    const id = randomUUID()
    const control = {}
    const promise = new Promise((resolve, reject) => {
      Object.assign(control, { resolve, reject })
      pending.set(id, control)
    })
    try {
      child.stdin.write(`${JSON.stringify({ id, command, ...fields })}\n`, (error) => {
        if (error) {
          childUnavailable = true
          if (pending.get(id) === control) {
            pending.delete(id)
            control.reject(new Error('CONNECTED_FIXTURE_CONTROL_WRITE_FAILED'))
          }
          rejectPending(new Error('CONNECTED_FIXTURE_CONTROL_FAILED'))
          void terminateAndReap().catch(() => {})
        }
      })
    } catch {
      childUnavailable = true
      pending.delete(id)
      control.reject(new Error('CONNECTED_FIXTURE_CONTROL_WRITE_FAILED'))
      rejectPending(new Error('CONNECTED_FIXTURE_CONTROL_FAILED'))
      void terminateAndReap().catch(() => {})
    }
    try {
      return await bounded(
        promise,
        command === 'close' ? closeCommandTimeoutMs : controlTimeoutMs,
        'CONNECTED_FIXTURE_CONTROL_TIMEOUT'
      )
    } finally {
      if (pending.get(id) === control) pending.delete(id)
    }
  }

  let ready
  try {
    ready = await bounded(readyPromise, startupTimeoutMs, 'CONNECTED_FIXTURE_START_TIMEOUT')
  } catch (error) {
    if (error?.message === 'CONNECTED_FIXTURE_START_TIMEOUT')
      settleReady(readyReject, new Error('CONNECTED_FIXTURE_START_TIMEOUT'))
    try {
      await terminateAndReap()
    } catch {
      throw new Error('HOST_REAP_TIMEOUT')
    }
    throw error
  }
  if (didClose || childUnavailable) {
    try {
      await terminateAndReap()
    } catch {
      throw new Error('HOST_REAP_TIMEOUT')
    }
    throw startupError('startup', childFailureReason ?? 'HOST_EXIT_BEFORE_CONTROL_REPLY')
  }
  if (!ready?.baseUrl || !ready?.workspaceId || !ready?.channelId || !ready?.credential) {
    try {
      await terminateAndReap()
    } catch {
      throw new Error('HOST_REAP_TIMEOUT')
    }
    throw new Error('CONNECTED_FIXTURE_INVALID_READY_RECORD')
  }
  return {
    ...ready,
    evidence: () => writeCommand('evidence'),
    snapshot: (intentId) => writeCommand('snapshot', { intentId }),
    async close() {
      if (didClose) return closePromise
      try {
        await writeCommand('close')
      } catch {
        // A lost close acknowledgement is resolved by exit or signal escalation.
      }
      if (!didClose) {
        try {
          await bounded(closePromise, closeWaitMs, 'CONNECTED_FIXTURE_CLOSE_TIMEOUT')
        } catch {
          try {
            await terminateAndReap()
          } catch {
            throw new Error('HOST_REAP_TIMEOUT')
          }
        }
      }
      return closeResult
    },
  }
}
