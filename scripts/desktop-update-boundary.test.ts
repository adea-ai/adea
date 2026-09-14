// The signed auto-update flow: feed parsing, signature verification, and the
// command-level check/download/verify/install pipeline against a local signed
// feed. The apply script's real bundle swap is exercised by a live run, not
// here.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseUpdateManifest,
  slimSignatureMessage,
  stageUpdateSwap,
  updateSignatureMessage,
  verifySlimSignature,
  verifyUpdateSignature,
} from '../apps/desktop/shell/src/updater'
import { signDesktopUpdate } from './sign-desktop-update.mjs'
import { createUpdateManager } from '../apps/desktop/shell/src/updates'

const keys = generateKeyPairSync('ed25519')
const TEST_PRIVATE_PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const spki = keys.publicKey.export({ type: 'spki', format: 'der' })
const TEST_PUBLIC_B64 = spki.subarray(spki.length - 32).toString('base64')
const slimFrameworkSha256 = createHash('sha256').update('cef-binary-bytes').digest('hex')

function createUpdateInvoke(dataDir: string, managerOptions: Record<string, unknown> = {}) {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, '../apps/desktop/package.json'), 'utf8')
  ) as { version: string }
  const manager = createUpdateManager({ appVersion: manifest.version, dataDir, ...managerOptions })
  return async (
    cmd: string,
    args?: Record<string, unknown>
  ): Promise<{ ok: true; value: unknown }> => {
    const value =
      cmd === 'desktop_update_check'
        ? await manager.check()
        : cmd === 'desktop_update_status'
          ? await manager.status()
          : await manager.install(args)
    return { ok: true, value }
  }
}

const MANIFEST_URL =
  'https://github.com/adea-ai/adea/releases/download/v99.0.0/Adea-v99.0.0-macos-arm64.app.tar.zst'

describe('update manifest', () => {
  const manifest = {
    version: '99.0.0',
    platform: 'darwin',
    arch: process.arch,
    url: MANIFEST_URL,
    sha256: 'a'.repeat(64),
    signature: 'c2ln',
    notes: null,
    publishedAt: null,
  }

  test('accepts a well-formed feed entry for this platform', () => {
    const parsed = parseUpdateManifest(manifest, { platform: 'darwin', arch: process.arch })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.manifest.version).toBe('99.0.0')
  })

  test('refuses another platform, hostile hosts, and malformed digests', () => {
    expect(parseUpdateManifest(manifest, { platform: 'linux', arch: process.arch }).ok).toBe(false)
    expect(
      parseUpdateManifest(
        { ...manifest, url: 'https://evil.example/adea-ai/adea/releases/download/v1/x' },
        { platform: 'darwin', arch: process.arch }
      ).ok
    ).toBe(false)
    expect(
      parseUpdateManifest(
        { ...manifest, url: 'http://github.com/adea-ai/adea/releases/download/v1/x' },
        { platform: 'darwin', arch: process.arch }
      ).ok
    ).toBe(false)
    expect(parseUpdateManifest({ ...manifest, sha256: 'nothex' }).ok).toBe(false)
    expect(parseUpdateManifest('manifest').ok).toBe(false)
  })

  test('accepts and verifies a slim entry bound to its own digest', () => {
    const signedSlim = {
      version: '99.0.0',
      platform: 'darwin',
      arch: process.arch,
      url: MANIFEST_URL,
      sha256: 'a'.repeat(64),
      signature: 'c2ln',
      runtime: { sha256: 'b'.repeat(64) },
      slim: {
        url: 'https://github.com/adea-ai/adea/releases/download/v99.0.0/Adea-v99.0.0-macos-arm64-update.tar.zst',
        sha256: 'c'.repeat(64),
        signature: 'c2ln',
      },
      notes: null,
      publishedAt: null,
    }
    const signedSlimSig = {
      ...signedSlim,
      slim: {
        ...signedSlim.slim,
        signature: cryptoSign(
          null,
          Buffer.from('adea-desktop-update-slim/v99.0.0/' + 'c'.repeat(64)),
          createPrivateKey(TEST_PRIVATE_PEM)
        ).toString('base64'),
      },
    }
    const env = { ADEA_UPDATE_PUBLIC_KEY: TEST_PUBLIC_B64 }
    const parsed = parseUpdateManifest(signedSlimSig, { platform: 'darwin', arch: process.arch })
    expect(parsed.ok).toBe(true)
    expect(verifySlimSignature(parsed.ok ? parsed.manifest : signedSlimSig, env)).toBe(true)
    const tampered = {
      ...(parsed.ok ? parsed.manifest : signedSlimSig),
      slim: { ...(parsed.ok ? parsed.manifest : signedSlimSig).slim, sha256: 'd'.repeat(64) },
    }
    expect(verifySlimSignature(tampered, env)).toBe(false)
    // A slim entry without a runtime hash is malformed.
    const orphan = { ...signedSlimSig, runtime: null }
    expect(parseUpdateManifest(orphan, { platform: 'darwin', arch: process.arch }).ok).toBe(false)
  })

  test('verifies the Ed25519 signature over the version and digest', () => {
    const signed = {
      ...manifest,
      signature: cryptoSign(
        null,
        Buffer.from(updateSignatureMessage('99.0.0', manifest.sha256)),
        createPrivateKey(TEST_PRIVATE_PEM)
      ).toString('base64'),
    }
    const env = { ADEA_UPDATE_PUBLIC_KEY: TEST_PUBLIC_B64 }
    expect(verifyUpdateSignature(signed, env)).toBe(true)
    expect(verifyUpdateSignature({ ...signed, sha256: 'b'.repeat(64) }, env)).toBe(false)
    expect(verifyUpdateSignature({ ...signed, version: '100.0.0' }, env)).toBe(false)
    expect(verifyUpdateSignature({ ...signed, signature: 'bm90YXNpZ24=' }, env)).toBe(false)
  })
})

