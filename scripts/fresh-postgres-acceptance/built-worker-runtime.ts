// The runtime of the built-Worker desktop authorization qualification.
//
// The qualification drives the Worker that `apps/web` builds. This module owns
// everything around that: it finds the built output, proves that the output
// belongs to this checkout before it is reused, builds it when it does not,
// writes the local Worker configuration the built output describes, starts
// `wrangler dev --local` on the loopback interface with a certificate minted
// for the run, and stops it again.
//
// Nothing here reaches a hosted service. The Worker is served from the local
// build, its database is the disposable instance the qualification owns, and
// the certificate and the configuration live in a temporary directory the
// qualification removes.
//
// Every part that touches a process or a socket takes its dependency as an
// argument, so the settlement, the shutdown and the provenance rules can be
// exercised without a Worker, without a container and without a network.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { resolve } from 'node:path'

import { BuiltWorkerFailure } from './built-worker-failures'
import type { BuiltWorkerRequest, BuiltWorkerResponse } from './built-worker-desktop-auth'

/** The directory the web build writes its Worker into. */
export const BUILT_WORKER_DIRECTORY = 'apps/web/dist/server'

/** The configuration the web build writes next to the Worker. */
export const BUILT_WORKER_CONFIG = 'apps/web/dist/server/wrangler.json'

/** The stamp that records which checkout a built Worker belongs to. */
export const BUILD_PROVENANCE_FILE = 'apps/web/dist/server/built-worker-provenance.json'

/** The compatibility the built Worker runs with. */
const COMPATIBILITY = {
  compatibility_date: '2026-08-01',
  compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public', 'enable_request_signal'],
}

/** How long the Worker may take to answer its first request. */
const READINESS_TIMEOUT_MS = 120_000

/** How long one request may take before it is destroyed. */
export const REQUEST_TIMEOUT_MS = 30_000

/** How long the Worker may take to exit after it was asked to. */
export const SHUTDOWN_GRACE_MS = 10_000

/** How long the Worker may take to exit after it was killed. */
export const SHUTDOWN_KILL_MS = 5_000

/** The largest response the qualification reads. */
export const MAX_RESPONSE_BYTES = 1_048_576

/** How long the group settlement is given before it is escalated. */
export const GROUP_SETTLE_MS = 10_000

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
  /**
   * The fingerprint of the built artifact.
   *
   * It covers the entry point, the chunks it imports and the configuration it
   * was built with, not the entry point alone: a build whose chunks changed
   * is a different artifact.
   */
  readonly digest: string
  /** How many files the fingerprint covers. */
  readonly files: number
}

/** The checkout the build came from. */
export type BuiltWorkerSource = {
  readonly sha: string
  readonly dirty: boolean | null
  readonly source: string
}

/** The stamp that records which checkout a built Worker belongs to. */
export type BuildProvenance = {
  readonly sha: string
  readonly dirty: boolean | null
  readonly digest: string
  readonly builtAt: string
}

/**
 * The fingerprint of a built artifact.
 *
 * The entry point alone does not name the build: the Worker imports the
 * chunks beside it and runs with the configuration the build wrote. The
 * fingerprint therefore covers every file of the built directory and the
 * configuration itself, so a changed chunk or a changed configuration makes
 * it a different artifact.
 */
export function artifactFingerprint(input: {
  readonly directory: string
  readonly configPath: string
}): { readonly digest: string; readonly files: number } {
  const files = listFiles(input.directory).toSorted()
  const hash = createHash('sha256')
  hash.update('config\n')
  hash.update(readFileSync(input.configPath))
  for (const file of files) {
    hash.update('\nfile\n')
    hash.update(file)
    hash.update('\n')
    hash.update(readFileSync(resolve(input.directory, file)))
  }
  return { digest: hash.digest('hex'), files: files.length }
}

/** Every file of a directory, relative to it. */
function listFiles(directory: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(resolve(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...listFiles(directory, relative))
      continue
    }
    found.push(relative)
  }
  return found
}

