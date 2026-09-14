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
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

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
  /** SHA-256 over the runtime binaries (CEF, bun, launcher) this release was built with. */
  runtime: { sha256: string } | null
  /** App-layer-only archive, installable when the installed CEF matches. */
  slim: { url: string; sha256: string; signature: string } | null
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
  // Optional slim-update entry: an app-layer-only archive usable when the
  // installed CEF framework hash matches `framework.sha256`.
  const runtime = candidate.runtime
  let runtimeSha256: string | null = null
  if (runtime !== undefined && runtime !== null) {
    const hash = (runtime as Record<string, unknown>).sha256
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
      return { ok: false, reason: 'runtime' }
    }
    runtimeSha256 = hash
  }
  let slim: UpdateManifest['slim'] = null
  const slimCandidate = candidate.slim
  if (slimCandidate !== undefined && slimCandidate !== null) {
    if (runtimeSha256 === null) return { ok: false, reason: 'slim without runtime' }
    const slimRecord = slimCandidate as Record<string, unknown>
    const slimUrl = slimRecord.url
    const slimSha256 = slimRecord.sha256
    const slimSignature = slimRecord.signature
    if (
      typeof slimUrl !== 'string' ||
      typeof slimSha256 !== 'string' ||
      typeof slimSignature !== 'string'
    ) {
      return { ok: false, reason: 'slim' }
    }
    try {
      const parsed = new URL(slimUrl)
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
        return { ok: false, reason: 'slim url' }
      }
      if (!parsed.pathname.startsWith('/adea-ai/adea/releases/download/')) {
        return { ok: false, reason: 'slim url' }
      }
    } catch {
      return { ok: false, reason: 'slim url' }
    }
    if (!SHA256_HEX.test(slimSha256)) return { ok: false, reason: 'slim sha256' }
    slim = { url: slimUrl, sha256: slimSha256, signature: slimSignature }
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
      runtime: runtimeSha256 === null ? null : { sha256: runtimeSha256 },
      slim,
    },
  }
}

export function slimSignatureMessage(version: string, sha256: string): string {
  return `adea-desktop-update-slim/v${version}/${sha256}`
}

export function verifySlimSignature(
  manifest: UpdateManifest,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!manifest.slim) return false
  try {
    return cryptoVerify(
      null,
      Buffer.from(slimSignatureMessage(manifest.version, manifest.slim.sha256)),
      updatePublicKey(env),
      Buffer.from(manifest.slim.signature, 'base64')
    )
  } catch {
    return false
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
  // Stream into a scratch name and rename once the writer has closed: the
  // archive path must never be visible to the extractor while it is still
  // being written, because a partially flushed file extracts as "the
  // downloaded update archive could not be extracted".
  const partialPath = `${destinationPath}.partial`
  const writer = Bun.file(partialPath).writer()
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
  renameSync(partialPath, destinationPath)
  return { sha256: hasher.digest('hex'), bytes: downloaded }
}

/**
 * Extract the staged app archive and return the extracted `.app` path. `full`
 * archives carry the complete bundle; `slim` archives carry only the app layer
 * (no CEF framework, no launcher-install inputs) and are overlaid in place.
 */
/**
 * Decompress one zstd archive with the tool the bundle already ships next to
 * the runtime (`Contents/MacOS/zig-zstd`, part of every full install). macOS
 * bsdtar implements `--zstd` by executing an external `zstd` program, which
 * the launchd PATH of a Dock-launched app (/usr/bin:/bin:/usr/sbin:/sbin)
 * does not contain — machines without a Homebrew zstd could never extract an
 * update at all. Returns the plain tar path.
 */
