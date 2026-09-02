/* global Bun */

import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const characterAssetRoot = resolve(repoRoot, 'packages/characters/assets')

const runtimeAssetSources = [
  [characterAssetRoot, 'runtime.glb'],
  [characterAssetRoot, 'characters.glb'],
  // Reference characters are selectable at runtime, so keep their transfer
  // and decode costs in the same compression gate as the shared libraries.
  [characterAssetRoot, '_complete/**/*.glb'],
  [resolve(repoRoot, 'packages/pets/assets'), '**/*.glb'],
  [resolve(repoRoot, 'packages/landscape/assets'), '**/*.glb'],
]

const interiorAssetSources = [[resolve(repoRoot, 'packages/interior/assets'), '**/*.glb']]
const allAssetSources = [
  ...runtimeAssetSources,
  [characterAssetRoot, '**/*.glb'],
  [resolve(repoRoot, 'packages/architecture/assets'), '**/*.glb'],
  ...interiorAssetSources,
  [resolve(repoRoot, 'packages/rooms/assets'), '**/*.glb'],
]

// This is an authoring/reference map, not a model loaded by the application.
// Keep it in the repository unchanged so it remains useful as source data.
const excludedAssetPaths = new Set([resolve(characterAssetRoot, 'assets_map.glb')])
// Meshopt's container metadata is larger than a few tiny source models. Keep
// those files untouched when compression would make them larger.
const minimumCompressionInputBytes = 100_000
const requestedScope = process.argv
  .find((argument) => argument.startsWith('--scope='))
  ?.slice('--scope='.length)
if (requestedScope && requestedScope !== 'interior') {
  throw new Error(`Unknown asset optimization scope: ${requestedScope}`)
}
const optimizeAllAssets = process.argv.includes('--all')
const assetSources =
  requestedScope === 'interior'
    ? interiorAssetSources
    : optimizeAllAssets
      ? allAssetSources
      : runtimeAssetSources
const assetScopeLabel = requestedScope ?? (optimizeAllAssets ? 'all' : 'runtime')

async function* assetPaths() {
  const seen = new Set()
  for (const [assetRoot, pattern] of assetSources) {
    for await (const relativePath of new Bun.Glob(pattern).scan({ cwd: assetRoot })) {
      const input = join(assetRoot, relativePath)
      if (excludedAssetPaths.has(input) || seen.has(input)) continue
      seen.add(input)
      yield input
    }
  }
}

function readGlbJson(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error('Invalid GLB header')
  }
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    if (type === 0x4e4f534a) {
      return JSON.parse(bytes.toString('utf8', offset + 8, offset + 8 + length))
    }
    offset += 8 + length
  }
  throw new Error('GLB has no JSON chunk')
}

function textureSource(document, textureIndex) {
  const texture = document.textures?.[textureIndex]
  if (!texture) return undefined
  const webpSource = texture.extensions?.EXT_texture_webp?.source
  if (Number.isInteger(webpSource)) return { mimeType: 'image/webp', source: webpSource }
  const ktx2Source = texture.extensions?.KHR_texture_basisu?.source
  if (Number.isInteger(ktx2Source)) return { mimeType: 'image/ktx2', source: ktx2Source }
  const source = texture.source
  if (!Number.isInteger(source)) return undefined
  return { mimeType: document.images?.[source]?.mimeType ?? 'unknown', source }
}

function materialTextureMimes(document, slot) {
  const sources = []
  for (const material of document.materials ?? []) {
    const materialProperties =
      slot === 'baseColorTexture' || slot === 'metallicRoughnessTexture'
        ? material.pbrMetallicRoughness
        : material
    const textureIndex = materialProperties?.[slot]?.index
    const texture = textureSource(document, textureIndex)
    if (texture) sources.push(texture.mimeType)
  }
  return sources
}

function areTexturesCompressed(mimes) {
  return mimes.every((mime) => mime === 'image/webp' || mime === 'image/ktx2')
}

function compressionStatus(document) {
  const baseColor = materialTextureMimes(document, 'baseColorTexture')
  const normal = materialTextureMimes(document, 'normalTexture')
  return {
    meshopt: document.extensionsUsed?.includes('EXT_meshopt_compression') ?? false,
    baseColorCompressed: areTexturesCompressed(baseColor),
    normalCompressed: areTexturesCompressed(normal),
    baseColor,
    normal,
  }
}