/** The built Worker of a checkout, or null when it has not been built. */
export function builtWorkerArtifact(root: string): BuiltWorkerArtifact | null {
  const configPath = resolve(root, BUILT_WORKER_CONFIG)
  if (!existsSync(configPath)) return null
  const directory = resolve(root, BUILT_WORKER_DIRECTORY)
  let built: { main: string }
  try {
    built = JSON.parse(readFileSync(configPath, 'utf8')) as { main: string }
  } catch {
    return null
  }
  const entry = resolve(directory, built.main)
  if (!existsSync(entry)) return null
  let fingerprint: { readonly digest: string; readonly files: number }
  try {
    fingerprint = artifactFingerprint({ directory, configPath })
  } catch {
    return null
  }
  return {
    directory,
    configPath,
    digest: fingerprint.digest,
    files: fingerprint.files,
  }
}

/** The path of the provenance stamp of a checkout. */
export function buildProvenancePath(root: string): string {
  return resolve(root, BUILD_PROVENANCE_FILE)
}

/** The provenance stamp of a checkout, or null when there is none. */
export function readBuildProvenance(root: string): BuildProvenance | null {
  const path = buildProvenancePath(root)
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BuildProvenance>
    if (typeof value.sha !== 'string' || typeof value.digest !== 'string') return null
    return {
      sha: value.sha,
      dirty: typeof value.dirty === 'boolean' ? value.dirty : null,
      digest: value.digest,
      builtAt: typeof value.builtAt === 'string' ? value.builtAt : '',
    }
  } catch {
    return null
  }
}

/**
 * True when the built Worker provably belongs to this checkout.
 *
 * A build that is not stamped, a stamp that names another commit, a stamp that
 * was written for a tree that has since changed, and a stamp whose digest does
 * not match the artifact on disk all fail. The qualification then rebuilds
 * instead of qualifying an artifact it cannot place.
 */
export function verifyBuildProvenance(input: {
  readonly root: string
  readonly artifact: BuiltWorkerArtifact
  readonly source: BuiltWorkerSource
}): boolean {
  const stamp = readBuildProvenance(input.root)
  if (!stamp) return false
  // A tree that is not clean cannot be placed: the build that produced the
  // artifact may have come from a different version of the sources.
  if (input.source.dirty !== false) return false
  if (stamp.dirty !== false) return false
  if (stamp.sha !== input.source.sha) return false
  if (stamp.digest !== input.artifact.digest) return false
  return true
}

/** Records that the built Worker on disk belongs to this checkout. */
export function writeBuildProvenance(input: {
  readonly root: string
  readonly artifact: BuiltWorkerArtifact
  readonly source: BuiltWorkerSource
  readonly builtAt?: string
}): BuildProvenance {
  const stamp: BuildProvenance = {
    sha: input.source.sha,
    dirty: input.source.dirty,
    digest: input.artifact.digest,
    builtAt: input.builtAt ?? new Date().toISOString(),
  }
  const path = buildProvenancePath(input.root)
  mkdirSync(resolve(input.root, BUILT_WORKER_DIRECTORY), { recursive: true })
  writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o600 })
  return stamp
}

/**
 * Builds the web application.
 *
 * The build is the repository's own: `bun run --cwd apps/web build` produces
 * the production Worker and fails when the build fails. The qualification
 * never reports a Worker it did not build.
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
    throw new BuiltWorkerFailure('build-failed', 'the web application build failed')
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

/** The child process the local runtime runs in. */
export type WorkerChild = {
  readonly pid?: number
  readonly exitCode: number | null
  readonly stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): void }
  readonly stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): void }
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

/** The spawner the local runtime is started with. */
export type WorkerSpawner = (
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }
) => WorkerChild

/** A running built Worker. */
export type RunningBuiltWorker = {
  /** The base URL the Worker serves on. */
  readonly baseUrl: string
  /**
   * Stops the Worker and resolves once its shutdown is confirmed: the child
   * process has exited. It is safe to call more than once, and it never
   * resolves before the process is gone.
   */
  readonly stop: () => Promise<void>
  /**
   * Asks the Worker to stop without waiting for it. The interruption path
   * cannot wait, and a Worker that is never asked keeps serving from material
   * the teardown is about to remove.
   */
  readonly requestStop: () => void
  /**
   * What the Worker and the local runtime wrote while it ran. The lines are
   * redacted before they are published; the caller decides what to keep.
   */
  readonly logs: readonly string[]
}

