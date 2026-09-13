// The signed auto-update flow: feed parsing, signature verification, and the
// command-level check/download/verify/install pipeline against a local signed
// feed. The apply script's real bundle swap is exercised by a live run, not
// here.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseUpdateManifest,
  updateSignatureMessage,
  verifyUpdateSignature,
} from '../shell/src/updater'
import { signDesktopUpdate } from '../../../scripts/sign-desktop-update.mjs'
import { createCommandSurface } from '../shell/src/commands'

const keys = generateKeyPairSync('ed25519')
const TEST_PRIVATE_PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const spki = keys.publicKey.export({ type: 'spki', format: 'der' })
const TEST_PUBLIC_B64 = spki.subarray(spki.length - 32).toString('base64')

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

describe('signed update flow', () => {
  let workspace: string
  let server: ReturnType<typeof Bun.serve>
  let envBackup: Record<string, string | undefined>
  let archiveBytes: Uint8Array

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
    const manifest = await signDesktopUpdate({
      archivePath,
      tag: 'v99.0.0',
      notes: 'A test release',
      outPath: join(workspace, 'latest.json'),
    })

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
      JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as {
        version: string
      }
    ).version
    try {
      const invoke = createCommandSurface(dataDir)
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
      const invoke = createCommandSurface(dataDir)
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
      const invoke = createCommandSurface(dataDir)
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
})