function decompressZstd(archivePath: string, tarPath: string): void {
  const bundled = join(dirname(process.execPath), 'zig-zstd')
  if (existsSync(bundled)) {
    const proc = Bun.spawnSync([bundled, 'decompress', '-i', archivePath, '-o', tarPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr?.toString().trim().slice(0, 300) ?? ''
      throw new Error(
        `the downloaded update archive could not be decompressed (zig-zstd exit ${proc.exitCode}${stderr ? `: ${stderr}` : ''})`
      )
    }
    return
  }
  // Not inside an installed bundle (repo dev run): the developer's PATH is
  // expected to carry a zstd implementation.
  const proc = Bun.spawnSync(['zstd', '-d', '-f', archivePath, '-o', tarPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr?.toString().trim().slice(0, 300) ?? ''
    throw new Error(
      `the downloaded update archive could not be decompressed (zstd exit ${proc.exitCode}${stderr ? `: ${stderr}` : ''})`
    )
  }
}

export async function extractUpdateArchive(
  archivePath: string,
  extractDir: string,
  kind: 'full' | 'slim' = 'full'
): Promise<string> {
  rmSync(extractDir, { force: true, recursive: true })
  mkdirSync(extractDir, { recursive: true })
  // Two steps, never `tar --zstd`: see decompressZstd for why the filter
  // form cannot be relied on inside a launched app.
  const tarPath = join(extractDir, 'archive.tar')
  decompressZstd(archivePath, tarPath)
  const proc = Bun.spawnSync(['tar', '-xf', tarPath, '-C', extractDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  rmSync(tarPath, { force: true })
  if (proc.exitCode !== 0) {
    // The shell's stdio is /dev/null, so the failing command's own words are
    // the only evidence that can explain it; carry them into the error path.
    const stderr = proc.stderr?.toString().trim().slice(0, 300) ?? ''
    const signal = proc.signalCode ? ` signal=${proc.signalCode}` : ''
    console.error(
      `[updater] tar extraction failed: exit=${proc.exitCode}${signal} stderr=${stderr || '(empty)'} archive=${archivePath} dir=${extractDir}`
    )
    throw new Error(
      `the downloaded update archive could not be extracted (tar exit ${proc.exitCode}${signal}${stderr ? `: ${stderr}` : ''})`
    )
  }
  const appPath = join(extractDir, 'Adea.app')
  const resources = join(appPath, 'Contents', 'Resources')
  const main = join(resources, 'main.js')
  if (!existsSync(main)) {
    throw new Error('the extracted update is not a complete Adea bundle')
  }
  if (kind === 'full' && !existsSync(join(appPath, 'Contents', 'MacOS', 'launcher'))) {
    throw new Error('the extracted update is not a complete Adea bundle')
  }
  if (
    kind === 'slim' &&
    (!existsSync(join(resources, 'app', 'client', 'index.html')) ||
      !existsSync(join(resources, 'app', 'bun')))
  ) {
    throw new Error('the extracted slim update is not a complete app layer')
  }
  return appPath
}

/**
 * Runtime binaries a slim overlay must not change: the CEF framework, the Bun
 * runtime, and the launcher. Hashed in this fixed order with one stream, so
 * the release lane and the shell compute identical digests.
 */
export function runtimeBinaryPaths(bundleRoot: string): string[] {
  return [
    join(
      bundleRoot,
      'Contents',
      'Frameworks',
      'Chromium Embedded Framework.framework',
      'Chromium Embedded Framework'
    ),
    join(bundleRoot, 'Contents', 'MacOS', 'bun'),
    join(bundleRoot, 'Contents', 'MacOS', 'launcher'),
  ]
}

/** SHA-256 over the installed bundle's runtime binaries, or null if absent. */
export async function installedRuntimeSha256(
  execPath: string = process.execPath
): Promise<string | null> {
  const macosIndex = execPath.lastIndexOf(`${sep}Contents${sep}MacOS${sep}`)
  if (macosIndex < 0) return null
  const bundleRoot = execPath.slice(0, macosIndex)
  const hasher = new Bun.CryptoHasher('sha256')
  for (const binaryPath of runtimeBinaryPaths(bundleRoot)) {
    if (!existsSync(binaryPath)) return null
    const stream = Bun.file(binaryPath).stream()
    for await (const chunk of stream) hasher.update(chunk as Uint8Array)
  }
  return hasher.digest('hex')
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
  /** `slim` overlays the app layer onto the existing bundle (no framework). */
  mode?: 'full' | 'slim'
}): { target: string; scriptPath: string } | { error: string } {
  const mode = input.mode ?? 'full'
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
  const stopOld = [
    `pkill -f ${JSON.stringify(target)} 2>/dev/null || true`,
    'i=0',
    `while pgrep -f ${JSON.stringify(target)} >/dev/null 2>&1 && [ "$i" -lt 20 ]; do`,
    '  sleep 0.5',
    '  i=$((i+1))',
    'done',
    `pkill -9 -f ${JSON.stringify(target)} 2>/dev/null || true`,
    'sleep 1',
  ]
  // A full archive replaces the bundle (one-move rollback window); a slim
  // archive overlays the app layer onto the existing bundle, keeping the CEF
  // framework and launcher so no multi-minute reinstall runs.
  const apply =
    mode === 'slim'
      ? [`ditto ${JSON.stringify(input.newAppPath)} ${JSON.stringify(target)}`]
      : [
          `rm -rf ${JSON.stringify(previous)}`,
          `mv ${JSON.stringify(target)} ${JSON.stringify(previous)}`,
          `if ! mv ${JSON.stringify(input.newAppPath)} ${JSON.stringify(target)}; then`,
          `  mv ${JSON.stringify(previous)} ${JSON.stringify(target)}`,
          '  exit 1',
          'fi',
          `rm -rf ${JSON.stringify(previous)}`,
        ]
  writeFileSync(
    scriptPath,
    [
      '#!/bin/sh',
      'set -u',
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
      ...stopOld,
      ...apply,
      // -n forces a fresh LaunchServices instance: every old-bundle process
      // is gone by this point, so there is nothing to "activate" and the new
      // launcher bootstraps into the user's GUI session cleanly.
      `open -n ${JSON.stringify(target)}`,
      '',
    ].join('\n'),
    { mode: 0o755 }
  )
  return { target, scriptPath }
}
