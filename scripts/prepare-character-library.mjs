import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const defaultPartsRoot = resolve(repoRoot, 'packages/characters/assets')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function usage() {
  console.error(
    'Usage: bun scripts/prepare-character-library.mjs --input <source.glb> --output <prepared.glb> [--parts-root <dir>] [--offset-output <file>]'
  )
  process.exit(1)
}

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

async function findGlbs(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (extname(entry.name).toLowerCase() === '.glb') files.push(path)
    }
  }
  await visit(root)
  return files
}

function positionAccessor(document, meshIndex, primitiveIndex = 0) {
  const primitive = document.meshes?.[meshIndex]?.primitives?.[primitiveIndex]
  const accessorIndex = primitive?.attributes?.POSITION
  const accessor = document.accessors?.[accessorIndex]
  if (!Number.isInteger(accessorIndex) || !accessor) throw new Error('Missing POSITION accessor')
  if (accessor.componentType !== 5126 || accessor.type !== 'VEC3' || accessor.sparse) {
    throw new Error('Character source parts must use non-sparse float VEC3 positions')
  }
  return accessor
}

function positionData(document, bin, accessor) {
  const view = document.bufferViews?.[accessor.bufferView]
  if (!view || view.byteStride) throw new Error('Interleaved POSITION accessors are not supported')
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  return {
    accessor,
    start,
    values: new Float32Array(bin.buffer, bin.byteOffset + start, accessor.count * 3),
  }
}

function subtractOffset(document, bin, meshIndex, offset) {
  const primitives = document.meshes[meshIndex].primitives
  for (let index = 0; index < primitives.length; index += 1) {
    const accessor = positionAccessor(document, meshIndex, index)
    const data = positionData(document, bin, accessor)
    for (let vertex = 0; vertex < data.values.length; vertex += 3) {
      data.values[vertex] -= offset[0]
      data.values[vertex + 1] -= offset[1]
      data.values[vertex + 2] -= offset[2]
    }
    if (accessor.min) accessor.min = accessor.min.map((value, axis) => value - offset[axis])
    if (accessor.max) accessor.max = accessor.max.map((value, axis) => value - offset[axis])
  }
}

function compactNodes(document) {
  const keep = new Set()
  const visit = (nodeIndex) => {
    if (!Number.isInteger(nodeIndex) || keep.has(nodeIndex)) return
    keep.add(nodeIndex)
    document.nodes[nodeIndex]?.children?.forEach(visit)
  }
  document.scenes?.forEach((scene) => scene.nodes?.forEach(visit))
  document.skins?.forEach((skin) => skin.joints?.forEach(visit))
  document.animations?.forEach((animation) =>
    animation.channels?.forEach((channel) => visit(channel.target?.node))
  )

  const oldNodeIndices = [...keep].sort((a, b) => a - b)
  const remap = new Map(oldNodeIndices.map((oldIndex, newIndex) => [oldIndex, newIndex]))
  document.nodes = oldNodeIndices.map((oldIndex) => {
    const node = document.nodes[oldIndex]
    if (node.children) node.children = node.children.map((child) => remap.get(child))
    return node
  })
  document.scenes?.forEach((scene) => {
    if (scene.nodes) scene.nodes = scene.nodes.map((node) => remap.get(node))
  })
  document.skins?.forEach((skin) => {
    if (skin.joints) skin.joints = skin.joints.map((joint) => remap.get(joint))
    if (Number.isInteger(skin.skeleton)) skin.skeleton = remap.get(skin.skeleton)
  })
  document.animations?.forEach((animation) =>
    animation.channels?.forEach((channel) => {
      if (Number.isInteger(channel.target?.node)) channel.target.node = remap.get(channel.target.node)
    })
  )
}

const input = argument('--input')
const output = argument('--output')
const partsRoot = resolve(argument('--parts-root') ?? defaultPartsRoot)
const offsetOutput = argument('--offset-output')
if (!input || !output) usage()

const full = readGlb(await readFile(resolve(input)))
const partFiles = (await findGlbs(partsRoot)).filter(
  (path) => !relative(partsRoot, path).split(/[\\/]/).includes('_complete')
)
const partByName = new Map(partFiles.map((path) => [basename(path, '.glb'), path]))
const skeletonIndex = full.json.nodes?.findIndex((node) => node.name === 'Skeleton_01') ?? -1
const rootBoneIndex = full.json.nodes?.findIndex((node) => node.name === 'Root') ?? -1
if (skeletonIndex < 0 || rootBoneIndex < 0)
  throw new Error('Character source is missing the Skeleton_01 or Root node')
const skeleton = full.json.nodes[skeletonIndex]
skeleton.children = [
  rootBoneIndex,
  ...(skeleton.children ?? []).filter((child) => partByName.has(full.json.nodes[child]?.name)),
]
for (const scene of full.json.scenes ?? []) {
  scene.nodes = (scene.nodes ?? []).filter((node) => node === skeletonIndex)
}
const offsets = {}
let preparedParts = 0

for (const node of full.json.nodes ?? []) {
  if (!Number.isInteger(node.mesh) || !node.name || !partByName.has(node.name)) continue
  if (node.matrix)
    throw new Error(
      `Node ${node.name} uses a matrix; apply it before preparing the character library`
    )
  const partPath = partByName.get(node.name)
  const part = readGlb(await readFile(partPath))
  const fullAccessor = positionAccessor(full.json, node.mesh)
  const partAccessor = positionAccessor(part.json, 0)
  if (!fullAccessor.min || !partAccessor.min) throw new Error(`Missing bounds for ${node.name}`)
  const offset = fullAccessor.min.map((value, axis) => value - partAccessor.min[axis])
  for (
    let primitive = 1;
    primitive < full.json.meshes[node.mesh].primitives.length;
    primitive += 1
  ) {
    const fullMin = positionAccessor(full.json, node.mesh, primitive).min
    const partMin = positionAccessor(part.json, 0, primitive).min
    if (
      !fullMin ||
      !partMin ||
      fullMin.some((value, axis) => Math.abs(value - partMin[axis] - offset[axis]) > 0.0001)
    ) {
      throw new Error(`Primitive bounds disagree for ${node.name}`)
    }
  }
  subtractOffset(full.json, full.bin, node.mesh, offset)
  node.translation = offset
  const pathParts = relative(partsRoot, partPath).split(/[\\/]/)
  const slot = pathParts[0]
  const partSlug = node.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const partId =
    slot === 'costume' && partSlug.startsWith('costume-')
      ? `costume-${partSlug.slice('costume-'.length)}`
      : `${slot}-${partSlug}`
  offsets[partId] = offset.map((value) => Number(value.toFixed(6)))
  preparedParts += 1
}

compactNodes(full.json)
await writeFile(resolve(output), writeGlb(full.json, full.bin))
if (offsetOutput) {
  const lines = [
    '// Generated by scripts/prepare-character-library.mjs.',
    '// Each vector is the source-library placement to remove before rendering.',
    'import type { CharacterPartId } from "./customization";',
    '',
    'export const characterPartOffsets: Readonly<Record<CharacterPartId, readonly [number, number, number]>> = ',
    `${JSON.stringify(
      Object.fromEntries(Object.entries(offsets).map(([name, value]) => [name, value])),
      null,
      2
    )};`,
    '',
  ]
  await writeFile(resolve(offsetOutput), lines.join('\n'))
}
console.log(`Prepared ${preparedParts} character parts from ${relative(repoRoot, input)}`)
