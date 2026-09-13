// Signed in-app updates for the desktop shell (macOS arm64 stable lane).
//
// Feed: the release lane publishes `latest.json` beside the app archive on
// GitHub Releases (`releases/latest/download/latest.json`) with the archive's
// version, URL, SHA-256, and an Ed25519 signature over
// `adea-desktop-update/v<version>/<sha256>`. The private half lives only in
// the `DESKTOP_UPDATE_SIGNING_KEY` repository secret and is used by
// `scripts/sign-desktop-update.mjs`; this shell verifies with the public half
// baked in below, so a compromised feed cannot install code we did not sign.
// Install verifies, extracts the archive, swaps the running bundle, and
// relaunches; platforms or layouts where that is impossible fall back to the
// releases-page handoff.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

/** The Ed25519 public half of the release signing key (raw 32 bytes, base64). */
const DESKTOP_UPDATE_PUBLIC_KEY = 'oNz1xzur8JmPA/fv4m2FI/HWEhju372i/e21aiq0cDs='

const DEFAULT_FEED_URL = 'https://github.com/adea-ai/adea/releases/latest/download/latest.json'

export type UpdateManifest = Readonly<{
  version: string
  url: string
  sha256: string
  signature: string
  notes: string | null
  publishedAt: string | null
  platform: string
  arch: string
}>

export function updateFeedUrl(env: Record<string, string | undefined> = process.env): string {
  return env.ADEA_UPDATE_FEED ?? DEFAULT_FEED_URL
}

function updatePublicKey(env: Record<string, string | undefined> = process.env) {
  const raw = Buffer.from(env.ADEA_UPDATE_PUBLIC_KEY ?? DESKTOP_UPDATE_PUBLIC_KEY, 'base64')
  if (raw.length !== 32) throw new Error('The desktop update public key is malformed')
  // Ed25519 SPKI wrapper around the raw 32-byte key.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  return createPublicKey({ key: spki, format: 'der', type: 'spki' })
}

export function updateSignatureMessage(version: string, sha256: string): string {
  return `adea-desktop-update/v${version}/${sha256}`
}

/**
 * Where update assets download from. `ADEA_UPDATE_ASSET_BASE` re-points the
 * release-download prefix at a local feed for tests and staging; the archive
 * is still verified against the manifest hash and signature, so a hostile
 * base yields nothing an attacker can install.
 */
export function resolveUpdateAssetUrl(
  url: string,
  env: Record<string, string | undefined> = process.env
): string {
  const base = env.ADEA_UPDATE_ASSET_BASE
  if (!base) return url
  const prefix = 'https://github.com/adea-ai/adea/releases/download/'
  return url.startsWith(prefix) ? `${base.replace(/\/$/, '')}/${url.slice(prefix.length)}` : url
}

const SHA256_HEX = /^[0-9a-f]{64}$/

export function parseUpdateManifest(
  value: unknown,
  running: Readonly<{ platform: string; arch: string }> = {
    platform: process.platform,
    arch: process.arch,
  }
): { ok: true; manifest: UpdateManifest } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'not an object' }
  const candidate = value as Record<string, unknown>
  const version = candidate.version
  if (typeof version !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(version)) {
    return { ok: false, reason: 'version' }
  }
  const url = candidate.url
  if (typeof url !== 'string') return { ok: false, reason: 'url' }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      return { ok: false, reason: 'url' }
    }
    if (!parsed.pathname.startsWith('/adea-ai/adea/releases/download/')) {
      return { ok: false, reason: 'url' }
    }
  } catch {
    return { ok: false, reason: 'url' }
  }
  const sha256 = candidate.sha256
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    return { ok: false, reason: 'sha256' }
  }
  const signature = candidate.signature
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, reason: 'signature' }
  }
  const platform = candidate.platform
  const arch = candidate.arch
  if (platform !== running.platform || arch !== running.arch) {
    return { ok: false, reason: 'platform' }
  }
  return {
    ok: true,
    manifest: {
      version: version.replace(/^v/, ''),
      url,
      sha256,
      signature,
      notes: typeof candidate.notes === 'string' ? candidate.notes : null,
      publishedAt: typeof candidate.publishedAt === 'string' ? candidate.publishedAt : null,
      platform,
      arch,
    },
  }
}

export function verifyUpdateSignature(
  manifest: UpdateManifest,
  env: Record<string, string | undefined> = process.env
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(updateSignatureMessage(manifest.version, manifest.sha256)),
      updatePublicKey(env),
      Buffer.from(manifest.signature, 'base64')
    )
  } catch {
    return false
  }
}

