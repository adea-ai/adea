import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildProvenancePath,
  builtWorkerArtifact,
  readBuildProvenance,
  startBuiltWorker,
  tearDownAfterWorker,
  verifyBuildProvenance,
  workerRequest,
  writeBuildProvenance,
  type RequestFactory,
  type RequestHandle,
  type ResponseHandle,
  type WorkerChild,
} from './built-worker-runtime'

/** A response the test drives. */
class FakeResponse extends EventEmitter implements ResponseHandle {
  statusCode = 200
  headers: Record<string, string | string[] | undefined> = {}
}

/** A request the test drives. */
class FakeRequest extends EventEmitter implements RequestHandle {
  destroyed: Error | undefined
  readonly written: string[] = []
  write(chunk: string): void {
    this.written.push(chunk)
  }
  end(): void {}
  destroy(error: Error): void {
    this.destroyed = error
  }
}

/** A certificate file the request reads. */
function certificateFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'adea-worker-cert-'))
  const path = join(directory, 'server.crt')
  writeFileSync(path, '-----BEGIN CERTIFICATE-----\n')
  return path
}

const REQUEST = {
  baseUrl: 'https://127.0.0.1:8790',
  certificatePath: certificateFile(),
  request: { method: 'GET' as const, path: '/api/web-entry' },
}

function buildFixture(): {
  readonly root: string
  readonly source: {
    readonly sha: string
    readonly dirty: boolean | null
    readonly source: string
  }
} {
  const root = mkdtempSync(join(tmpdir(), 'adea-worker-build-'))
  mkdirSync(join(root, 'apps/web/dist/server'), { recursive: true })
  writeFileSync(
    join(root, 'apps/web/dist/server/wrangler.json'),
    JSON.stringify({ main: 'index.js', assets: { directory: '../client' } })
  )
  writeFileSync(join(root, 'apps/web/dist/server/index.js'), 'export default {}')
  return {
    root,
    source: { sha: 'a'.repeat(40), dirty: false, source: 'main' },
  }
}

describe('the built-Worker request settlement', () => {
  test('a request that never answers is destroyed and settles', async () => {
    const request = new FakeRequest()
    const factory: RequestFactory = () => request
    const promise = workerRequest(REQUEST, { requester: factory, timeoutMs: 25 })
    await expect(promise).rejects.toThrow(/timed out/u)
    expect(request.destroyed?.message).toBe('the request timed out')
  })

  test('a response that fails settles the request', async () => {
    const response = new FakeResponse()
    const factory: RequestFactory = (_url, _options, onResponse) => {
      queueMicrotask(() => {
        onResponse(response)
        response.emit('error', new Error('the socket broke'))
      })
      return new FakeRequest()
    }
    await expect(workerRequest(REQUEST, { requester: factory })).rejects.toThrow(
      /the response failed/u
    )
  })

  test('a response that is aborted settles the request', async () => {
    const response = new FakeResponse()
    const factory: RequestFactory = (_url, _options, onResponse) => {
      queueMicrotask(() => {
        onResponse(response)
        response.emit('aborted')
      })
      return new FakeRequest()
    }
    await expect(workerRequest(REQUEST, { requester: factory })).rejects.toThrow(
      /the response was aborted/u
    )
  })

  test('a response that closes before it ends settles the request', async () => {
    const response = new FakeResponse()
    const factory: RequestFactory = (_url, _options, onResponse) => {
      queueMicrotask(() => {
        onResponse(response)
        response.emit('close')
      })
      return new FakeRequest()
    }
    await expect(workerRequest(REQUEST, { requester: factory })).rejects.toThrow(
      /the response closed before it ended/u
    )
  })

  test('a response that ends resolves the request', async () => {
    const response = new FakeResponse()
    const factory: RequestFactory = (_url, _options, onResponse) => {
      queueMicrotask(() => {
        onResponse(response)
        response.emit('data', Buffer.from('{"ok":true}'))
        response.emit('end')
      })
      return new FakeRequest()
    }
    const answered = await workerRequest(REQUEST, { requester: factory })
    expect(answered.status).toBe(200)
    expect(answered.body).toBe('{"ok":true}')
  })
})

/** A child process the test drives. */
class FakeChild extends EventEmitter implements WorkerChild {
  pid = 4242
  exitCode: number | null = null
  readonly signals: NodeJS.Signals[] = []

  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this {
    return super.once(event, listener) as this
  }

