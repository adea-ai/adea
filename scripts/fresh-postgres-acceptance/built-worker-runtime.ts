// The runtime of the built-Worker desktop authorization qualification.
//
// The qualification drives the Worker that `apps/web` builds. This module owns
// everything around that: it finds the built output, builds it when it is
// missing, writes the local Worker configuration the built output describes,
// starts `wrangler dev --local` on the loopback interface with a certificate
// minted for the run, and stops it again.
//
// Nothing here reaches a hosted service. The Worker is served from the local
// build, its database is the disposable instance the qualification owns, and
// the certificate and the configuration live in a temporary directory the
// qualification removes.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'

import type { BuiltWorkerRequest, BuiltWorkerResponse } from './built-worker-desktop-auth'

/** The directory the web build writes its Worker into. */
export const BUILT_WORKER_DIRECTORY = 'apps/web/dist/server'

/** The configuration the web build writes next to the Worker. */
export const BUILT_WORKER_CONFIG = 'apps/web/dist/server/wrangler.json'

/** The compatibility the built Worker runs with. */
const COMPATIBILITY = {
  compatibility_date: '2026-08-01',
  compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public', 'enable_request_signal'],
}

/** How long the Worker may take to answer its first request. */
const READINESS_TIMEOUT_MS = 120_000

/**
 * The built Worker this qualification runs against.
 *
 * The digest names the artifact the receipt reports: the qualification proves
 * the routes of one build, not of whatever the checkout may produce later.
 */
export type BuiltWorkerArtifact = {
  /** The directory the Worker and its assets live in. */
  readonly directory: string
  /** The path of the built Worker configuration. */
  readonly configPath: string
  /** The digest of the built entry point. */
  readonly digest: string
}

/** The built Worker of a checkout, or null when it has not been built. */
export function builtWorkerArtifact(root: string): BuiltWorkerArtifact | null {
  const configPath = resolve(root, BUILT_WORKER_CONFIG)
  if (!existsSync(configPath)) return null
  const directory = resolve(root, BUILT_WORKER_DIRECTORY)
  const built = JSON.parse(readFileSync(configPath, 'utf8')) as {
    main: string
    assets: { directory: string }
  }
  const entry = resolve(directory, built.main)
  if (!existsSync(entry)) return null
  return {
    directory,
    configPath,
    digest: createHash('sha256').update(readFileSync(entry)).digest('hex'),
  }
}

/**
 * Builds the web application when its Worker has not been built yet.
 *
 * The build is the repository's own: `bun run --cwd apps/web build` produces
 * the production Worker and fails when the build fails. The qualification never
 * reports a Worker it did not build.
 */
export function buildBuiltWorker(root: string): void {
  const result = spawnSync('bun', ['run', '--cwd', 'apps/web', 'build'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 1_800_000,
    killSignal: 'SIGKILL',
  })
  if (result.error || result.status !== 0) {
    throw new Error('building the web application failed; the qualification cannot run')
  }
}

/** The configuration the local Worker runs with. */
export type LocalWorkerConfigInput = {
  /** The built Worker the configuration describes. */
  readonly artifact: BuiltWorkerArtifact
  /** The base URL the Worker serves on. */
  readonly baseUrl: string
  /** The runtime URL of the application database. */
  readonly databaseUrl: string
  /** The runtime URL of the provider schema. */
  readonly authDatabaseUrl: string
  /** The secret the self-hosted auth service signs with. */
  readonly authSecret: string
}

/**
 * The local Worker configuration.
 *
 * It is built from the configuration the web build wrote, so the Worker that
 * runs is the Worker the build produced. The Hyperdrive binding is left out on
 * purpose: the app resolves its connection from that binding when it is
 * present, and the local emulation of the hosted pooler is not the pooler the
 * hosted Worker talks to. The qualification therefore drives the app's direct
 * connection path against the disposable instance it owns.
 */
export function buildLocalWorkerConfig(input: LocalWorkerConfigInput): Record<string, unknown> {
  const built = JSON.parse(readFileSync(input.artifact.configPath, 'utf8')) as {
    main: string
    rules: unknown
    assets: { directory: string } & Record<string, unknown>
  }
  return {
    ...COMPATIBILITY,
    name: 'adea-built-worker-desktop-auth',
    main: resolve(input.artifact.directory, built.main),
    rules: built.rules,
    no_bundle: true,
    assets: {
      ...built.assets,
      directory: resolve(input.artifact.directory, built.assets.directory),
    },
    vars: {
      DATABASE_URL: input.databaseUrl,
      AUTH_BASE_URL: input.baseUrl,
      AUTH_DATABASE_URL: input.authDatabaseUrl,
      AUTH_EMAIL_VERIFICATION_REQUIRED: 'false',
      AUTH_SECRET: input.authSecret,
      AUTH_SECURE_COOKIES: 'true',
      AUTH_TRUSTED_ORIGINS: input.baseUrl,
    },
  }
}

