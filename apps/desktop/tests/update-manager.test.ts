// The update state machine must never wedge: a hung feed or GitHub API
// connection left the phase stuck at 'checking' (the GitHub API fallback had
// no timeout and status() served a non-idle snapshot forever), which disabled
// the in-app Check button until the app restarted. These tests pin the
// contract: every check settles, a stalled state recovers, and concurrent
// checks share one flight.
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { createUpdateManager } from '../shell/src/updates'

type FetchCall = { url: string }

const originalFetch = globalThis.fetch
let fetchCalls: FetchCall[] = []
let fetchHandler: (url: string) => Promise<Response> = async () => new Response('{}')

function installFetchMock(): void {
  fetchCalls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    fetchCalls.push({ url })
    // Real fetch rejects when its abort signal fires; the mock must too, or
    // the check timeout cannot bound a hung handler.
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'TimeoutError'))
      )
      void fetchHandler(url).then(resolve, reject)
    })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

const HANG = new Promise<Response>(() => {})

// The manifest parser validates platform/arch against the RUNNING platform,
// so the fixture follows the test's host (CI is linux/x64).
const VALID_MANIFEST = () =>
  Response.json({
    version: '0.67.1',
    platform: process.platform,
    arch: process.arch,
    url: `https://github.com/adea-ai/adea/releases/download/v0.67.1/Adea-v0.67.1-${process.platform}-${process.arch}.app.tar.zst`,
    sha256: 'a'.repeat(64),
    signature: 'sig',
    notes: 'the latest signed build',
  })

describe('update manager', () => {
  test('a hung feed and hung API fallback still settle the check as failed', async () => {
    installFetchMock()
    fetchHandler = () => HANG
    const manager = createUpdateManager({
      appVersion: '0.65.2',
      dataDir: '/tmp/adea-update-manager-test',
      checkTimeoutMs: 30,
    })
    const status = await manager.check()
    expect(status.phase).toBe('failed')
    expect(status.error).not.toBeNull()
    // Both the signed feed and the GitHub API fallback were attempted, each
    // bounded by the check timeout.
    expect(fetchCalls.filter((call) => call.url.includes('latest.json'))).toHaveLength(1)
    expect(
      fetchCalls.filter(
        (call) => call.url === 'https://api.github.com/repos/adea-ai/adea/releases/latest'
      )
    ).toHaveLength(1)
  })

  test('a bounded failed check is retryable and recovers to available', async () => {
    installFetchMock()
    fetchHandler = () => HANG
    const manager = createUpdateManager({
      appVersion: '0.65.2',
      dataDir: '/tmp/adea-update-manager-test',
      checkTimeoutMs: 30,
    })
    // While a check is genuinely in flight, status serves it.
    const inFlight = manager.check()
    const whileChecking = await Promise.resolve(manager.status())
    expect(whileChecking.phase).toBe('checking')
    const failed = await inFlight
    expect(failed.phase).toBe('failed')
    expect((await manager.status()).phase).toBe('failed')

    // The retry path recovers: a bounded failed check never poisons the next
    // one.
    fetchHandler = async () => VALID_MANIFEST()
    const recovered = await manager.check()
    expect(recovered.phase).toBe('available')
    expect(recovered.available_version).toBe('0.67.1')
    expect((await manager.status()).phase).toBe('available')
  })

  test('concurrent checks share a single flight', async () => {
    installFetchMock()
    let releaseFetch: ((response: Response) => void) | undefined
    fetchHandler = async () =>
      new Promise<Response>((resolve) => {
        releaseFetch = resolve
      })
    void VALID_MANIFEST()
    const manager = createUpdateManager({
      appVersion: '0.65.2',
      dataDir: '/tmp/adea-update-manager-test',
      checkTimeoutMs: 5_000,
    })
    const first = manager.check()
    const second = manager.check()
    expect(first).toBe(second)
    releaseFetch?.(VALID_MANIFEST())
    const status = await first
    expect(status.phase).toBe('available')
    // One feed request for both callers.
    expect(fetchCalls.filter((call) => call.url.includes('latest.json'))).toHaveLength(1)
  })

  test('a current install reports current without an update offer', async () => {
    installFetchMock()
    fetchHandler = async () =>
      Response.json({
        version: '0.65.2',
        platform: process.platform,
        arch: process.arch,
        url: `https://github.com/adea-ai/adea/releases/download/v0.65.2/Adea-v0.65.2-${process.platform}-${process.arch}.app.tar.zst`,
        sha256: 'a'.repeat(64),
        signature: 'sig',
        notes: 'the installed build',
      })
    const manager = createUpdateManager({
      appVersion: '0.65.2',
      dataDir: '/tmp/adea-update-manager-test',
      checkTimeoutMs: 1_000,
    })
    const status = await manager.check()
    expect(status.phase).toBe('current')
    expect(status.available_version).toBeNull()
  })
})
