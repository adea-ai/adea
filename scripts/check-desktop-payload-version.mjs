import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const versionEntry = 'Adea.app/Contents/Resources/version.json'
const supportedVersion = /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/

/** Verify the installed app identity inside Hutch's compressed installer payload. */
export function checkDesktopPayloadVersion(payloadPath, releaseVersion) {
  if (typeof releaseVersion !== 'string' || !supportedVersion.test(releaseVersion)) {
    throw new Error('A supported desktop release version is required.')
  }
  const result = spawnSync('tar', ['--zstd', '-xOf', payloadPath, versionEntry], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 60_000,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not read packaged native version: ${result.error?.message ?? result.stderr.trim()}`
    )
  }
  const metadata = JSON.parse(result.stdout)
  if (!metadata || Array.isArray(metadata) || typeof metadata.version !== 'string') {
    throw new Error('Packaged native version metadata must contain a version string.')
  }
  if (metadata.version !== releaseVersion) {
    throw new Error(
      `Packaged native version ${metadata.version} does not match release ${releaseVersion}.`
    )
  }
  return metadata.version
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${checkDesktopPayloadVersion(process.argv[2], process.argv[3])}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