/** How the Worker process is signalled. */
export type WorkerSignaller = (pid: number, signal: NodeJS.Signals) => void

/** The dependencies the Worker start takes, so it can be exercised offline. */
export type WorkerStartDependencies = {
  /** Starts the local runtime. */
  readonly spawn: WorkerSpawner
  /** Signals the Worker process group. */
  readonly signal: WorkerSignaller
  /** Sends one request to the Worker. */
  readonly request: (input: WorkerRequestInput) => Promise<BuiltWorkerResponse>
  /**
   * True while a process of the Worker's process group is still alive.
   *
   * The group's settlement is what matters: the local runtime leaves its own
   * children behind, and the parent's exit does not prove they are gone.
   */
  readonly groupAlive: (pid: number) => boolean
  /** The current time in milliseconds. */
  readonly now: () => number
  /** Waits for the given number of milliseconds. */
  readonly sleep: (milliseconds: number) => Promise<void>
}

/** The dependencies the real runner uses. */
export const REAL_WORKER_DEPENDENCIES: WorkerStartDependencies = {
  spawn: (args, options) =>
    spawn('bun', [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }),
  signal: (pid, signal) => {
    process.kill(-pid, signal)
  },
  request: (input) => workerRequest(input),
  groupAlive: (pid) => {
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  },
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
}

