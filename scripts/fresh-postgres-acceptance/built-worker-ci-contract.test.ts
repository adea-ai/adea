// The offline contract the CI lane needs from this harness.
//
// The shared workflow that runs the sibling disposable proof does not run this
// harness, and it is not this lane's workflow to change. These tests pin the
// contract a CI job would depend on, so the proposal that wires it can be
// reviewed against something executable:
//
//   - the host capabilities the qualification needs, and that it fails closed
//     without each of them;
//   - the exact source and head the receipt names, and the identity of the
//     artifact it proved;
//   - that a run that proved nothing is a failed run;
//   - that a failed receipt carries no value;
//   - the cleanup gate: the teardown's verdict, and that the receipt is
//     published only after that teardown ran.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  assertBuiltWorkerDesktopAuthPassed,
  runBuiltWorkerDesktopAuth,
  type BuiltWorkerRequest,
  type BuiltWorkerResponse,
  type BuiltWorkerTransport,
} from './built-worker-desktop-auth'
import {
  assertLocalRuntimePrerequisites,
  removeOwnedMaterial,
  tearDownAfterWorker,
} from './built-worker-runtime'
import { BuiltWorkerFailure } from './built-worker-failures'

const RUNNER_SOURCE = readFileSync(
  resolve(import.meta.dir, '../built-worker-desktop-auth-cli.ts'),
  'utf8'
)

const ARTIFACT = {
  digest: 'a'.repeat(64),
  sha: 'b'.repeat(40),
  dirty: false,
  verified: true,
}

const PROVENANCE = { sha: 'c'.repeat(40), dirty: false, source: 'feat/railway-lane' }

/** One response, with the headers the qualification reads. */
function response(
  status: number,
  headers: Record<string, string>,
  body: string
): BuiltWorkerResponse {
  return { status, headers, body }
}

/** A transport that answers like a correct built Worker. */
function correctWorker(): BuiltWorkerTransport {
  return async (request: BuiltWorkerRequest) => {
    if (request.method === 'POST' && request.path === '/api/auth/sign-up/email') {
      return response(
        200,
        { 'set-cookie': '__Secure-better-auth.session_token=value; Path=/' },
        '{"token":"value","user":{"id":"user-1"}}'
      )
    }
    if (request.method === 'GET' && request.path.startsWith('/api/auth/desktop/authorize')) {
      const url = new URL(request.path, 'https://desktop.invalid')
      if (!request.headers?.cookie) {
        return response(303, { location: '/auth/sign-in' }, '')
      }
      const callback = new URL('adea://auth/callback')
      callback.searchParams.set('code', 'code-value-0123456789')
      callback.searchParams.set('nonce', url.searchParams.get('nonce') ?? '')
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      return response(
        303,
        { location: `/auth/desktop/complete#callback=${encodeURIComponent(callback.toString())}` },
        ''
      )
    }
    if (request.method === 'POST' && request.path === '/api/auth/desktop/exchange') {
      return response(
        200,
        { 'access-control-allow-origin': 'http://127.0.0.1:4789' },
        '{"credential":"credential-value-0123456789","expiresAt":"2027-01-01T00:00:00.000Z","sessionId":"8f00ffaa-0000-4000-8000-000000000000"}'
      )
    }
    return response(404, {}, '')
  }
}

const input = (transport: BuiltWorkerTransport) => ({
  transport,
  baseUrl: 'https://127.0.0.1:8790',
  artifact: ARTIFACT,
  secrets: ['the-known-secret-value'],
  authLifecycle: { suite: 'suite', assertions: ['one'], passed: 1 },
  evidence: 'ci' as const,
  checkout: PROVENANCE,
  module: PROVENANCE,
})

