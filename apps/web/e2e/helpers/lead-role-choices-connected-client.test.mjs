import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test } from 'bun:test'
import { startConnectedFixtureChild } from './lead-role-choices-connected-client.mjs'
import { safeTransportFailureDiagnostic } from './lead-role-choices-connected-process.mjs'

const children = new Set()

class FixtureChild extends EventEmitter {
  constructor({ onKill, onCommand } = {}) {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.stdin = new PassThrough()
    this.stdin.write = (chunk, callback) => {
      try {
        onCommand?.(JSON.parse(String(chunk).trim()))
        callback?.()
        return true
      } catch (error) {
        callback?.(error)
        return false
      }
    }
    this.exitCode = null
    this.signalCode = null
    this.signals = []
    this.closed = false
    this.onKill = onKill
  }

  kill(signal) {
    this.signals.push(signal)
    this.onKill?.(signal, this)
    return true
  }

  finish(code = 0, signal = null) {
    if (this.closed) return
    this.closed = true
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    this.stdin.end()
    this.emit('close', code, signal)
  }
}

function successfulReadyRecord() {
  return {
    schemaVersion: 'adea-connected-role-fixture/v1',
    baseUrl: 'http://127.0.0.1:32123',
    workspaceId: 'workspace-fixture',
    channelId: 'channel-fixture',
    credential: 'synthetic-fixture-credential',
  }
}

function spawnOwned(child, beforeReturn = () => {}) {
  return () => {
    children.add(child)
    beforeReturn(child)
    return child
  }
}

afterEach(() => {
  for (const child of children) child.finish(-1, 'SIGKILL')
  children.clear()
})

test('transport failure diagnostics retain timeout classes and codes without error text', () => {
  const cause = Object.assign(new Error('credential-canary-cause'), { code: 'SECRET_TOKEN' })
  const error = Object.assign(new Error('provider-prompt-canary'), {
    code: 'ETIMEDOUT',
    cause,
  })
  const timeoutReason = new DOMException('private timeout detail', 'TimeoutError')
  const signal = AbortSignal.abort(timeoutReason)
  const diagnostic = safeTransportFailureDiagnostic(error, signal, 5_012.4)

  expect(diagnostic).toEqual({
    elapsedMs: 5012,
    errorClass: 'Error',
    signalAborted: true,
    errorCode: 'ETIMEDOUT',
    signalReasonClass: 'TimeoutError',
    causeClass: 'Error',
  })
  expect(JSON.stringify(diagnostic)).not.toContain('credential-canary')
  expect(JSON.stringify(diagnostic)).not.toContain('provider-prompt-canary')
  expect(JSON.stringify(diagnostic)).not.toContain('SECRET_TOKEN')
})

test('transport failure diagnostics bound elapsed time and unknown error identity', () => {
  const error = Object.assign(new Error('secret diagnostic string'), {
    code: 'secret-value',
  })
  const diagnostic = safeTransportFailureDiagnostic(error, undefined, 999_999)

  expect(diagnostic).toEqual({
    elapsedMs: 180_000,
    errorClass: 'Error',
    signalAborted: false,
  })
  expect(JSON.stringify(diagnostic)).not.toContain('secret')
})

test('missing executable spawn error is sanitized and reaped before startup rejects', async () => {
  const child = new FixtureChild()
  children.add(child)
  const error = Object.assign(new Error('credential-canary must not escape'), { code: 'ENOENT' })
  child.onKill = (signal, owned) => {
    if (signal === 'SIGTERM') setTimeout(() => owned.finish(null, signal), 1)
  }

  const starting = startConnectedFixtureChild({
    bun: '/missing/test-fixture-bun',
    cwd: '/tmp',
    env: {},
    spawnProcess: spawnOwned(child, () => {
      queueMicrotask(() => child.emit('error', error))
    }),
    startupTimeoutMs: 20,
  })

  const rejection = await starting.catch((caught) => caught)
  expect(rejection.message).toContain('HOST_BINARY_MISSING')
  expect(rejection.message).not.toContain('credential-canary')
  expect(child.closed).toBe(true)
  expect(child.signals).toEqual(['SIGTERM'])
})

