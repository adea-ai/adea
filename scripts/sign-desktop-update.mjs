// Signs the desktop update feed for the release lane. Given a staged
// `Adea-<tag>-macos-arm64.app.tar.zst`, writes `latest.json` beside it with
// the archive's SHA-256 and an Ed25519 signature over
// `adea-desktop-update/v<version>/<sha256>` — the exact tuple the desktop
// shell verifies (apps/desktop/shell/src/updater.ts) before installing.
//
// The private half comes from the `DESKTOP_UPDATE_SIGNING_KEY` repository
// secret (PKCS#8 PEM) and is never written to disk by this script:
//
//   DESKTOP_UPDATE_SIGNING_KEY="$(cat secret.pem)" bun scripts/sign-desktop-update.mjs \
//     --archive "$RUNNER_TEMP/staged/Adea-v0.25.0-macos-arm64.app.tar.zst" \
//     --tag v0.25.0 --notes-file notes.txt --out "$RUNNER_TEMP/staged/latest.json"
import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = 'adea-ai/adea'

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

export async function buildUpdateManifest({ archivePath, tag, notes }) {
  const signingKey = process.env.DESKTOP_UPDATE_SIGNING_KEY
  if (!signingKey) {
    throw new Error('DESKTOP_UPDATE_SIGNING_KEY is not set; refusing to publish an unsigned feed')
  }
  const version = tag.replace(/^v/, '')
  const url = `https://github.com/${REPO}/releases/download/${tag}/Adea-${tag}-macos-arm64.app.tar.zst`
  const archive = await readFile(archivePath)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const signature = cryptoSign(
    null,
    Buffer.from(`adea-desktop-update/v${version}/${sha256}`),
    createPrivateKey(signingKey)
  ).toString('base64')
  return {
    version,
    // Node platform vocabulary — the shell compares this against
    // `process.platform`/`process.arch` before offering the update.
    platform: 'darwin',
    arch: 'arm64',
    url,
    sha256,
    signature,
    notes: notes ?? null,
    publishedAt: new Date().toISOString(),
  }
}

export async function signDesktopUpdate({ archivePath, tag, notes, outPath }) {
  const manifest = await buildUpdateManifest({ archivePath, tag, notes })
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const archivePath = arg('archive')
  const tag = arg('tag')
  const outPath = arg('out')
  if (!archivePath || !tag || !outPath) {
    console.error(
      'usage: bun scripts/sign-desktop-update.mjs --archive <path> --tag <tag> --out <path> [--notes-file <path>]'
    )
    process.exit(1)
  }
  const notesFile = arg('notes-file')
  const notes = notesFile ? await readFile(notesFile, 'utf8') : null
  const manifest = await signDesktopUpdate({ archivePath, tag, notes, outPath })
  console.log(
    `Signed update feed ${manifest.version} (${manifest.sha256.slice(0, 12)}…) → ${outPath}`
  )
}
