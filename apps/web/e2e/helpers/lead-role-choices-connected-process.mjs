import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const phases = new Set([
  'preflight',
  'setup',
  'host-launch',
  'prepare',
  'dispatch',
  'drain',
  'publication',
  'cleanup',
])
const codes = new Set([
  'PROOF_FAILED',
  'PROOF_ASSERTION_FAILED',
  'PI_FACTORY_PROOF_UNSUPPORTED_INSTALLED_SDK',
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
])
export class FactoryFixtureFailure extends Error {
  constructor(code) {
    super(codes.has(code) ? code : 'PROOF_FAILED')
    this.code = codes.has(code) ? code : 'PROOF_FAILED'
  }
}
function readErrorCode(error) {
  try {
    return error?.code
  } catch {
    return undefined
  }
}
const safeTransportClasses = new Set([
  'AbortError',
  'ConnectTimeoutError',
  'DOMException',
  'Error',
  'FetchError',
  'HeadersTimeoutError',
  'SocketError',
  'TimeoutError',
  'TypeError',
])
const safeTransportCodes = new Set([
  'ABORT_ERR',
  'CONTROL_PLANE_TRANSPORT_FAILED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_ABORTED',
  'ERR_NETWORK',
  'ERR_SOCKET_CLOSED',
  'HOST_CONTROL_TIMEOUT',
  'PI_LEAD_DISPATCH_CONFLICT',
  'PI_LEAD_FUNDING_CONFIRMATION_STALE',
  'PI_LEAD_UNAVAILABLE',
  'RUNTIME_RESPONSE_INVALID',
  'RUNTIME_UNAVAILABLE',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])
