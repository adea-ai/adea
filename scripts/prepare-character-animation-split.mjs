import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const input = resolve(repoRoot, 'packages/characters/assets/runtime.glb')
const output = resolve(repoRoot, 'packages/characters/assets/runtime-locomotion.glb')
const keepAnimationNames = new Set(['Idle_Relaxed', 'Run_Forward'])

function readGlb(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('Invalid GLB header')
  const jsonLength = bytes.readUInt32LE(12)
  const jsonType = bytes.readUInt32LE(16)
  if (jsonType !== 0x4e4f534a) throw new Error('GLB JSON chunk must be first')
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).trim())
  let bin
  let offset = 20 + jsonLength
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    if (type === 0x004e4942) bin = Buffer.from(bytes.subarray(offset + 8, offset + 8 + length))
    offset += 8 + length
  }
  if (!bin) throw new Error('GLB has no binary chunk')
  return { json, bin }
}

function writeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json))
  const paddedJson = Buffer.concat([
    jsonBytes,
    Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20),
  ])
  const paddedBin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)])
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBin.length
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(totalLength, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(paddedJson.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(paddedBin.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBin])
}

function collectAccessorIndices(json, keepAnimationNames) {
  const used = new Set()
  const add = (index) => {
    if (Number.isInteger(index)) used.add(index)
  }
  for (const animation of json.animations ?? []) {
    if (!keepAnimationNames.has(animation.name)) continue
    for (const sampler of animation.samplers ?? []) {
      add(sampler.input)
      add(sampler.output)
    }
  }
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      Object.values(primitive.attributes ?? {}).forEach(add)
      add(primitive.indices)
      for (const target of primitive.targets ?? []) Object.values(target).forEach(add)
    }
  }
  for (const skin of json.skins ?? []) add(skin.inverseBindMatrices)
  return used
}

const { json, bin } = readGlb(await readFile(input))
const animations = json.animations ?? []
const keptAnimations = animations.filter((animation) => keepAnimationNames.has(animation.name))
if (keptAnimations.length !== keepAnimationNames.size)
  throw new Error(
    `Expected ${keepAnimationNames.size} animations, found ${keptAnimations.length}: ${keptAnimations.map((animation) => animation.name).join(', ')}`
  )

const accessorIndices = collectAccessorIndices(json, keepAnimationNames)
const accessors = json.accessors ?? []
const viewIndices = new Set()
for (const index of accessorIndices) {
  const view = accessors[index]?.bufferView
  if (Number.isInteger(view)) viewIndices.add(view)
  const sparse = accessors[index]?.sparse
  if (sparse) {
    if (Number.isInteger(sparse.indices?.bufferView)) viewIndices.add(sparse.indices.bufferView)
    if (Number.isInteger(sparse.values?.bufferView)) viewIndices.add(sparse.values.bufferView)
  }
}
for (const image of json.images ?? []) {
  if (Number.isInteger(image.bufferView)) viewIndices.add(image.bufferView)
}

/**
 * Buffer 0 (the GLB binary chunk) holds two kinds of views: raw views that
 * address it directly, and meshopt views whose compressed payload lives at the
 * extension's byteOffset while the view's own fields address a virtual
 * fallback buffer that is declared but never embedded (meshopt support is
 * required). Raw views copy their bytes and get remapped offsets; meshopt
 * views copy their compressed payload and keep their decoded-layout fields.
 */
const viewCopies = []
const views = json.bufferViews ?? []
for (const index of viewIndices) {
  const view = views[index]
  if (!view) throw new Error(`Missing buffer view ${index}`)
  const meshopt = view.extensions?.EXT_meshopt_compression
  if (meshopt) {
    viewCopies.push({
      index,
      view,
      sourceOffset: meshopt.byteOffset ?? 0,
      byteLength: meshopt.byteLength ?? 0,
      compressed: meshopt,
    })
    continue
  }
  if ((view.buffer ?? 0) !== 0)
    throw new Error(`Buffer view ${index} reads from a buffer that is not embedded`)
  viewCopies.push({
    index,
    view,
    sourceOffset: view.byteOffset ?? 0,
    byteLength: view.byteLength ?? 0,
  })
}

let cursor = 0
const chunks = []
for (const copy of viewCopies) {
  const padding = (4 - (cursor % 4)) % 4
  if (padding) {
    chunks.push(Buffer.alloc(padding))
    cursor += padding
  }
  chunks.push(bin.subarray(copy.sourceOffset, copy.sourceOffset + copy.byteLength))
  copy.newOffset = cursor
  cursor += copy.byteLength
}

const viewRemap = new Map()
const newViews = []
for (const copy of viewCopies) {
  const next = { ...copy.view }
  if (copy.compressed) {
    next.extensions = {
      ...copy.view.extensions,
      EXT_meshopt_compression: {
        ...copy.compressed,
        byteOffset: copy.newOffset,
      },
    }
  } else {
    next.byteOffset = copy.newOffset
  }
  viewRemap.set(copy.index, newViews.length)
  newViews.push(next)
}

const accessorRemap = new Map()
const newAccessors = []
for (const index of [...accessorIndices].sort((a, b) => a - b)) {
  const accessor = accessors[index]
  if (!accessor) throw new Error(`Missing accessor ${index}`)
  accessorRemap.set(index, newAccessors.length)
  newAccessors.push({ ...accessor, bufferView: viewRemap.get(accessor.bufferView) })
}

const remapAnimation = (animation) => ({
  ...animation,
  samplers: (animation.samplers ?? []).map((sampler) => ({
    ...sampler,
    input: accessorRemap.get(sampler.input),
    output: accessorRemap.get(sampler.output),
  })),
})

const remapAccessorReference = (index) =>
  Number.isInteger(index) ? accessorRemap.get(index) : index

// The fallback buffer declaration is kept verbatim: it carries the decoded
// byte totals, never embedded data, and meshopt support is required.
const [compressedBuffer, ...otherBuffers] = json.buffers ?? []
if (!compressedBuffer || otherBuffers.some((buffer) => buffer.uri))
  throw new Error('Unexpected buffer layout in the source GLB')

const nextJson = {
  ...json,
  animations: keptAnimations.map(remapAnimation),
  images: (json.images ?? []).map((image) => ({
    ...image,
    bufferView: viewRemap.get(image.bufferView),
  })),
  meshes: (json.meshes ?? []).map((mesh) => ({
    ...mesh,
    primitives: (mesh.primitives ?? []).map((primitive) => ({
      ...primitive,
      attributes: Object.fromEntries(
        Object.entries(primitive.attributes ?? {}).map(([semantic, index]) => [
          semantic,
          accessorRemap.get(index),
        ])
      ),
      indices: remapAccessorReference(primitive.indices),
      targets: (primitive.targets ?? []).map((target) =>
        Object.fromEntries(
          Object.entries(target).map(([semantic, index]) => [semantic, accessorRemap.get(index)])
        )
      ),
    })),
  })),
  skins: (json.skins ?? []).map((skin) => ({
    ...skin,
    inverseBindMatrices: remapAccessorReference(skin.inverseBindMatrices),
  })),
  accessors: newAccessors,
  bufferViews: newViews,
  buffers: [{ ...compressedBuffer, byteLength: cursor }, ...otherBuffers],
}

await writeFile(output, writeGlb(nextJson, Buffer.concat(chunks)))
const source = await readFile(input)
const result = await readFile(output)
console.log(
  `runtime-locomotion.glb: kept ${keptAnimations.length} of ${animations.length} animations, ${result.length} bytes (source ${source.length})`
)