  exit(code = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

describe('the built-Worker shutdown', () => {
  test('the stop confirms the shutdown before it resolves', async () => {
    const child = new FakeChild()
    const signals: NodeJS.Signals[] = []
    const directory = mkdtempSync(join(tmpdir(), 'adea-worker-runtime-'))
    try {
      const worker = await startBuiltWorker(
        {
          root: directory,
          artifact: {
            directory,
            configPath: join(directory, 'wrangler.json'),
            digest: 'digest',
          },
          config: {},
          configPath: join(directory, 'worker.json'),
          port: 8791,
          certificatePath: certificateFile(),
          keyPath: join(directory, 'server.key'),
          persistDirectory: join(directory, 'state'),
        },
        {
          spawn: () => child,
          signal: (_pid, signal) => {
            signals.push(signal)
          },
          request: async () => ({ status: 200, headers: {}, body: '' }),
          now: () => Date.now(),
          sleep: (milliseconds) =>
            new Promise((done) => setTimeout(done, Math.min(milliseconds, 200))),
        }
      )
      let exited = false
      const stopped = worker.stop().then(() => {
        // The stop resolves only after the child is gone.
        expect(exited).toBe(true)
      })
      // The child exits a moment after it is signalled, exactly as a real
      // Worker does.
      setTimeout(() => {
        exited = true
        child.exit(0)
      }, 20)
      await stopped
      expect(exited).toBe(true)
      expect(signals).toContain('SIGTERM')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a Worker that does not exit fails the stop', async () => {
    const child = new FakeChild()
    const directory = mkdtempSync(join(tmpdir(), 'adea-worker-runtime-'))
    try {
      const worker = await startBuiltWorker(
        {
          root: directory,
          artifact: {
            directory,
            configPath: join(directory, 'wrangler.json'),
            digest: 'digest',
          },
          config: {},
          configPath: join(directory, 'worker.json'),
          port: 8792,
          certificatePath: certificateFile(),
          keyPath: join(directory, 'server.key'),
          persistDirectory: join(directory, 'state'),
        },
        {
          spawn: () => child,
          signal: () => undefined,
          request: async () => ({ status: 200, headers: {}, body: '' }),
          now: () => Date.now(),
          sleep: async () => undefined,
        }
      )
      await expect(worker.stop()).rejects.toThrow(/worker-stop-failed/u)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the runtime material is removed only after the Worker is gone', async () => {
    const order: string[] = []
    const teardown = await tearDownAfterWorker({
      worker: {
        stop: async () => {
          order.push('stopped')
        },
        requestStop: () => order.push('asked to stop'),
      },
      removeContainer: () => order.push('container removed'),
      removeMaterial: () => order.push('material removed'),
    })
    expect(teardown.workerStopped).toBe(true)
    expect(order).toEqual(['stopped', 'container removed', 'material removed'])
  })

  test('a Worker that did not exit keeps its runtime material', async () => {
    const order: string[] = []
    const teardown = await tearDownAfterWorker({
      worker: {
        stop: async () => {
          throw new Error('the Worker did not exit')
        },
        requestStop: () => order.push('asked to stop'),
      },
      removeContainer: () => order.push('container removed'),
      removeMaterial: () => order.push('material removed'),
    })
    expect(teardown.workerStopped).toBe(false)
    expect(order).toEqual(['container removed', 'asked to stop'])
  })
})

describe('the built-Worker artifact provenance', () => {
  test('a build without a stamp is not reused', () => {
    const { root, source } = buildFixture()
    try {
      const artifact = builtWorkerArtifact(root)
      expect(artifact).not.toBeNull()
      expect(verifyBuildProvenance({ root, artifact: artifact!, source })).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a stamp that names this checkout is reused', () => {
    const { root, source } = buildFixture()
    try {
      const artifact = builtWorkerArtifact(root)!
      writeBuildProvenance({ root, artifact, source })
      expect(verifyBuildProvenance({ root, artifact, source })).toBe(true)
      expect(readBuildProvenance(root)?.digest).toBe(artifact.digest)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a stamp that names another commit is refused', () => {
    const { root, source } = buildFixture()
    try {
      const artifact = builtWorkerArtifact(root)!
      writeBuildProvenance({ root, artifact, source })
      const other = { ...source, sha: 'b'.repeat(40) }
      expect(verifyBuildProvenance({ root, artifact, source: other })).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a stamp written for a tree that changed is refused', () => {
    const { root, source } = buildFixture()
    try {
      const artifact = builtWorkerArtifact(root)!
      writeBuildProvenance({ root, artifact, source })
      const changed = { ...source, dirty: true }
      expect(verifyBuildProvenance({ root, artifact, source: changed })).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a stamp whose digest does not match the artifact is refused', () => {
    const { root, source } = buildFixture()
    try {
      const artifact = builtWorkerArtifact(root)!
      writeBuildProvenance({ root, artifact, source })
      writeFileSync(join(root, 'apps/web/dist/server/index.js'), 'export default { changed: true }')
      const rebuilt = builtWorkerArtifact(root)!
      expect(verifyBuildProvenance({ root, artifact: rebuilt, source })).toBe(false)
      expect(buildProvenancePath(root)).toContain('built-worker-provenance.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