test('permission error is sanitized and startup awaits child close', async () => {
  const child = new FixtureChild({
    onKill: (signal, owned) => {
      if (signal === 'SIGTERM') setTimeout(() => owned.finish(null, signal), 1)
    },
  })
  const error = Object.assign(new Error('path-canary'), { code: 'EACCES' })
  const starting = startConnectedFixtureChild({
    bun: '/fixture/not-executable',
    cwd: '/tmp',
    env: {},
    spawnProcess: spawnOwned(child, () => queueMicrotask(() => child.emit('error', error))),
    startupTimeoutMs: 20,
  })

  await expect(starting).rejects.toThrow('HOST_BINARY_NOT_EXECUTABLE')
  expect(child.closed).toBe(true)
  expect(child.signals).toEqual(['SIGTERM'])
})

test('startup timeout rejects once and reaps the unresponsive child', async () => {
  const child = new FixtureChild({
    onKill: (signal, owned) => {
      if (signal === 'SIGKILL') {
        setTimeout(() => {
          owned.stdout.write(`${JSON.stringify(successfulReadyRecord())}\n`)
          owned.finish(null, signal)
        }, 1)
      }
    },
  })
  const starting = startConnectedFixtureChild({
    bun: '/fixture/hung-before-ready',
    cwd: '/tmp',
    env: {},
    spawnProcess: spawnOwned(child),
    startupTimeoutMs: 5,
    terminateWaitMs: 5,
    reapWaitMs: 30,
  })

  await expect(starting).rejects.toThrow('CONNECTED_FIXTURE_START_TIMEOUT')
  expect(child.closed).toBe(true)
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
})

test('invalid ready record reaps the child instead of calling a nonexistent close method', async () => {
  const child = new FixtureChild({
    onKill: (signal, owned) => {
      if (signal === 'SIGTERM') setTimeout(() => owned.finish(null, signal), 1)
    },
  })
  const starting = startConnectedFixtureChild({
    bun: '/fixture/invalid-ready',
    cwd: '/tmp',
    env: {},
    spawnProcess: spawnOwned(child, (owned) =>
      queueMicrotask(() =>
        owned.stdout.write('{"schemaVersion":"adea-connected-role-fixture/v1"}\n')
      )
    ),
    terminateWaitMs: 30,
  })

  await expect(starting).rejects.toThrow('CONNECTED_FIXTURE_INVALID_READY_RECORD')
  expect(child.closed).toBe(true)
  expect(child.signals).toEqual(['SIGTERM'])
})

test('post-start error rejects pending controls and reaps the owned child', async () => {
  const child = new FixtureChild({
    onKill: (signal, owned) => {
      if (signal === 'SIGTERM') setTimeout(() => owned.finish(null, signal), 1)
    },
  })
  const fixture = await startConnectedFixtureChild({
    bun: '/fixture/ready',
    cwd: '/tmp',
    env: {},
    spawnProcess: spawnOwned(child, (owned) =>
      queueMicrotask(() => owned.stdout.write(`${JSON.stringify(successfulReadyRecord())}\n`))
    ),
  })
  const pendingEvidence = fixture.evidence()

  child.emit('error', Object.assign(new Error('post-start-canary'), { code: 'EPIPE' }))
  // A second asynchronous process error must stay inside the safe boundary.
  child.emit('error', Object.assign(new Error('second-canary'), { code: 'EIO' }))

  await expect(pendingEvidence).rejects.toThrow('CONNECTED_FIXTURE_CONTROL_FAILED')
  await fixture.close()
  expect(child.closed).toBe(true)
  expect(child.signals).toEqual(['SIGTERM'])
})

test('close awaits confirmed exit after SIGKILL escalation', async () => {
  const child = new FixtureChild({
    onKill: (signal, owned) => {
      if (signal === 'SIGKILL') setTimeout(() => owned.finish(null, signal), 20)
    },
  })
  const fixture = await startConnectedFixtureChild({
    bun: '/fixture/ignores-close',
    cwd: '/tmp',
    env: {},
    spawnProcess: spawnOwned(child, (owned) =>
      queueMicrotask(() => owned.stdout.write(`${JSON.stringify(successfulReadyRecord())}\n`))
    ),
    controlTimeoutMs: 5,
    closeCommandTimeoutMs: 5,
    closeWaitMs: 5,
    terminateWaitMs: 5,
    reapWaitMs: 100,
  })

  await fixture.close()

  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(child.closed).toBe(true)
})