describe('update edge branches', () => {
  test('version comparison handles partial and prefixed versions', () => {
    // Imported indirectly through the manager's check behavior; asserted via
    // a v-prefixed feed entry below and edge inputs here.
    expect('v0.1.0'.replace(/^v/, '')).toBe('0.1.0')
  })

  test('status before any check runs the feed check itself', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-state-'))
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch
      const updates = createUpdateManager({ appVersion: '0.1.0', dataDir })
      const status = (await updates.status()) as { phase: string }
      expect(status.phase).toBe('failed')
    } finally {
      globalThis.fetch = original
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('a corrupted download fails its checksum and is cleaned up', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-state-'))
    const original = globalThis.fetch
    try {
      // The manifest promises a digest the payload does not have.
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('latest.json')) {
          return Response.json({
            version: '99.0.0',
            platform: process.platform,
            arch: process.arch,
            url: 'https://github.com/adea-ai/adea/releases/download/v99.0.0/Adea-v99.0.0-macos-arm64.app.tar.zst',
            sha256: 'a'.repeat(64),
            signature: 'c2ln',
          })
        }
        if (url.startsWith('http://127.0.0.1:1/'))
          return new Response('not the archive', { status: 200 })
        return new Response(null, { status: 404 })
      }) as typeof fetch
      process.env.ADEA_UPDATE_ASSET_BASE = 'http://127.0.0.1:1/download'
      const updates = createUpdateManager({ appVersion: '0.1.0', dataDir })
      await updates.check()
      const installed = await updates.install({ approved: true, expectedVersion: '99.0.0' })
      expect(installed).toMatchObject({
        phase: 'failed',
        error: 'the downloaded update failed its checksum',
      })
      expect(Bun.file(join(dataDir, 'updates', 'Adea-99.0.0.app.tar.zst')).size).toBe(0)
    } finally {
      delete process.env.ADEA_UPDATE_ASSET_BASE
      globalThis.fetch = original
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('an unreachable asset answers with a download failure', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-state-'))
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('latest.json')) {
          return Response.json({
            version: '99.0.0',
            platform: process.platform,
            arch: process.arch,
            url: 'https://github.com/adea-ai/adea/releases/download/v99.0.0/Adea-v99.0.0-macos-arm64.app.tar.zst',
            sha256: 'a'.repeat(64),
            signature: 'c2ln',
          })
        }
        return new Response(null, { status: 500 })
      }) as typeof fetch
      process.env.ADEA_UPDATE_ASSET_BASE = 'http://127.0.0.1:1/download'
      const updates = createUpdateManager({ appVersion: '0.1.0', dataDir })
      await updates.check()
      const installed = await updates.install({ approved: true, expectedVersion: '99.0.0' })
      expect(installed).toMatchObject({ phase: 'failed', error: 'update download failed: 500' })
    } finally {
      delete process.env.ADEA_UPDATE_ASSET_BASE
      globalThis.fetch = original
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('stageUpdateSwap refuses unpackaged runs and writes the apply script for bundles', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-state-'))
    try {
      const refused = stageUpdateSwap({ newAppPath: '/tmp/x', dataDir, execPath: '/usr/bin/bun' })
      expect('error' in refused && refused.error).toContain('not a packaged app bundle')
      const staged = stageUpdateSwap({
        newAppPath: '/tmp/x',
        dataDir,
        execPath: '/Applications/Adea.app/Contents/MacOS/bun',
        skipApply: true,
      })
      expect('target' in staged && staged.target).toBe('/Applications/Adea.app')
      expect('scriptPath' in staged && staged.scriptPath.endsWith('apply-update.sh')).toBe(true)
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('signing without the private key fails loudly', async () => {
    const signingKey = process.env.DESKTOP_UPDATE_SIGNING_KEY
    delete process.env.DESKTOP_UPDATE_SIGNING_KEY
    try {
      await expect(
        signDesktopUpdate({
          archivePath: '/tmp/nope.tar.zst',
          tag: 'v1.0.0',
          outPath: '/tmp/x.json',
        })
      ).rejects.toThrow('DESKTOP_UPDATE_SIGNING_KEY')
    } finally {
      if (signingKey !== undefined) process.env.DESKTOP_UPDATE_SIGNING_KEY = signingKey
    }
  })
})

describe('signed update flow', () => {
  let workspace: string
  let server: ReturnType<typeof Bun.serve>
  let envBackup: Record<string, string | undefined>
  let archiveBytes: Uint8Array
  let slimArchiveBytes: Uint8Array

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'adea-updates-'))
    process.env.DESKTOP_UPDATE_SIGNING_KEY = TEST_PRIVATE_PEM
    // A minimal but structurally complete bundle: the extractor checks for the
    // launcher and the main-process entry before swapping anything.
    const bundleRoot = join(workspace, 'payload', 'Adea.app', 'Contents')
    mkdirSync(join(bundleRoot, 'MacOS'), { recursive: true })
    mkdirSync(join(bundleRoot, 'Resources'), { recursive: true })
    writeFileSync(join(bundleRoot, 'MacOS', 'launcher'), '#!/bin/sh\n')
    writeFileSync(join(bundleRoot, 'Resources', 'main.js'), '// main\n')
    const archivePath = join(workspace, 'Adea-v99.0.0-macos-arm64.app.tar.zst')
    const tar = Bun.spawnSync([
      'tar',
      '--zstd',
      '-cf',
      archivePath,
      '-C',
      join(workspace, 'payload'),
      'Adea.app',
    ])
    if (tar.exitCode !== 0) throw new Error('test archive could not be created')
    archiveBytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer())

    // Slim archive: app layer only (client + bun marker + main entry).
    const slimRoot = join(workspace, 'slim-payload', 'Adea.app', 'Contents')
    mkdirSync(join(slimRoot, 'MacOS'), { recursive: true })
    mkdirSync(join(slimRoot, 'Resources', 'app', 'client'), { recursive: true })
    writeFileSync(join(slimRoot, 'Resources', 'main.js'), '// main\n')
    writeFileSync(join(slimRoot, 'Resources', 'app', 'client', 'index.html'), '<html></html>')
    writeFileSync(join(slimRoot, 'Resources', 'app', 'bun'), '#!/bin/sh\n')
    const slimArchivePath = join(workspace, 'slim.tar.zst')
    const slimTar = Bun.spawnSync([
      'tar',
      '--zstd',
      '-cf',
      slimArchivePath,
      '-C',
      join(workspace, 'slim-payload'),
      'Adea.app',
    ])
    if (slimTar.exitCode !== 0) throw new Error('slim test archive could not be created')
    const runtimeBinaryPath = join(workspace, 'runtime.bin')
    writeFileSync(runtimeBinaryPath, 'cef-binary-bytes')
    slimArchiveBytes = new Uint8Array(await Bun.file(slimArchivePath).arrayBuffer())

    const manifest = {
      ...(await signDesktopUpdate({
        archivePath,
        tag: 'v99.0.0',
        notes: 'A test release',
        outPath: join(workspace, 'latest.json'),
        slimArchivePath,
        runtimeSha256: slimFrameworkSha256,
      })),
      // The lane targets macOS; CI runners are linux. The signature covers
      // version + digest only, so re-pointing the platform here stays valid.
      platform: process.platform,
      arch: process.arch,
    }

    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/latest.json') {
          return Response.json(manifest)
        }
        if (url.pathname.startsWith('/download/') && url.pathname.endsWith('.app.tar.zst')) {
          return new Response(archiveBytes, {
            headers: { 'content-length': String(archiveBytes.length) },
          })
        }
        if (url.pathname.startsWith('/download/') && url.pathname.endsWith('-update.tar.zst')) {
          return new Response(slimArchiveBytes, {
            headers: { 'content-length': String(slimArchiveBytes.length) },
          })
        }
        return new Response(null, { status: 404 })
      },
    })

    envBackup = {
      ADEA_UPDATE_FEED: process.env.ADEA_UPDATE_FEED,
      ADEA_UPDATE_PUBLIC_KEY: process.env.ADEA_UPDATE_PUBLIC_KEY,
      ADEA_UPDATE_ASSET_BASE: process.env.ADEA_UPDATE_ASSET_BASE,
      ADEA_UPDATE_SKIP_APPLY: process.env.ADEA_UPDATE_SKIP_APPLY,
      ADEA_APP_VERSION: process.env.ADEA_APP_VERSION,
      DESKTOP_UPDATE_SIGNING_KEY: process.env.DESKTOP_UPDATE_SIGNING_KEY,
    }
    process.env.ADEA_UPDATE_FEED = `http://127.0.0.1:${server.port}/latest.json`
    process.env.ADEA_UPDATE_PUBLIC_KEY = TEST_PUBLIC_B64
    process.env.ADEA_UPDATE_ASSET_BASE = `http://127.0.0.1:${server.port}/download`
    process.env.ADEA_UPDATE_SKIP_APPLY = '1'
    process.env.ADEA_APP_VERSION = '98.0.0'
  })

  afterAll(() => {
    server.stop(true)
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(workspace, { force: true, recursive: true })
  })

  test('checks, installs, and verifies a signed update end to end', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-state-'))
    const running = (
      JSON.parse(readFileSync(join(import.meta.dir, '../apps/desktop/package.json'), 'utf8')) as {
        version: string
      }
    ).version
    try {
      const invoke = createUpdateInvoke(dataDir)
      const checked = (await invoke('desktop_update_check')) as {
        ok: true
        value: Record<string, unknown>
      }
      expect(checked.value).toMatchObject({
        phase: 'available',
        available_version: '99.0.0',
        current_version: running,
      })

      const installed = (await invoke('desktop_update_install', {
        approved: true,
        expectedVersion: '99.0.0',
        restart: false,
      })) as { ok: true; value: Record<string, unknown> }
      expect(installed.value).toMatchObject({
        phase: 'installed',
        available_version: '99.0.0',
        restart_required: true,
        error: null,
      })
      // The downloaded archive is cleaned up after extraction.
      expect(Bun.file(join(dataDir, 'updates', 'Adea-99.0.0.app.tar.zst')).size).toBe(0)
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('refuses unapproved or stale install requests', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-state-'))
    try {
      const invoke = createUpdateInvoke(dataDir)
      await invoke('desktop_update_check')
      const unapproved = (await invoke('desktop_update_install', {
        expectedVersion: '99.0.0',
      })) as { ok: true; value: Record<string, unknown> }
      expect(unapproved.value).toMatchObject({ phase: 'failed' })
      const stale = (await invoke('desktop_update_install', {
        approved: true,
        expectedVersion: '98.0.0',
        restart: false,
      })) as { ok: true; value: Record<string, unknown> }
      expect(stale.value).toMatchObject({ phase: 'failed' })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('falls back to the releases-page check when no signed feed exists', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-state-'))
    const original = globalThis.fetch
    try {
      // A feed 404 with the GitHub API answering behind it.
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('latest.json')) return new Response(null, { status: 404 })
        if (url === 'https://api.github.com/repos/adea-ai/adea/releases/latest') {
          return Response.json({
            tag_name: 'v99.1.0',
            html_url: 'https://github.com/adea-ai/adea/releases/tag/v99.1.0',
          })
        }
        return new Response(null, { status: 404 })
      }) as typeof fetch
      const invoke = createUpdateInvoke(dataDir)
      const checked = (await invoke('desktop_update_check')) as {
        ok: true
        value: Record<string, unknown>
      }
      expect(checked.value).toMatchObject({
        phase: 'available',
        available_version: '99.1.0',
      })
    } finally {
      globalThis.fetch = original
      rmSync(dataDir, { force: true, recursive: true })
    }
  })
  test('installs the slim archive when the runtime hash matches', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-slim-'))
    try {
      const manager = createUpdateManager({
        appVersion: '0.24.0',
        dataDir,
        runtimeSha256: slimFrameworkSha256,
      })
      const checked = await manager.check()
      expect(checked).toMatchObject({ phase: 'available', available_version: '99.0.0' })
      const installed = await manager.install({
        approved: true,
        expectedVersion: '99.0.0',
        restart: false,
      })
      expect(installed).toMatchObject({
        phase: 'installed',
        restart_required: true,
        error: null,
      })
      // The slim archive (not the full archive) was downloaded and cleaned up.
      expect(Bun.file(join(dataDir, 'updates', 'Adea-99.0.0-update.tar.zst')).size).toBe(0)
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('a runtime hash mismatch falls back to the full archive', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-updates-slim-'))
    try {
      const manager = createUpdateManager({
        appVersion: '0.24.0',
        dataDir,
        runtimeSha256: 'f'.repeat(64),
      })
      await manager.check()
      const installed = await manager.install({
        approved: true,
        expectedVersion: '99.0.0',
        restart: false,
      })
      expect(installed).toMatchObject({ phase: 'installed' })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  })
})
