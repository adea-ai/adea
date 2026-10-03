import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopPackagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/desktop/package.json'
)
const supportedReleaseVersion = /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/

/**
 * Set the checked-out desktop manifest to the release version being packaged.
 * Release workflows operate on a disposable checkout, so this does not alter
 * the version recorded by the immutable source tag.
 */
export async function setDesktopReleaseVersion(releaseVersion, packagePath = desktopPackagePath) {
  if (typeof releaseVersion !== 'string' || !supportedReleaseVersion.test(releaseVersion)) {
    throw new Error(`Unsupported desktop release version: ${releaseVersion}`)
  }

  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  if (typeof packageJson !== 'object' || packageJson === null || Array.isArray(packageJson)) {
    throw new Error('Desktop package manifest must contain a JSON object.')
  }

  packageJson.version = releaseVersion
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const releaseVersion = process.argv[2]
    const packagePath = process.argv[3]
    await setDesktopReleaseVersion(releaseVersion, packagePath)
    process.stdout.write(`Desktop package version set to ${releaseVersion}.\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