/** Starts the built Worker on the loopback interface. */
export async function startBuiltWorker(
  input: {
    readonly root: string
    readonly artifact: BuiltWorkerArtifact
    readonly config: Record<string, unknown>
    readonly configPath: string
    readonly port: number
    readonly certificatePath: string
    readonly keyPath: string
    readonly persistDirectory: string
  },
  dependencies: WorkerStartDependencies = REAL_WORKER_DEPENDENCIES
): Promise<RunningBuiltWorker> {
  mkdirSync(input.persistDirectory, { recursive: true })
  writeFileSync(input.configPath, JSON.stringify(input.config, null, 2), { mode: 0o600 })
  const baseUrl = `https://127.0.0.1:${input.port}`
  const child = dependencies.spawn(
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

  let stopping: Promise<void> | undefined
  let stopRequested = false
  let childExited = false
  /**
   * Asks the Worker to stop. The signal is sent once; the shutdown is
   * confirmed by {@link stop}.
   */
  const requestStop = (): void => {
    if (stopRequested) return
    stopRequested = true
    if (!child.pid) return
    try {
      dependencies.signal(child.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  /**
   * Stops the Worker and confirms its shutdown.
   *
   * The process group is asked to stop, and the shutdown is only complete once
   * the child has exited. A Worker that does not stop is killed, and a Worker
   * that still does not stop fails the run: the material it serves from must
   * not be removed while the process that reads it is alive.
   */
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      if (child.exitCode !== null) return
      if (!child.pid) return
      child.once('exit', () => {
        childExited = true
      })
      /**
       * True once the process group is gone.
       *
       * The parent's exit is not the group's settlement: the local runtime
       * leaves its own children behind, and the material they read must not be
       * removed while they are alive.
       */
      const groupSettled = async (): Promise<boolean> => {
        const deadline = dependencies.now() + GROUP_SETTLE_MS
        for (;;) {
          if (childExited && !dependencies.groupAlive(child.pid!)) return true
          if (dependencies.now() >= deadline) return false
          await dependencies.sleep(250)
        }
      }
      const signal = (value: NodeJS.Signals): void => {
        try {
          dependencies.signal(child.pid!, value)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      requestStop()
      signal('SIGTERM')
      if (await groupSettled()) return
      signal('SIGKILL')
      if (await groupSettled()) return
      throw new BuiltWorkerFailure(
        'worker-stop-failed',
        'the built Worker did not exit after it was stopped'
      )
    })().catch((error: unknown) => {
      // A stop that failed is not cached: a later stop tries again, because
      // the Worker may have exited in the meantime.
      stopping = undefined
      throw error
    })
    return stopping
  }

  return { baseUrl, stop, requestStop, logs }
}

/**
 * Waits until the built Worker answers a request.
 *
 * The Worker handle is the caller's already: a run that fails here still owns
 * a running Worker, and the teardown must be able to stop it and to keep its
 * material.
 */
export async function waitForWorkerReady(
  input: {
    readonly worker: RunningBuiltWorker
    readonly certificatePath: string
  },
  dependencies: WorkerStartDependencies = REAL_WORKER_DEPENDENCIES
): Promise<void> {
  const deadline = dependencies.now() + READINESS_TIMEOUT_MS
  for (;;) {
    try {
      const response = await dependencies.request({
        baseUrl: input.worker.baseUrl,
        certificatePath: input.certificatePath,
        request: { method: 'GET', path: '/api/web-entry' },
      })
      if (response.status > 0) return
    } catch {
      // The Worker is not listening yet.
    }
    if (dependencies.now() >= deadline) {
      // The Worker is stopped, but a stop that fails does not replace the
      // reason the readiness failed: the run failed because the Worker did not
      // answer, and the stop failure is its cause.
      let stopFailure: unknown
      try {
        await input.worker.stop()
      } catch (error) {
        stopFailure = error
      }
      throw new BuiltWorkerFailure(
        'worker-start-failed',
        'the built Worker did not answer in time',
        { cause: stopFailure }
      )
    }
    await dependencies.sleep(500)
  }
}

/** One request against the running Worker. */
export type WorkerRequestInput = {
  readonly baseUrl: string
  readonly certificatePath: string
  readonly request: BuiltWorkerRequest
}

/** The response handle the settlement logic reads. */
export type ResponseHandle = {
  readonly statusCode?: number
  readonly headers: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'aborted', listener: () => void): void
  on(event: 'close', listener: () => void): void
}

/** The request handle the settlement logic drives. */
export type RequestHandle = {
  write(chunk: string): void
  end(): void
  destroy(error: Error): void
  once(event: 'error', listener: (error: Error) => void): void
}

/** The factory that opens one request. */
export type RequestFactory = (
  url: string,
  options: { method: string; headers: Record<string, string>; ca: string },
  onResponse: (response: ResponseHandle) => void
) => RequestHandle

/** The real request factory. */
export const HTTPS_REQUEST_FACTORY: RequestFactory = (url, options, onResponse) =>
  httpsRequest(url, options, (response) => {
    onResponse(response as unknown as ResponseHandle)
  }) as unknown as RequestHandle

/**
 * Sends one request to the running Worker and returns its answer.
 *
 * The settlement is bounded and complete: the request is destroyed when it
 * takes too long, and an error, an aborted response or a response that closes
 * before it ends all settle the promise. A request that never settles would
 * hang the qualification instead of failing it.
 */
export function workerRequest(
  input: WorkerRequestInput,
  options: {
    readonly requester?: RequestFactory
    readonly timeoutMs?: number
    readonly certificate?: string
  } = {}
): Promise<BuiltWorkerResponse> {
  const factory = options.requester ?? HTTPS_REQUEST_FACTORY
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const headers: Record<string, string> = { ...input.request.headers }
  if (input.request.body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(input.request.body))
  }
  const certificate = options.certificate ?? readFileSync(input.certificatePath, 'utf8')
  return new Promise<BuiltWorkerResponse>((ok, fail) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      complete()
    }
    const handle = factory(
      `${input.baseUrl}${input.request.path}`,
      { method: input.request.method, headers, ca: certificate },
      (response) => {
        const chunks: Buffer[] = []
        let ended = false
        let received = 0
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > MAX_RESPONSE_BYTES) {
            // The response is larger than the qualification reads. The request
            // is destroyed and the promise settles: an unbounded body would
            // grow the evidence without bound.
            try {
              handle.destroy(new Error('the response was too large'))
            } catch {
              // The request is already gone.
            }
            settle(() => fail(new Error('the response was too large')))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          ended = true
          settle(() => {
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
        })
        response.on('error', () => {
          settle(() => fail(new Error('the response failed')))
        })
        response.on('aborted', () => {
          settle(() => fail(new Error('the response was aborted')))
        })
        response.on('close', () => {
          if (ended) return
          settle(() => fail(new Error('the response closed before it ended')))
        })
      }
    )
    handle.once('error', (error) => {
      settle(() => fail(error))
    })
    timer = setTimeout(() => {
      const error = new Error('the request timed out')
      try {
        handle.destroy(error)
      } catch {
        // The request is already gone.
      }
      settle(() => fail(error))
    }, timeoutMs)
    if (input.request.body !== undefined) handle.write(input.request.body)
    handle.end()
  })
}

