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
// Only a registry rate limit moves on: a real failure from any attempt is returned unchanged.
export async function runWithPullFallback(
  attempt,
  image,
  {
    delaysMs = defaultPullBackoffMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = (message) => console.warn(message),
    pull = (reference) => captureCommand('docker', ['pull', '--quiet', reference]),
  } = {}
) {
  const fallbacks = fallbackImages(image)
  for (let retry = 0; ; retry += 1) {
    let result = await attempt(undefined)
    if (!isRateLimitedResult(result)) return result
    for (const fallback of fallbacks) {
      log(`Container registry rate-limited an image pull; trying ${fallback}.`)
      const pulled = await pull(fallback)
      if (pulled.status !== 0) {
        const reason =
          `${pulled.stderr ?? ''}`.trim() || pulled.error?.message || `exit ${pulled.status}`
        log(`Pulling ${fallback} failed: ${reason}`)
        continue
      }
      result = await attempt(fallback)
      if (!isRateLimitedResult(result)) return result
    }
    if (retry >= delaysMs.length) return result
    const delayMs = delaysMs[retry]
    log(
      `Container registries rate-limited an image pull; retry ${retry + 1} of ${delaysMs.length} in ${delayMs / 1000}s.`
    )
    await sleep(delayMs)
  }
}

// Makes `image` available locally for a later `docker run`, with the same fallback and backoff.
// Resolves to { result, image }: `image` is the reference that is now present locally.
export async function ensureImage(image, options = {}) {
  const inspect =
    options.inspect ?? ((reference) => captureCommand('docker', ['image', 'inspect', reference]))
  const pull =
    options.pull ?? ((reference) => captureCommand('docker', ['pull', '--quiet', reference]))
  if ((await inspect(image)).status === 0)
    return { result: { status: 0, stdout: '', stderr: '' }, image }
  const echo = options.log ?? ((message) => console.warn(message))
  let used = image
  const result = await runWithPullFallback(
    async (fallback) => {
      used = fallback ?? image
      const attempt = await pull(used)
      if (attempt.stderr) echo(attempt.stderr.trim())
      return attempt
    },
    image,
    { ...options, pull: async () => ({ status: 0 }) }
  )
  return { result, image: used }
}

// Runs one command and captures its output without blocking the event loop, so
// signal handling and child cleanup keep running while the command is in flight.
// A spawn failure (for example a missing executable) resolves with `error` set
// instead of rejecting, so the caller decides how to report it.
export function captureCommand(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let error
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.once('error', (spawnError) => (error = spawnError))
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr, error }))
  })
}