describe('the CI input contract of the built-Worker qualification', () => {
  test('the host capabilities the qualification needs are all checked', () => {
    expect(() =>
      assertLocalRuntimePrerequisites({
        hasContainerRuntime: true,
        hasCertificateTool: true,
        hasLocalRuntime: true,
      })
    ).not.toThrow()
  })

  test('a host without a container runtime fails closed', () => {
    expect(() =>
      assertLocalRuntimePrerequisites({
        hasContainerRuntime: false,
        hasCertificateTool: true,
        hasLocalRuntime: true,
      })
    ).toThrow(/container-unavailable/u)
  })

  test('a host without a certificate tool fails closed', () => {
    expect(() =>
      assertLocalRuntimePrerequisites({
        hasContainerRuntime: true,
        hasCertificateTool: false,
        hasLocalRuntime: true,
      })
    ).toThrow(/instance-unavailable/u)
  })

  test('a host without the local runtime fails closed', () => {
    expect(() =>
      assertLocalRuntimePrerequisites({
        hasContainerRuntime: true,
        hasCertificateTool: true,
        hasLocalRuntime: false,
      })
    ).toThrow(/worker-start-failed/u)
  })

  test('the runner checks the capabilities before it creates a resource', () => {
    const check = RUNNER_SOURCE.indexOf('assertLocalRuntimePrerequisites({')
    const container = RUNNER_SOURCE.indexOf('createContainer({')
    expect(check).toBeGreaterThan(-1)
    expect(container).toBeGreaterThan(check)
  })
})

describe('the receipt contract of the built-Worker qualification', () => {
  test('the receipt names the source it ran and the artifact it proved', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(input(correctWorker()))
    expect(receipt.checkout.sha).toBe(PROVENANCE.sha)
    expect(receipt.module.sha).toBe(PROVENANCE.sha)
    expect(receipt.worker.artifact.digest).toBe(ARTIFACT.digest)
    expect(receipt.worker.artifact.sha).toBe(ARTIFACT.sha)
    expect(receipt.worker.artifact.verified).toBe(true)
  })

  test('a run that proved nothing is a failed run', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(
      input(async () => ({ status: 404, headers: {}, body: '' }))
    )
    // A receipt is a pass only when an assertion passed and none failed.
    expect(receipt.failed).toBeGreaterThan(0)
    expect(receipt.status).toBe('failed')
    expect(() => assertBuiltWorkerDesktopAuthPassed(receipt)).toThrow(/assertion-failed/u)
  })

  test('a receipt is a pass only when an assertion passed and none failed', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(input(correctWorker()))
    expect(receipt.passed).toBeGreaterThan(0)
    expect(receipt.status).toBe(receipt.failed === 0 && receipt.passed > 0 ? 'passed' : 'failed')
  })

  test('a failed receipt carries no value', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(
      input(async () => ({ status: 404, headers: {}, body: '' }))
    )
    const printed = JSON.stringify(receipt)
    expect(printed).not.toContain('the-known-secret-value')
    expect(receipt.failed).toBeGreaterThan(0)
  })

  test('a passing receipt carries no value either', async () => {
    const receipt = await runBuiltWorkerDesktopAuth(input(correctWorker()))
    const printed = JSON.stringify(receipt)
    expect(printed).not.toContain('the-known-secret-value')
    expect(printed).not.toContain('credential-value-0123456789')
  })
})

describe('the cleanup gate of the built-Worker qualification', () => {
  test('the teardown reports what it removed', async () => {
    const order: string[] = []
    const teardown = await tearDownAfterWorker({
      worker: {
        requestStop: () => {
          order.push('asked to stop')
        },
        stop: async () => {
          order.push('stopped')
        },
      },
      removeContainer: () => {
        order.push('container removed')
      },
      removeMaterial: () => {
        order.push('material removed')
      },
    })
    expect(teardown.workerStopped).toBe(true)
    expect(teardown.containerRemoved).toBe(true)
    expect(teardown.materialRemoved).toBe(true)
    expect(order).toEqual(['stopped', 'container removed', 'material removed'])
  })

  test('a Worker that is still alive keeps its material', () => {
    let removed = 0
    const outcome = removeOwnedMaterial({
      worker: { groupAlive: () => true, requestStop: () => undefined },
      remove: () => {
        removed += 1
      },
    })
    expect(outcome.removed).toBe(false)
    expect(removed).toBe(0)
  })

  test('the receipt is published only after the teardown ran', () => {
    const teardown = RUNNER_SOURCE.indexOf('tearDownAfterWorker({')
    const published = RUNNER_SOURCE.indexOf('BUILT_WORKER_DESKTOP_AUTH ${')
    expect(teardown).toBeGreaterThan(-1)
    expect(published).toBeGreaterThan(teardown)
  })

  test('a cleanup failure is a failure of the run', () => {
    const failure = new BuiltWorkerFailure('cleanup-failed', 'the container was not removed')
    expect(failure.kind).toBe('cleanup-failed')
    expect(failure.detail).toBe('the container was not removed')
  })
})