async function runTransform(args) {
  const process = Bun.spawn(['bunx', '--bun', '@gltf-transform/cli@4.4.2', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) {
    throw new Error(`gltf-transform ${args[0]} failed for ${args[1]}`)
  }
}

async function checkAssets() {
  const failures = []
  let assets = 0
  let smallAssetsKeptRaw = 0
  let normalMapCandidates = 0
  let normalMapCompressed = 0
  for await (const input of assetPaths()) {
    const document = readGlbJson(Buffer.from(await readFile(input)))
    const status = compressionStatus(document)
    const inputBytes = (await stat(input)).size
    assets += 1
    for (const material of document.materials ?? []) {
      const textureIndex = material.normalTexture?.index
      if (!Number.isInteger(textureIndex)) continue
      normalMapCandidates += 1
      if (areTexturesCompressed([textureSource(document, textureIndex)?.mimeType]))
        normalMapCompressed += 1
    }
    if (!status.meshopt || !status.baseColorCompressed || !status.normalCompressed) {
      if (inputBytes < minimumCompressionInputBytes) {
        smallAssetsKeptRaw += 1
      } else {
        if (!status.meshopt)
          failures.push(`${relative(repoRoot, input)} is missing Meshopt compression`)
        if (!status.baseColorCompressed) {
          failures.push(`${relative(repoRoot, input)} has non-compressed base-color textures`)
        }
        if (!status.normalCompressed) {
          failures.push(`${relative(repoRoot, input)} has non-compressed normal-map textures`)
        }
      }
    }
  }
  console.log(
    `Checked ${assets} ${assetScopeLabel} assets: Meshopt and WebP/KTX2 material textures are present for assets >= ${minimumCompressionInputBytes} bytes. Kept ${smallAssetsKeptRaw} smaller assets raw because compression would add overhead. Normal maps: ${normalMapCompressed}/${normalMapCandidates} WebP/KTX2-ready.`
  )
  if (failures.length > 0) {
    throw new Error(`Asset compression gate failed:\n${failures.join('\n')}`)
  }
}

async function optimizeAsset(input, index, tempRoot, status) {
  const inputStat = await stat(input)
  const stem = `${index}-${basename(input, '.glb')}`
  const webpOutput = join(tempRoot, `${stem}.webp.glb`)
  const meshoptOutput = join(tempRoot, `${stem}.meshopt.glb`)

  // High-quality WebP minimizes visible texture differences while reducing
  // PNG/JPEG payloads. Meshopt is deliberately run with high attribute
  // precision: it compresses geometry and animation without simplifying the
  // authored model.
  if (!status.baseColorCompressed) {
    await runTransform([
      'webp',
      input,
      webpOutput,
      '--slots',
      'baseColorTexture',
      '--quality',
      '100',
    ])
  } else {
    await copyFile(input, webpOutput)
  }
  let textureOutput = webpOutput
  if (!status.normalCompressed) {
    textureOutput = join(tempRoot, `${stem}.normal.webp.glb`)
    await runTransform([
      'webp',
      webpOutput,
      textureOutput,
      '--slots',
      'normalTexture',
      '--lossless',
    ])
  }
  await runTransform([
    'meshopt',
    textureOutput,
    meshoptOutput,
    '--level',
    'high',
    '--quantize-position',
    '16',
    '--quantize-normal',
    '16',
    '--quantize-texcoord',
    '16',
    '--quantize-color',
    '16',
    '--quantize-generic',
    '16',
    '--quantize-weight',
    '16',
  ])

  const outputStat = await stat(meshoptOutput)
  if (outputStat.size < inputStat.size) {
    await mkdir(dirname(input), { recursive: true })
    await copyFile(meshoptOutput, input)
    return { before: inputStat.size, after: outputStat.size, replaced: true }
  }
  return { before: inputStat.size, after: inputStat.size, replaced: false }
}

async function optimizeAssets() {
  const inputs = []
  for await (const input of assetPaths()) inputs.push(input)

  const tempRoot = await mkdtemp('/tmp/agent-hq-runtime-assets-')
  const concurrency = Math.max(
    1,
    Number.parseInt(process.env.ASSET_OPTIMIZE_CONCURRENCY ?? '4', 10) || 4
  )
  const results = []
  const failures = []
  let nextIndex = 0

  async function worker() {
    while (true) {
      const index = nextIndex++
      if (index >= inputs.length) return
      const input = inputs[index]
      try {
        const document = readGlbJson(Buffer.from(await readFile(input)))
        const status = compressionStatus(document)
        const inputBytes = (await stat(input)).size
        if (status.meshopt && status.baseColorCompressed && status.normalCompressed) {
          results.push({ before: inputBytes, after: inputBytes, skipped: true })
          console.log(`Skipping already optimized ${relative(repoRoot, input)}`)
          continue
        }
        const result = await optimizeAsset(input, index, tempRoot, status)
        results.push(result)
        console.log(
          `${result.replaced ? 'Optimized' : 'Keeping'} ${relative(repoRoot, input)} ${(result.before / 1024 / 1024).toFixed(2)} MiB -> ${(result.after / 1024 / 1024).toFixed(2)} MiB${result.replaced ? '' : ' (compressed output was not smaller)'}`
        )
      } catch (cause) {
        failures.push(
          `${relative(repoRoot, input)}: ${cause instanceof Error ? cause.message : cause}`
        )
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    throw new Error(`Asset optimization failed:\n${failures.join('\n')}`)
  }

  const changed = results.filter((result) => result.replaced)
  const beforeBytes = results.reduce((total, result) => total + result.before, 0)
  const afterBytes = results.reduce((total, result) => total + result.after, 0)
  const reduction = beforeBytes > 0 ? (1 - afterBytes / beforeBytes) * 100 : 0
  console.log(
    `Optimized ${changed.length} ${assetScopeLabel} assets (${results.length - changed.length} unchanged or already optimized): ${(beforeBytes / 1024 / 1024).toFixed(2)} MiB -> ${(afterBytes / 1024 / 1024).toFixed(2)} MiB (${reduction.toFixed(1)}% smaller)`
  )
}

if (process.argv.includes('--check')) await checkAssets()
else await optimizeAssets()
