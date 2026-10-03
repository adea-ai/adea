// The update state machine must never wedge: a hung feed or GitHub API
// connection left the phase stuck at 'checking' (the GitHub API fallback had
// no timeout and status() served a non-idle snapshot forever), which disabled
// the in-app Check button until the app restarted. These tests pin the
// contract: every check settles, a stalled state recovers, and concurrent
// checks share one flight.
import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  createUpdateManager,
  isUpdateChannel,
  resolveChannelFeedUrl,
  versionLessThan,
} from '../shell/src/updates'

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

  test('the update surface carries the full installed changelog', async () => {
    installFetchMock()
    fetchHandler = async () => VALID_MANIFEST()
    const manager = createUpdateManager({
      appVersion: '0.65.2',
      dataDir: '/tmp/adea-update-manager-test',
      checkTimeoutMs: 30,
    })
    const status = await manager.status()
    // The dialog's installed-changelog section shows the repository's whole
    // release history — every version heading — not just the offered
    // release's notes.
    expect(status.changelog).toMatch(/## \[\d+\.\d+\.\d+\]/)
    expect(status.changelog.match(/## \[\d+\.\d+\.\d+\]/g)?.length).toBeGreaterThan(1)
    expect(status.changelog.length).toBeGreaterThan((status.release_notes ?? '').length)
  })
})

describe('update version ordering', () => {
  test('a dev build sorts below its own release and above earlier dev builds', () => {
    expect(versionLessThan('0.75.0-dev.1', '0.75.0')).toBe(true)
    expect(versionLessThan('0.75.0-dev.9', '0.75.0-dev.10')).toBe(true)
    expect(versionLessThan('0.75.0-dev.10', '0.75.0-dev.10')).toBe(false)
    // The next stable always wins over the dev line anchored at its
    // predecessor, so a dev install is never stuck on the anchor.
    expect(versionLessThan('0.75.0-dev.99', '0.75.1')).toBe(true)
    expect(versionLessThan('0.75.1', '0.75.0-dev.99')).toBe(false)
    // A dev build of the new stable supersedes the previous stable release.
    expect(versionLessThan('0.75.0', '0.75.1-dev.1')).toBe(true)
    // v prefixes and the release ordering fall out of the same compare.
    expect(versionLessThan('v0.75.0-dev.1', 'v0.75.0')).toBe(true)
    expect(versionLessThan('0.74.9', '0.75.0-dev.1')).toBe(true)
  })

  test('unparseable versions keep the historic fallback instead of wedging', () => {
    expect(versionLessThan('0.65.2', 'not-a-version')).toBe(false)
    expect(versionLessThan('0.65.2', '99.0.0')).toBe(true)
  })

  test('dev opt-in can advance a same-core stable install to a dev build', () => {
    expect(versionLessThan('0.66.0', '0.66.0-dev.3', 'dev')).toBe(true)
    expect(versionLessThan('0.66.0-dev.2', '0.66.0-dev.3', 'dev')).toBe(true)
    expect(versionLessThan('0.66.0-dev.3', '0.66.0-dev.2', 'dev')).toBe(false)
    expect(versionLessThan('0.66.1', '0.66.0-dev.99', 'dev')).toBe(false)
    // Stable and pre-release ordering must continue to treat a release as
    // newer than a dev build with the same numeric version.
    expect(versionLessThan('0.66.0', '0.66.0-dev.3')).toBe(false)
    expect(versionLessThan('0.66.0-dev.3', '0.66.0')).toBe(true)
  })

  test('the channel guard accepts exactly the three channels', () => {
    expect(isUpdateChannel('stable')).toBe(true)
    expect(isUpdateChannel('pre-release')).toBe(true)
    expect(isUpdateChannel('dev')).toBe(true)
    expect(isUpdateChannel('beta')).toBe(false)
    expect(isUpdateChannel(undefined)).toBe(false)
  })
})

// A releases-API listing that exercises every selector: dev builds and
// stables are skipped, drafts are skipped, the newest survivor wins.
const RELEASES = () =>
  Response.json([
    {
      tag_name: 'v0.76.0-dev.7',
      draft: false,
      prerelease: true,
      assets: [{ name: 'latest.json' }, { name: 'Adea-v0.76.0-dev.7-macos-arm64.app.tar.zst' }],
    },
    {
      tag_name: 'v0.76.0-dev.6',
      draft: false,
      prerelease: true,
      assets: [{ name: 'latest.json' }, { name: 'Adea-v0.76.0-dev.6-macos-arm64.app.tar.zst' }],
    },
    {
      tag_name: 'v0.75.3',
      draft: false,
      prerelease: true,
      assets: [{ name: 'latest.json' }, { name: 'Adea-v0.75.3-macos-arm64.app.tar.zst' }],
    },
    { tag_name: 'v0.75.2', draft: true, prerelease: true },
    { tag_name: 'v0.75.1', draft: false, prerelease: false },
  ])

describe('update channels', () => {
  test('the pre-release channel resolves the newest non-dev pre-release', async () => {
    installFetchMock()
    fetchHandler = async (url) =>
      url.includes('/releases?') ? RELEASES() : new Response('{}', { status: 404 })
    expect(await resolveChannelFeedUrl('pre-release')).toBe(
      'https://github.com/adea-ai/adea/releases/download/v0.75.3/latest.json'
    )
  })

  test('the dev channel resolves the newest dev build and skips drafts and stables', async () => {
    installFetchMock()
    fetchHandler = async (url) =>
      url.includes('/releases?') ? RELEASES() : new Response('{}', { status: 404 })
    expect(await resolveChannelFeedUrl('dev')).toBe(
      'https://github.com/adea-ai/adea/releases/download/v0.76.0-dev.7/latest.json'
    )
  })

  test('channel discovery skips releases until both the signed feed and app archive exist', async () => {
    installFetchMock()
    fetchHandler = async (url) => {
      if (!url.includes('/releases?')) return new Response('{}', { status: 404 })
      return Response.json([
        {
          tag_name: 'v0.76.0-dev.9',
          draft: false,
          prerelease: true,
          assets: [{ name: 'Adea-v0.76.0-dev.9-macos-arm64.app.tar.zst' }],
        },
        {
          tag_name: 'v0.76.0-dev.8',
          draft: false,
          prerelease: true,
          assets: [{ name: 'latest.json' }],
        },
        {
          tag_name: 'v0.76.0-dev.7',
          draft: false,
          prerelease: true,
          assets: [{ name: 'latest.json' }, { name: 'Adea-v0.76.0-dev.7-macos-arm64.app.tar.zst' }],
        },
      ])
    }
    expect(await resolveChannelFeedUrl('dev')).toBe(
      'https://github.com/adea-ai/adea/releases/download/v0.76.0-dev.7/latest.json'
    )
  })

  test('an empty channel reports a typed failure instead of a URL', async () => {
    installFetchMock()
    fetchHandler = async () => Response.json([])
    await expect(resolveChannelFeedUrl('pre-release')).rejects.toThrow(
      'no pre-release release is published yet'
    )
  })

  test('the pre-release channel checks the resolved manifest, not the stable feed', async () => {
    installFetchMock()
    fetchHandler = async (url) => {
      if (url.includes('/releases?')) return RELEASES()
      if (url === 'https://github.com/adea-ai/adea/releases/download/v0.75.3/latest.json') {
        return Response.json({
          version: '0.75.3',
          platform: process.platform,
          arch: process.arch,
          url: `https://github.com/adea-ai/adea/releases/download/v0.75.3/Adea-v0.75.3-${process.platform}-${process.arch}.app.tar.zst`,
          sha256: 'a'.repeat(64),
          signature: 'sig',
          notes: 'the daily build',
        })
      }
      return new Response('{}', { status: 404 })
    }
    const manager = createUpdateManager({
      appVersion: '0.75.0',
      dataDir: '/tmp/adea-update-manager-test',
      checkTimeoutMs: 1_000,
      channel: () => 'pre-release',
    })
    const status = await manager.check()
    expect(status.phase).toBe('available')
    expect(status.available_version).toBe('0.75.3')
    // The stable moving feed was never consulted.
    expect(fetchCalls.some((call) => call.url.includes('releases/latest/download'))).toBe(false)
  })

  test('an opt-in channel with an unreachable API fails instead of falling back to stable', async () => {
    installFetchMock()
    fetchHandler = async (url) =>
      url.includes('/releases?') ? new Response('{}', { status: 502 }) : HANG
    const manager = createUpdateManager({
      appVersion: '0.75.0-dev.4',
      dataDir: '/tmp/adea-update-manager-test',
      checkTimeoutMs: 50,
      channel: () => 'dev',
    })
    const status = await manager.check()
    expect(status.phase).toBe('failed')
    // The stable fallback (the releases/latest API and its handoff) never ran.
    expect(
      fetchCalls.filter(
        (call) => call.url === 'https://api.github.com/repos/adea-ai/adea/releases/latest'
      )
    ).toHaveLength(0)
  })

  test('a hung opt-in release lookup settles within the configured check timeout', async () => {
    installFetchMock()
    fetchHandler = () => HANG
    const manager = createUpdateManager({
      appVersion: '0.75.0-dev.4',
      dataDir: '/tmp/adea-update-manager-test',
      checkTimeoutMs: 30,
      channel: () => 'dev',
    })
    const status = await manager.check()
    expect(status.phase).toBe('failed')
    expect(fetchCalls).toContainEqual({
      url: 'https://api.github.com/repos/adea-ai/adea/releases?per_page=30',
    })
    expect(status.error).not.toBeNull()
  })
})