function safeTransportClass(value) {
  try {
    const name = value?.name
    return typeof name === 'string' && safeTransportClasses.has(name) ? name : 'OtherError'
  } catch {
    return 'OtherError'
  }
}
function safeTransportCode(value) {
  try {
    const code = value?.code
    if (typeof code === 'string' && safeTransportCodes.has(code)) return code
    const message = value?.message
    if (typeof message === 'string' && safeTransportCodes.has(message)) return message
  } catch {}
  return undefined
}
/** Allowlisted fetch failure details for diagnosing deadlines without exposing messages or stacks. */
export function safeTransportFailureDiagnostic(error, signal, elapsedMs) {
  let cause
  let reason
  let signalAborted = false
  try {
    cause = error?.cause
  } catch {}
  try {
    reason = signal?.reason
    signalAborted = signal?.aborted === true
  } catch {}
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, Math.min(180_000, elapsedMs)) : 0
  const record = {
    elapsedMs: Math.round(elapsed),
    errorClass: safeTransportClass(error),
    signalAborted,
    ...(safeTransportCode(error) ? { errorCode: safeTransportCode(error) } : {}),
    ...(reason ? { signalReasonClass: safeTransportClass(reason) } : {}),
    ...(safeTransportCode(reason) ? { signalReasonCode: safeTransportCode(reason) } : {}),
    ...(cause ? { causeClass: safeTransportClass(cause) } : {}),
    ...(safeTransportCode(cause) ? { causeCode: safeTransportCode(cause) } : {}),
  }
  return record
}
/** No error messages, stacks, upstream text, executable paths, or child stderr cross this boundary. */
export function factoryFailureRecord(phase, error, readerRequests = 0) {
  let code = 'PROOF_FAILED'
  const captured = readErrorCode(error)
  try {
    if (typeof captured === 'string') {
      if (error instanceof FactoryFixtureFailure && codes.has(captured)) code = captured
      else if (captured === 'ERR_ASSERTION') code = 'PROOF_ASSERTION_FAILED'
    }
  } catch {} // A hostile prototype/proxy cannot escape diagnostic construction.
  return {
    schemaVersion: 'adea-production-factory-failure/v1',
    phase: phases.has(phase) ? phase : 'preflight',
    code,
    readerRequests:
      Number.isSafeInteger(readerRequests) && readerRequests >= 0 ? readerRequests : 0,
  }
}
export function boundedFactoryWait(promise, ms, code) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new FactoryFixtureFailure(code)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
/** Own exactly one child. Register error/exit/close before awaiting startup or sending controls. */
export function startFactoryChild(binary, args, options) {
  const child = spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  const controls = new Map()
  let startupSettled = false,
    didSpawn = false,
    didClose = false,
    settleClose
  let resolveReady, rejectReady
  const closed = new Promise((resolve) => {
    settleClose = resolve
  })
  const startup = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const settleStartup = (error, value) => {
    if (startupSettled) return
    startupSettled = true
    if (error) rejectReady(error)
    else resolveReady(value)
  }
  const rejectControls = (code) => {
    for (const pending of controls.values()) pending.reject(new FactoryFixtureFailure(code))
    controls.clear()
  }
  child.once('spawn', () => {
    didSpawn = true
  })
  child.on('error', (error) => {
    const captured = readErrorCode(error)
    const code =
      captured === 'ENOENT'
        ? 'HOST_BINARY_MISSING'
        : captured === 'EACCES'
          ? 'HOST_BINARY_NOT_EXECUTABLE'
          : 'HOST_SPAWN_FAILED'
    settleStartup(new FactoryFixtureFailure(code))
    rejectControls('HOST_CONTROL_UNAVAILABLE')
  })
  child.once('exit', () => {
    settleStartup(new FactoryFixtureFailure('HOST_EXIT_BEFORE_READY'))
    rejectControls('HOST_EXIT_BEFORE_CONTROL_REPLY')
  })
  child.once('close', () => {
    didClose = true
    settleStartup(new FactoryFixtureFailure('HOST_EXIT_BEFORE_READY'))
    rejectControls('HOST_EXIT_BEFORE_CONTROL_REPLY')
    settleClose()
  })
  child.stdin.on('error', () => rejectControls('HOST_CONTROL_UNAVAILABLE'))
  child.stderr.on('data', () => {}) // Drain, never retain or forward provider/credential diagnostics.
  child.stderr.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  lines.on('error', () => settleStartup(new FactoryFixtureFailure('HOST_SPAWN_FAILED')))
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line)
      if (value?.baseUrl) settleStartup(null, value)
      else if (typeof value?.controlId === 'string' && controls.has(value.controlId)) {
        controls.get(value.controlId).resolve(value.data)
        controls.delete(value.controlId)
      }
    } catch {} // Unrecognized/raw child output is never printed.
  })
  async function control(command) {
    if (!['evidence', 'drain', 'close'].includes(command) || didClose || !didSpawn)
      throw new FactoryFixtureFailure('HOST_CONTROL_UNAVAILABLE')
    const id = crypto.randomUUID()
    const promise = new Promise((resolve, reject) => controls.set(id, { resolve, reject }))
    try {
      child.stdin.write(JSON.stringify({ id, command }) + '\n', (error) => {
        if (error) rejectControls('HOST_CONTROL_UNAVAILABLE')
      })
      return await boundedFactoryWait(
        promise,
        command === 'drain' ? 30_000 : 5_000,
        'HOST_CONTROL_TIMEOUT'
      )
    } finally {
      controls.delete(id)
    }
  }
  async function closeOwned() {
    if (didClose) return
    if (didSpawn && child.exitCode === null && child.signalCode === null) {
      try {
        await control('close')
      } catch {}
    }
    if (didClose) return
    if (!didSpawn || child.exitCode !== null || child.signalCode !== null) {
      await boundedFactoryWait(closed, 5_000, 'HOST_CLOSE_TIMEOUT')
      return
    }
    child.kill('SIGTERM')
    try {
      await boundedFactoryWait(closed, 5_000, 'HOST_CLOSE_TIMEOUT')
    } catch {
      if (!didClose && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await boundedFactoryWait(closed, 5_000, 'HOST_REAP_TIMEOUT')
    }
  }
  return {
    ready: () => boundedFactoryWait(startup, 30_000, 'HOST_LAUNCH_TIMEOUT'),
    control,
    closeOwned,
    closed,
  }
}
/** Shared failure/cleanup boundary: it returns failure, never rethrows raw exceptions. */
export async function runFactoryProof(
  work,
  cleanups,
  output = (record) => console.error(JSON.stringify(record))
) {
  let failed = false
  function report(error, cleanup = false) {
    let phase = cleanup ? 'cleanup' : 'preflight'
    let requests = 0
    try {
      if (!cleanup) phase = cleanups.phase()
    } catch {}
    try {
      requests = cleanups.readerRequests()
    } catch {}
    try {
      void Promise.resolve(output(factoryFailureRecord(phase, error, requests))).catch(() => {})
    } catch {} // Diagnostic construction/output must never interrupt resource cleanup.
  }
  try {
    await work()
  } catch (error) {
    failed = true
    report(error)
  } finally {
    for (const cleanup of cleanups.actions) {
      try {
        await cleanup()
      } catch (error) {
        failed = true
        report(error, true)
      }
    }
  }
  return failed ? 1 : 0
}