/** Stream one URL to a file, returning its SHA-256 hex and byte count. */
export async function downloadUpdateArchive(
  url: string,
  destinationPath: string,
  hooks: {
    onProgress?: (downloaded: number, total: number | null) => void
    signal?: AbortSignal
  } = {}
): Promise<{ sha256: string; bytes: number }> {
  const response = await fetch(url, { redirect: 'follow', signal: hooks.signal })
  if (!response.ok || !response.body) {
    throw new Error(`update download failed: ${response.status}`)
  }
  mkdirSync(join(destinationPath, '..'), { recursive: true })
  const writer = Bun.file(destinationPath).writer()
  const hasher = new Bun.CryptoHasher('sha256')
  const totalHeader = Number(response.headers.get('content-length') ?? '')
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null
  let downloaded = 0
  for await (const chunk of response.body) {
    const bytes = chunk as Uint8Array
    hasher.update(bytes)
    downloaded += bytes.length
    writer.write(bytes)
    hooks.onProgress?.(downloaded, total)
  }
  await writer.end()
  return { sha256: hasher.digest('hex'), bytes: downloaded }
}

/** Extract the staged app archive and return the extracted `.app` path. */
export async function extractUpdateArchive(
  archivePath: string,
  extractDir: string
): Promise<string> {
  rmSync(extractDir, { force: true, recursive: true })
  mkdirSync(extractDir, { recursive: true })
  const proc = Bun.spawnSync(['tar', '--zstd', '-xf', archivePath, '-C', extractDir])
  if (proc.exitCode !== 0) {
    throw new Error('the downloaded update archive could not be extracted')
  }
  const appPath = join(extractDir, 'Adea.app')
  const launcher = join(appPath, 'Contents', 'MacOS', 'launcher')
  const main = join(appPath, 'Contents', 'Resources', 'main.js')
  if (!existsSync(launcher) || !existsSync(main)) {
    throw new Error('the extracted update is not a complete Adea bundle')
  }
  return appPath
}

/**
 * Stage the swap that replaces the running bundle with `newAppPath` once this
 * process exits, then relaunch. Returns the apply-script path. Refuses when
 * the running process is not an `.app` bundle (repo/dev runs use the
 * releases-page handoff instead).
 */
export function stageUpdateSwap(input: {
  newAppPath: string
  dataDir: string
  execPath?: string
  skipApply?: boolean
}): { target: string; scriptPath: string } | { error: string } {
  const scriptPath = join(input.dataDir, 'updates', 'apply-update.sh')
  const execPath = input.execPath ?? process.execPath
  const macosIndex = execPath.lastIndexOf(`${sep}Contents${sep}MacOS${sep}`)
  const target = macosIndex < 0 ? null : execPath.slice(0, macosIndex)
  // Tests and staging runs verify everything except the real process swap;
  // without a packaged path there is no bundle to map, which skipApply allows.
  if (input.skipApply) {
    return { target: target ?? '/dev/null/Adea.app', scriptPath }
  }
  if (!target?.endsWith('.app')) {
    return { error: 'not a packaged app bundle' }
  }
  const previous = `${target}.previous`
  // The Electrobun launcher survives its child and, left alive, consumes the
  // relaunch as a single-instance handoff and restarts nothing. Stop every
  // process of the old bundle (the shell has already exited) before swapping.
  writeFileSync(
    scriptPath,
    [
      '#!/bin/sh',
      'set -u',
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
      `pkill -f ${JSON.stringify(target)} 2>/dev/null || true`,
      'i=0',
      `while pgrep -f ${JSON.stringify(target)} >/dev/null 2>&1 && [ "$i" -lt 20 ]; do`,
      '  sleep 0.5',
      '  i=$((i+1))',
      'done',
      `pkill -9 -f ${JSON.stringify(target)} 2>/dev/null || true`,
      'sleep 1',
      `rm -rf ${JSON.stringify(previous)}`,
      `mv ${JSON.stringify(target)} ${JSON.stringify(previous)}`,
      `if ! mv ${JSON.stringify(input.newAppPath)} ${JSON.stringify(target)}; then`,
      `  mv ${JSON.stringify(previous)} ${JSON.stringify(target)}`,
      '  exit 1',
      'fi',
      `rm -rf ${JSON.stringify(previous)}`,
      // Direct exec of the launcher, with its log captured: LaunchServices
      // `open` can be swallowed by stale single-instance state mid-update,
      // and the launcher's own output is the only window into its install.
      `nohup ${JSON.stringify(join(target, 'Contents', 'MacOS', 'launcher'))} >> ${JSON.stringify(
        join(input.dataDir, 'updates', 'relaunch.log')
      )} 2>&1 &`,
      '',
    ].join('\n'),
    { mode: 0o755 }
  )
  return { target, scriptPath }
}
