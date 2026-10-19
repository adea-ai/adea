import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Container registries reject anonymous pulls from shared hosted-runner IPs with
// HTTP 429 (`toomanyrequests`). Retry only that rejection, with a bounded backoff.
// Every other failure, and every success, returns from the first attempt unchanged
// so real errors are neither delayed nor hidden. Image references stay digest-pinned
// by the caller; this helper never changes which image is pulled.
export const registryRateLimitPattern = /toomanyrequests|429 Too Many Requests|pull rate limit/i

export const defaultPullBackoffMs = [15_000, 45_000, 90_000]

export function isRegistryRateLimit(output) {
  return registryRateLimitPattern.test(output)
}

function isRateLimitedResult(result) {
  return (
    result.status !== 0 && isRegistryRateLimit(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  )
}

// `attempt` may be synchronous or return a promise of its result. The caller owns
// output: each attempt should echo its own stdout/stderr once it settles, so a
// rate-limited attempt stays visible in the log.
export async function runWithPullBackoff(
  attempt,
  {
    delaysMs = defaultPullBackoffMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (message) => console.warn(message),
  } = {}
) {
  for (let retry = 0; ; retry += 1) {
    const result = await attempt()
    if (!isRateLimitedResult(result) || retry >= delaysMs.length) return result
    const delayMs = delaysMs[retry]
    const attemptLabel = `retry ${retry + 1} of ${delaysMs.length}`
    log(`Container registry rate-limited an image pull; ${attemptLabel} in ${delayMs / 1000}s.`)
    await sleep(delayMs)
  }
}

// The compose file, the integration runner and the capture provisioning container pin the official Postgres image by digest on the AWS
// ECR Public mirror of Docker Hub. Anonymous pulls from shared hosted-runner IPs are throttled per
// registry (`toomanyrequests: Data limit exceeded` there, a pull-rate limit on Docker Hub), and the
// quota is exhausted by other tenants, not by us. The same digest is served anonymously by Google's
// Docker Hub mirror and by Docker Hub itself, so a rate-limited pull falls over to those hosts.
// A digest names the content, so the fallback cannot change which image runs.
const ecrPublicDockerPrefix = 'public.ecr.aws/docker/'
const fallbackRegistryHosts = ['mirror.gcr.io', 'docker.io']

export function fallbackImages(image) {
  if (!image.startsWith(ecrPublicDockerPrefix)) return []
  const repository = image.slice(ecrPublicDockerPrefix.length)
  return fallbackRegistryHosts.map((host) => `${host}/${repository}`)
}

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(
    signal.reason === undefined ? 'The operation was aborted' : String(signal.reason)
  )
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

function throwIfProcessIsStillRunning(result) {
  if (result.reaped === false || result.groupExited === false)
    throw result.error ?? new Error('Command process or its owned process group did not exit')
}

// compose.yml reads the image through ADEA_POSTGRES_IMAGE so a fallback registry can be selected
// per invocation; the default after `:-` is the canonical pinned reference.
export const composeImageVariable = 'ADEA_POSTGRES_IMAGE'

export function composePostgresImage(root) {
  const source = readFileSync(join(root, 'compose.yml'), 'utf8')
  const match = source.match(/^\s*image:\s*\$\{ADEA_POSTGRES_IMAGE:-([^}\s]+)\}\s*$/m)
  if (!match)
    throw new Error(
      'compose.yml must define the postgres image as ${ADEA_POSTGRES_IMAGE:-<pinned reference>}'
    )
  return match[1]
}

// Environment for a compose invocation that runs the given fallback image; undefined keeps the
// canonical pinned reference from compose.yml.
export function withComposeImage(env, image) {
  return image === undefined ? env : { ...env, [composeImageVariable]: image }
}

// Like runWithPullBackoff, but a rate-limited attempt first falls over to the same digest on the
// other registries before any backoff. `attempt(image)` runs the real command: `image` is
// undefined for the canonical reference, or a fallback reference that `pull` already fetched.
// Only the canonical attempt is judged by its failure kind: a real failure there is returned
// unchanged. Once it has been rate limited, a fallback that fails in any way (cannot be pulled,
// or its attempt fails) only moves on to the next registry, because the failure of one mirror says
// nothing about the others.
export async function runWithPullFallback(attempt, image, options = {}) {
  const {
    delaysMs = defaultPullBackoffMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (message) => console.warn(message),
    signal,
  } = options
  const pull =
    options.pull ??
    ((reference) => captureCommand('docker', ['pull', '--quiet', reference], { signal }))
  const fallbacks = fallbackImages(image)
  for (let retry = 0; ; retry += 1) {
    throwIfAborted(signal)
    let result = await attempt(undefined)
    throwIfAborted(signal)
    throwIfProcessIsStillRunning(result)
    if (!isRateLimitedResult(result)) return result
    for (const fallback of fallbacks) {
      throwIfAborted(signal)
      log(`Container registry rate-limited an image pull; trying ${fallback}.`)
      const pulled = await pull(fallback)
      throwIfAborted(signal)
      throwIfProcessIsStillRunning(pulled)
      if (pulled.status !== 0) {
        const reason =
          `${pulled.stderr ?? ''}`.trim() || pulled.error?.message || `exit ${pulled.status}`
        log(`Pulling ${fallback} failed: ${reason}`)
        continue
      }
      result = await attempt(fallback)
      throwIfAborted(signal)
      throwIfProcessIsStillRunning(result)
      if (result.status === 0) return result
      log(`Running with ${fallback} failed (exit ${result.status}); trying the next registry.`)
    }
    if (retry >= delaysMs.length) return result
    const delayMs = delaysMs[retry]
    log(
      `Container registries rate-limited an image pull; retry ${retry + 1} of ${delaysMs.length} in ${delayMs / 1000}s.`
    )
    await sleep(delayMs)
    throwIfAborted(signal)
  }
}