/** A running built Worker. */
export type RunningBuiltWorker = {
  /** The base URL the Worker serves on. */
  readonly baseUrl: string
  /** Stops the Worker. It is safe to call more than once. */
  readonly stop: () => void
  /**
   * What the Worker and the local runtime wrote while it ran. The lines are
   * kept for the failure evidence; the caller decides what to publish.
   */
  readonly logs: readonly string[]
}

/** Starts the built Worker on the loopback interface. */
export async function startBuiltWorker(input: {
  readonly root: string
  readonly artifact: BuiltWorkerArtifact
  readonly config: Record<string, unknown>
  readonly configPath: string
  readonly port: number
  readonly certificatePath: string
  readonly keyPath: string
  readonly persistDirectory: string
}): Promise<RunningBuiltWorker> {
  mkdirSync(input.persistDirectory, { recursive: true })
  writeFileSync(input.configPath, JSON.stringify(input.config, null, 2), { mode: 0o600 })
  const baseUrl = `https://127.0.0.1:${input.port}`
  const child = spawn(
    'bun',
    [
      'x',
      'wrangler',
      'dev',
      '--local',
      '--config',
      input.configPath,
      '--port',
      String(input.port),
      '--inspector-port',
      String(input.port + 1),
      '--persist-to',
      input.persistDirectory,
      '--local-protocol',
      'https',
      '--https-cert-path',
      input.certificatePath,
      '--https-key-path',
      input.keyPath,
    ],
    {
      cwd: resolve(input.root, 'apps/web'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  )
  // The Worker's own output is kept for the failure evidence. The lines are
  // truncated, so a long line cannot grow the evidence without bound.
  const logs: string[] = []
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      logs.push(line.slice(0, 500))
      if (logs.length > 200) logs.shift()
    }
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (!child.pid) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  const deadline = Date.now() + READINESS_TIMEOUT_MS
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error('the built Worker stopped before it answered a request')
    }
    try {
      const response = await workerRequest({
        baseUrl,
        certificatePath: input.certificatePath,
        request: { method: 'GET', path: '/api/web-entry' },
      })
      if (response.status > 0) break
    } catch {
      // The Worker is not listening yet.
    }
    if (Date.now() >= deadline) {
      stop()
      throw new Error('the built Worker did not answer a request in time')
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  return { baseUrl, stop, logs }
}

/** One request against the running Worker. */
export type WorkerRequestInput = {
  readonly baseUrl: string
  readonly certificatePath: string
  readonly request: BuiltWorkerRequest
}

/** Sends one request to the running Worker and returns its answer. */
export function workerRequest(input: WorkerRequestInput): Promise<BuiltWorkerResponse> {
  const headers: Record<string, string> = { ...input.request.headers }
  if (input.request.body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(input.request.body))
  }
  return new Promise((ok, fail) => {
    const call = httpsRequest(
      `${input.baseUrl}${input.request.path}`,
      {
        method: input.request.method,
        headers,
        ca: readFileSync(input.certificatePath, 'utf8'),
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const normalized: Record<string, string> = {}
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
          }
          ok({
            status: response.statusCode ?? 0,
            headers: normalized,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      }
    )
    call.once('error', fail)
    if (input.request.body !== undefined) call.write(input.request.body)
    call.end()
  })
}

/**
 * The transport the qualification drives the Worker through.
 *
 * The Worker closes its per-request database connection when the request ends.
 * Opening the next connection in the same instant can inherit a socket that the
 * previous close reset, and the Worker then answers with a transport error
 * instead of a response. The qualification therefore spaces its requests. The
 * assertions are proved against the responses the Worker produced; a step
 * that never received one is retried with fresh material, never counted as a
 * refusal.
 */
export function workerTransport(input: {
  readonly baseUrl: string
  readonly certificatePath: string
  readonly spacingMs?: number
}): (request: BuiltWorkerRequest) => Promise<BuiltWorkerResponse> {
  const spacing = input.spacingMs ?? 1_500
  let last = 0
  return async (request) => {
    const wait = spacing - (Date.now() - last)
    if (wait > 0) await new Promise((done) => setTimeout(done, wait))
    const response = await workerRequest({
      baseUrl: input.baseUrl,
      certificatePath: input.certificatePath,
      request,
    })
    last = Date.now()
    return response
  }
}