/**
 * Removes what the run owns, after the Worker process is gone.
 *
 * The Worker is stopped first and its shutdown is confirmed. The container is
 * removed either way, because the instance is disposable and nothing else
 * needs it. The runtime material is removed only when the Worker is gone: the
 * files it serves from must not disappear while the process that reads them is
 * still alive.
 */
export async function tearDownAfterWorker(input: {
  readonly worker?: Pick<RunningBuiltWorker, 'stop' | 'requestStop'> | undefined
  readonly removeContainer: () => void
  readonly removeMaterial: () => void
  readonly onFailure?: (message: string) => void
}): Promise<{
  readonly workerStopped: boolean
  readonly containerRemoved: boolean
  readonly materialRemoved: boolean
  readonly stopError?: unknown
}> {
  let workerStopped = true
  let stopError: unknown
  if (input.worker) {
    try {
      await input.worker.stop()
    } catch (error) {
      workerStopped = false
      stopError = error
      input.onFailure?.('the built Worker did not exit; its runtime material was kept')
    }
  }
  let containerRemoved = false
  let containerError: unknown
  try {
    input.removeContainer()
    containerRemoved = true
  } catch (error) {
    containerError = error
  }
  if (workerStopped) {
    input.removeMaterial()
    if (containerError !== undefined) throw containerError
    return { workerStopped, containerRemoved, materialRemoved: true, stopError }
  }
  input.worker?.requestStop()
  if (containerError !== undefined) throw containerError
  return { workerStopped, containerRemoved, materialRemoved: false, stopError }
}

/**
 * True when the receipt may be published.
 *
 * A receipt that claims a pass must not be published while the Worker is still
 * running or while the material it served from is still there. The verdict is
 * the teardown's own report of what it removed.
 */
export function mayPublishReceipt(input: {
  readonly verdict: {
    readonly workerStopped: boolean
    readonly containerRemoved: boolean
    readonly materialRemoved: boolean
  }
  readonly cleanupFailed: boolean
}): boolean {
  if (input.cleanupFailed) return false
  return input.verdict.workerStopped && input.verdict.materialRemoved
}

/**
 * The transport the qualification drives the Worker through.
 *
 * The Worker closes its per-request database connection when the request ends.
 * Opening the next connection in the same instant can inherit a socket that the
 * previous close reset, and the Worker then answers with a transport error
 * instead of a response. The qualification therefore spaces its requests. The
 * assertions are proved against the responses the Worker produced; a step
 * that never received one is never counted as a refusal.
 */
export function workerTransport(input: {
  readonly baseUrl: string
  readonly certificatePath: string
  readonly spacingMs?: number
  readonly requester?: RequestFactory
  readonly timeoutMs?: number
}): (request: BuiltWorkerRequest) => Promise<BuiltWorkerResponse> {
  const spacing = input.spacingMs ?? 1_500
  let last = 0
  return async (request) => {
    const wait = spacing - (Date.now() - last)
    if (wait > 0) await new Promise((done) => setTimeout(done, wait))
    const response = await workerRequest(
      {
        baseUrl: input.baseUrl,
        certificatePath: input.certificatePath,
        request,
      },
      { requester: input.requester, timeoutMs: input.timeoutMs }
    )
    last = Date.now()
    return response
  }
}