// Makes `image` available locally for a later `docker run`, with the same fallback and backoff.
// Resolves to { result, image }: `image` is the reference that is now present locally.
export async function ensureImage(image, options = {}) {
  const inspect =
    options.inspect ?? ((reference) => captureCommand('docker', ['image', 'inspect', reference]))
  const pull =
    options.pull ?? ((reference) => captureCommand('docker', ['pull', '--quiet', reference]))
  if ((await inspect(image)).status === 0) {
    return { result: { status: 0, stdout: '', stderr: '' }, image }
  }
  const echo = options.log ?? ((message) => console.warn(message))
  let used = image
  const result = await runWithPullFallback(
    async (fallback) => {
      // A fallback was already pulled by runWithPullFallback, so only the canonical reference
      // is pulled here; its failure is what decides whether the fallbacks are tried.
      if (fallback !== undefined) {
        used = fallback
        return { status: 0, stdout: '', stderr: '' }
      }
      const attempt = await pull(image)
      if (attempt.stderr) echo(attempt.stderr.trim())
      return attempt
    },
    image,
    { ...options, pull }
  )
  return { result, image: used }
}

// Runs one command and captures its output without blocking the event loop, so
// signal handling and child cleanup keep running while the command is in flight.
// `processGroup` opts into an owned detached session for commands that may spawn
// plugins or other children; it stays off by default for unrelated callers.
// A spawn failure (for example a missing executable) resolves with `error` set
// instead of rejecting, so the caller decides how to report it.
export function captureCommand(
  command,
  args,
  {
    cwd,
    env,
    signal,
    timeoutMs,
    terminationGraceMs = 1_000,
    reapTimeoutMs = 2_000,
    processGroup = false,
  } = {}
) {
  if (signal?.aborted)
    return Promise.resolve({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: abortError(signal),
      cancelled: true,
      timedOut: false,
      reaped: true,
      groupExited: true,
    })

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let error
    let cancelled = false
    let timedOut = false
    let closed = false
    let settled = false
    let terminationStarted = false
    let childStatus = null
    let childSignal = null
    let reapDeadline
    let timeoutTimer
    let terminationTimer
    let reapTimer

    const child = spawn(command, args, {
      cwd,
      env,
      detached: processGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const groupHasExited = () => {
      if (!processGroup || child.pid === undefined) return true
      try {
        process.kill(-child.pid, 0)
        return false
      } catch (groupError) {
        if (groupError.code === 'ESRCH') return true
        if (groupError.code === 'EPERM') return false
        error ??= groupError
        return false
      }
    }
    const finish = (status, exitSignal, reaped, groupExited) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(terminationTimer)
      clearTimeout(reapTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        status,
        signal: exitSignal,
        stdout,
        stderr,
        error,
        cancelled,
        timedOut,
        reaped,
        groupExited,
      })
    }
    const checkReaped = () => {
      if (settled) return
      const groupExited = groupHasExited()
      if (closed && groupExited) {
        finish(childStatus, childSignal, true, true)
        return
      }
      if (Date.now() >= reapDeadline) {
        error = new Error(
          groupExited
            ? `${command} ${args.join(' ')} did not exit after SIGKILL`
            : `${command} ${args.join(' ')} process group remained after SIGKILL`
        )
        finish(childStatus, childSignal ?? 'SIGKILL', closed, groupExited)
        return
      }
      reapTimer = setTimeout(checkReaped, 25)
    }
    const signalOwnedProcess = (signalName) => {
      try {
        if (processGroup && child.pid !== undefined) process.kill(-child.pid, signalName)
        else child.kill(signalName)
      } catch (killError) {
        if (killError.code !== 'ESRCH') error ??= killError
      }
    }
    const terminate = (reason) => {
      if (settled || terminationStarted) return
      terminationStarted = true
      if (reason === 'abort') {
        cancelled = true
        error ??= abortError(signal)
      } else if (reason === 'timeout') {
        timedOut = true
        error ??= new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`)
      } else {
        error ??= new Error(`${command} exited with its owned process group still active`)
      }
      signalOwnedProcess('SIGTERM')
      terminationTimer = setTimeout(() => {
        if (settled) return
        signalOwnedProcess('SIGKILL')
        reapDeadline = Date.now() + reapTimeoutMs
        checkReaped()
      }, terminationGraceMs)
    }
    const onAbort = () => terminate('abort')

    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.once('error', (spawnError) => (error = spawnError))
    child.once('close', (status, exitSignal) => {
      closed = true
      childStatus = status
      childSignal = exitSignal
      const groupExited = groupHasExited()
      if (groupExited) finish(status, exitSignal, true, true)
      else if (terminationStarted && reapDeadline !== undefined) checkReaped()
      else terminate('orphan')
    })

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    if (timeoutMs !== undefined) timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs)
  })
}
