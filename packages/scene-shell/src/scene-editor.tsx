'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  Copy,
  Grid3X3,
  Move3D,
  Redo2,
  Rotate3D,
  Save,
  Scaling,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import * as THREE from 'three'
import {
  TransformControls,
  type TransformControlsMode,
} from 'three/examples/jsm/controls/TransformControls.js'
import { Button } from '@agent-hq/ui/components/ui/button'
import type { SceneManifest } from '@agent-hq/asset-manifests'
import type { CameraViewMode, SceneDebugApi } from '@agent-hq/scene-runtime'

type SceneEditorProps = {
  manifest: SceneManifest
  debugApiRef: { current: SceneDebugApi | null }
  cameraViewMode: CameraViewMode
  selectionMode?: 'objects' | 'zones'
  lockedObjectPrefixes?: readonly string[]
}

type Placement = {
  p: [number, number, number]
  q: [number, number, number, number]
  s: [number, number, number]
}

type PlacementManifest = {
  placements: Record<string, Placement[]>
}

type FieldCategory = 'foliage' | 'props'

type TransformSnapshot = {
  position: [number, number, number]
  quaternion: [number, number, number, number]
  scale: [number, number, number]
}

type PlacementSelection = {
  kind: 'placement'
  target: THREE.Object3D
  name: string
  path: string
  category: FieldCategory
  modelId: string
  placementIndex: number
  manifestUrl: string
  siblings: Array<{
    object: THREE.Mesh | THREE.InstancedMesh
    instanceIndex: number
    sourceMatrix: THREE.Matrix4
  }>
  original: TransformSnapshot
}

type ObjectSelection = {
  kind: 'object'
  target: THREE.Object3D
  name: string
  path: string
  editable: boolean
  deleted: boolean
  info: Record<string, unknown>
  original: TransformSnapshot
}

type EditorSelection = PlacementSelection | ObjectSelection

type HistoryEntry = {
  selection: EditorSelection
  before: TransformSnapshot
  after: TransformSnapshot
}

const FIELD_GROUPS: Record<string, FieldCategory> = {
  'landscape-field': 'foliage',
  foliage: 'foliage',
  'props-field': 'props',
  props: 'props',
}

const MODE_LABELS: Array<{ mode: TransformControlsMode; label: string; icon: typeof Move3D }> = [
  { mode: 'translate', label: 'Move', icon: Move3D },
  { mode: 'rotate', label: 'Rotate', icon: Rotate3D },
  { mode: 'scale', label: 'Scale', icon: Scaling },
]

function snapshot(object: THREE.Object3D): TransformSnapshot {
  return {
    position: object.position.toArray(),
    quaternion: object.quaternion.toArray(),
    scale: object.scale.toArray(),
  }
}

function applySnapshot(object: THREE.Object3D, value: TransformSnapshot): void {
  object.position.fromArray(value.position)
  object.quaternion.fromArray(value.quaternion)
  object.scale.fromArray(value.scale)
  object.updateMatrix()
  object.updateMatrixWorld(true)
}

function snapshotsEqual(left: TransformSnapshot, right: TransformSnapshot): boolean {
  return [...left.position, ...left.quaternion, ...left.scale].every(
    (value, index) =>
      Math.abs(value - [...right.position, ...right.quaternion, ...right.scale][index]) < 1e-7
  )
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

function placementFromSnapshot(value: TransformSnapshot): Placement {
  return {
    p: value.position.map(round) as Placement['p'],
    q: value.quaternion.map(round) as Placement['q'],
    s: value.scale.map(round) as Placement['s'],
  }
}

type FieldHit = {
  root: THREE.Object3D
  category: FieldCategory
  modelId?: string
  chunkKey?: string
  bakedNodeName?: string
}

function findFieldHit(object: THREE.Object3D, scene: THREE.Scene): FieldHit | null {
  const ancestors: THREE.Object3D[] = []
  let current: THREE.Object3D | null = object
  while (current) {
    ancestors.push(current)
    current = current.parent
  }

  for (const category of CATEGORIES) {
    const bakedNode = ancestors.find(
      (candidate) =>
        candidate.name.startsWith(`${category}:`) ||
        (candidate.name.startsWith(category) &&
          candidate.name !== category &&
          candidate.name.endsWith('all'))
    )
    if (!bakedNode) continue
    const root = ancestors.find(
      (candidate) => candidate.name === category || candidate.name === `${category}-field`
    )
    if (root) return { root, category, bakedNodeName: bakedNode.name }
  }

  current = object
  while (current) {
    const runtimeCategory = FIELD_GROUPS[current.parent?.name ?? '']
    if (runtimeCategory) {
      return {
        root: current.parent as THREE.Object3D,
        category: runtimeCategory,
        modelId: current.name,
        chunkKey: 'all',
      }
    }
    const [category, modelId, , chunkKey] = current.name.split(':', 4)
    if (CATEGORIES.has(category as FieldCategory) && modelId && chunkKey) {
      let root = current
      while (root.parent && root.parent !== scene) root = root.parent
      return { root, category: category as FieldCategory, modelId, chunkKey }
    }
    for (const fieldCategory of CATEGORIES) {
      if (current.name.endsWith(`-${fieldCategory}`)) {
        return { root: current, category: fieldCategory, bakedNodeName: object.name }
      }
      if (current.name.startsWith(fieldCategory)) {
        let root = current
        while (root.parent && root.parent !== scene) root = root.parent
        return {
          root,
          category: fieldCategory,
          bakedNodeName: current.name.split(' component ', 1)[0],
        }
      }
    }
    current = current.parent
  }
  return null
}

function isPickable(object: THREE.Object3D, helper: THREE.Object3D): boolean {
  if (object.name.startsWith('scene-editor-') || helper.getObjectById(object.id)) return false
  let current: THREE.Object3D | null = object
  while (current) {
    if (!current.visible) return false
    current = current.parent
  }
  return true
}

function isLockedObject(object: THREE.Object3D, lockedObjectPrefixes: readonly string[]): boolean {
  let current: THREE.Object3D | null = object
  while (current) {
    if (
      lockedObjectPrefixes.some(
        (prefix) => current?.name === prefix || current?.name.startsWith(prefix)
      )
    )
      return true
    current = current.parent
  }
  return false
}

function isInScene(object: THREE.Object3D, scene: THREE.Scene): boolean {
  let current: THREE.Object3D | null = object
  while (current) {
    if (current === scene) return true
    current = current.parent
  }
  return false
}

function findZoneRoot(object: THREE.Object3D, scene: THREE.Scene): THREE.Object3D | null {
  let current: THREE.Object3D | null = object
  while (current && current !== scene) {
    if (current.name.startsWith('zone:')) return current
    current = current.parent
  }
  return null
}

const CATEGORIES = new Set<FieldCategory>(['foliage', 'props'])

function placementIndicesForChunk(placements: Placement[], chunkKey: string): number[] {
  if (chunkKey === 'all') return placements.map((_, index) => index)
  const [chunkX, chunkZ] = chunkKey.split(',').map(Number)
  if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ))
    return placements.map((_, index) => index)
  return placements.flatMap((placement, index) =>
    Math.floor(placement.p[0] / 128) === chunkX && Math.floor(placement.p[2] / 128) === chunkZ
      ? [index]
      : []
  )
}

function resolveBakedFieldIdentity(
  field: FieldHit,
  source: PlacementManifest
): { modelId: string; chunkKey: string } | null {
  if (field.modelId && field.chunkKey) return { modelId: field.modelId, chunkKey: field.chunkKey }
  const nodeName = field.bakedNodeName
  if (!nodeName) return null
  const modelId = Object.keys(source.placements)
    .filter(
      (candidate) =>
        nodeName.startsWith(`${field.category}${candidate}`) ||
        nodeName.startsWith(`${field.category}:${candidate}:`)
    )
    .sort((left, right) => right.length - left.length)[0]
  if (!modelId) return null
  const chunkKey = nodeName.endsWith('all') ? 'all' : nodeName.match(/(-?\d+,-?\d+)$/)?.[1]
  return chunkKey ? { modelId, chunkKey } : null
}

function fieldRootForSelection(
  field: FieldHit,
  object: THREE.Object3D,
  scene: THREE.Scene
): THREE.Object3D {
  if (field.modelId && field.chunkKey) {
    let root = object
    while (root.parent && root.parent !== scene) root = root.parent
    return root
  }
  return field.root
}

function fieldManifestUrl(manifest: SceneManifest, category: FieldCategory): string | undefined {
  if (category === 'foliage') return manifest.foliageManifestUrl
  return manifest.propsManifestUrl
}

function formatInfoVector(value: unknown): string {
  if (!Array.isArray(value)) return '?'
  return value
    .map((entry) => (typeof entry === 'number' ? entry.toFixed(2) : String(entry)))
    .join('  ')
}

function formatInputNumber(value: number): string {
  return String(Number(value.toFixed(6)))
}

function TransformNumberInput({
  value,
  onChange,
  disabled,
  label,
}: {
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  label: string
}) {
  const [draft, setDraft] = useState(() => formatInputNumber(value))
  const focusedRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) setDraft(formatInputNumber(value))
  }, [value])

  return (
    <input
      type="number"
      inputMode="decimal"
      step="any"
      aria-label={label}
      value={draft}
      disabled={disabled}
      onFocus={(event) => {
        focusedRef.current = true
        event.currentTarget.select()
      }}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (next.trim() === '') return
        const parsed = Number(next)
        if (Number.isFinite(parsed)) onChange(parsed)
      }}
      onBlur={() => {
        focusedRef.current = false
        setDraft(formatInputNumber(value))
      }}
      className="min-w-0 rounded border border-transparent bg-transparent px-0 py-0 text-right text-[11px] text-white outline-none transition-colors hover:border-white/10 focus:border-[#58a6ff] focus:bg-black/25 disabled:cursor-not-allowed disabled:opacity-40"
    />
  )
}

export function SceneEditor({
  manifest,
  debugApiRef,
  cameraViewMode,
  selectionMode = 'objects',
  lockedObjectPrefixes = [],
}: SceneEditorProps) {
  const [api, setApi] = useState<SceneDebugApi | null>(null)
  const [selection, setSelection] = useState<EditorSelection | null>(null)
  const [mode, setMode] = useState<TransformControlsMode>('translate')
  const [space, setSpace] = useState<'world' | 'local'>('world')
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState(
    selectionMode === 'zones'
      ? 'Click a room in the scene to move the whole room.'
      : 'Click an object in the scene to edit it.'
  )
  const [saving, setSaving] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(0)
  const controlsRef = useRef<TransformControls | null>(null)
  const selectionRef = useRef<EditorSelection | null>(null)
  const manifestCacheRef = useRef(new Map<string, Promise<PlacementManifest>>())
  const editsRef = useRef(new Map<string, TransformSnapshot>())
  const historyRef = useRef<HistoryEntry[]>([])
  const historyIndexRef = useRef(0)
  const dragStartRef = useRef<TransformSnapshot | null>(null)
  const placementTargetsRef = useRef(new Map<string, THREE.Object3D>())
  const selectionRequestRef = useRef(0)

  useEffect(() => {
    let frame = 0
    const waitForApi = () => {
      const current = debugApiRef.current
      if (current) {
        setApi(current)
        return
      }
      frame = requestAnimationFrame(waitForApi)
    }
    waitForApi()
    return () => cancelAnimationFrame(frame)
  }, [debugApiRef])

  useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  const setObjectDeleted = useCallback(
    (deleted: boolean) => {
      const active = selectionRef.current
      if (selectionMode === 'zones' || !active || active.kind !== 'object' || !active.editable)
        return
      active.target.visible = !deleted
      active.target.updateMatrixWorld(true)
      const next = { ...active, deleted }
      selectionRef.current = next
      setSelection(next)
      if (deleted) controlsRef.current?.detach()
      else controlsRef.current?.attach(next.target)
      setRevision((value) => value + 1)
      setStatus(
        deleted
          ? 'Object deleted. Save source to persist it.'
          : 'Object restored. Save source to persist it.'
      )
    },
    [selectionMode]
  )

  useEffect(() => {
    historyIndexRef.current = historyIndex
  }, [historyIndex])

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    controls.setMode(mode)
    controls.setSpace(space)
    controls.setTranslationSnap(snapEnabled ? 0.25 : null)
    controls.setRotationSnap(snapEnabled ? THREE.MathUtils.degToRad(15) : null)
    controls.setScaleSnap(snapEnabled ? 0.1 : null)
  }, [mode, snapEnabled, space])

  useEffect(() => {
    if (!api) return
    const { scene, renderer } = api
    const camera = api.camera
    const canvas = renderer.domElement
    const controls = new TransformControls(camera, null)
    const helper = controls.getHelper()
    helper.name = 'scene-editor-gizmo'
    helper.renderOrder = 10_000
    controls.setSize(0.8)
    controls.setColors(0xf45b69, 0x64d98b, 0x58a6ff, 0xffd166)
    scene.add(helper)
    controlsRef.current = controls
    window.dispatchEvent(new Event('blur'))
    if (document.pointerLockElement) document.exitPointerLock()

    const updatePlacementMeshes = (active: EditorSelection) => {
      if (active.kind !== 'placement') {
        active.target.updateMatrix()
        active.target.updateMatrixWorld(true)
        return
      }
      active.target.updateMatrix()
      for (const sibling of active.siblings) {
        const matrix = active.target.matrix.clone().multiply(sibling.sourceMatrix)
        if (sibling.object instanceof THREE.InstancedMesh) {
          sibling.object.setMatrixAt(sibling.instanceIndex, matrix)
          sibling.object.instanceMatrix.needsUpdate = true
          sibling.object.computeBoundingSphere()
        } else {
          matrix.decompose(sibling.object.position, sibling.object.quaternion, sibling.object.scale)
          sibling.object.updateMatrix()
          sibling.object.updateMatrixWorld(true)
        }
      }
      const key = `${active.category}:${active.modelId}:${active.placementIndex}`
      editsRef.current.set(key, snapshot(active.target))
    }

    const clearDetachedSelection = (message: string) => {
      controls.detach()
      selectionRef.current = null
      setSelection(null)
      setStatus(message)
    }

    const selectionIsAttached = (active: EditorSelection | null) =>
      active != null && isInScene(active.target, scene)

    const onZoneUnloading = (event: Event) => {
      const root = (event as CustomEvent<{ root?: THREE.Object3D }>).detail?.root
      const active = selectionRef.current
      if (!root || !active || !root.getObjectById(active.target.id)) return
      clearDetachedSelection('Selection cleared because its zone is unloading.')
    }

    let selectionGraphFrame = 0
    const checkSelectionGraph = () => {
      const active = selectionRef.current
      if (active && !selectionIsAttached(active)) {
        clearDetachedSelection('Selection cleared because the object left the scene.')
      }
      selectionGraphFrame = requestAnimationFrame(checkSelectionGraph)
    }
    selectionGraphFrame = requestAnimationFrame(checkSelectionGraph)

    const onObjectChange = () => {
      const active = selectionRef.current
      if (!active) return
      updatePlacementMeshes(active)
      setRevision((value) => value + 1)
      setStatus('Unsaved transform change.')
    }
    const onMouseDown = () => {
      const active = selectionRef.current
      if (active) dragStartRef.current = snapshot(active.target)
    }
    const onMouseUp = () => {
      const active = selectionRef.current
      const before = dragStartRef.current
      dragStartRef.current = null
      if (!active || !before) return
      const after = snapshot(active.target)
      if (snapshotsEqual(before, after)) return
      const next = historyRef.current.slice(0, historyIndexRef.current)
      next.push({ selection: active, before, after })
      historyRef.current = next
      historyIndexRef.current = next.length
      setHistoryIndex(next.length)
    }
    controls.addEventListener('objectChange', onObjectChange)
    controls.addEventListener('mouseDown', onMouseDown)
    controls.addEventListener('mouseUp', onMouseUp)

    const pointer = (event: PointerEvent, button = event.button) => {
      const rect = canvas.getBoundingClientRect()
      return {
        x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
        button,
      } as PointerEvent
    }

    const pointerVector = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      )
    }

    const loadManifest = (url: string) => {
      let request = manifestCacheRef.current.get(url)
      if (!request) {
        request = fetch(url).then(async (response) => {
          if (!response.ok) throw new Error(`Could not load ${url}`)
          return response.json() as Promise<PlacementManifest>
        })
        manifestCacheRef.current.set(url, request)
      }
      return request
    }

    const selectPlacement = async (
      object: THREE.Mesh | THREE.InstancedMesh,
      instanceIndex: number,
      field: FieldHit,
      requestId: number
    ) => {
      const { category } = field
      const fieldRoot = fieldRootForSelection(field, object, scene)
      if (!isInScene(fieldRoot, scene)) return false
      const manifestUrl = fieldManifestUrl(manifest, category)
      if (!manifestUrl) return false
      try {
        const source = await loadManifest(manifestUrl)
        if (selectionRequestRef.current !== requestId) return false
        const identity = resolveBakedFieldIdentity(field, source)
        if (!identity) return false
        const { modelId, chunkKey } = identity
        const modelPlacements = source.placements[modelId]
        const placementIndex = placementIndicesForChunk(modelPlacements ?? [], chunkKey)[
          instanceIndex
        ]
        const placement = source.placements[modelId]?.[placementIndex]
        if (!placement) return false
        const key = `${category}:${modelId}:${placementIndex}`
        const current = editsRef.current.get(key) ?? {
          position: placement.p,
          quaternion: placement.q,
          scale: placement.s,
        }
        const placementMatrix = new THREE.Matrix4().compose(
          new THREE.Vector3(...current.position),
          new THREE.Quaternion(...current.quaternion),
          new THREE.Vector3(...current.scale)
        )
        const inversePlacement = placementMatrix.clone().invert()
        const siblings: PlacementSelection['siblings'] = []
        fieldRoot.traverse((candidate) => {
          const runtimeMatch = candidate.name === modelId
          const bakedMatch =
            (candidate.name.startsWith(`${category}:${modelId}:`) ||
              candidate.name.startsWith(`${category}${modelId}`)) &&
            candidate.name.endsWith(chunkKey)
          const bakedAncestorMatch =
            field.bakedNodeName != null &&
            (() => {
              let ancestor: THREE.Object3D | null = candidate
              while (ancestor && ancestor !== fieldRoot) {
                if (ancestor.name === field.bakedNodeName) return true
                ancestor = ancestor.parent
              }
              return false
            })()
          if (
            (!runtimeMatch && !bakedMatch && !bakedAncestorMatch) ||
            !(candidate instanceof THREE.Mesh || candidate instanceof THREE.InstancedMesh)
          )
            return
          const matrix = new THREE.Matrix4()
          if (candidate instanceof THREE.InstancedMesh) candidate.getMatrixAt(instanceIndex, matrix)
          else matrix.copy(candidate.matrix)
          siblings.push({
            object: candidate,
            instanceIndex,
            sourceMatrix: inversePlacement.clone().multiply(matrix),
          })
        })
        if (siblings.length === 0) return false
        let target = placementTargetsRef.current.get(key)
        if (!target) {
          target = new THREE.Object3D()
          target.name = `scene-editor-target:${modelId}:${placementIndex}`
          placementTargetsRef.current.set(key, target)
        }
        applySnapshot(target, current)
        if (!target.parent) fieldRoot.add(target)
        const next: PlacementSelection = {
          kind: 'placement',
          target,
          name: modelId,
          path: `${category} / ${modelId} / ${placementIndex}`,
          category,
          modelId,
          placementIndex,
          manifestUrl,
          siblings,
          original: { position: placement.p, quaternion: placement.q, scale: placement.s },
        }
        controls.detach().attach(target)
        selectionRef.current = next
        setSelection(next)
        setRevision((value) => value + 1)
        setStatus('Drag an axis or choose move, rotate, or scale.')
        return true
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open this placement.')
        return false
      }
    }

    const selectObjectAtPointer = (clientX: number, clientY: number) => {
      const picked = api.pick(clientX, clientY)
      const rawTarget = picked?.sourceObject ?? picked?.object
      if (!(rawTarget instanceof THREE.Object3D)) {
        setStatus('That runtime hit has no inspectable scene object.')
        return false
      }
      let target: THREE.Object3D = rawTarget
      if (
        !target ||
        target === scene ||
        (api.characterRoot && target.getObjectById(api.characterRoot.id))
      ) {
        setStatus('That runtime object is not editable.')
        return false
      }
      if (isLockedObject(target, lockedObjectPrefixes)) {
        setStatus('That structural scene layer is locked. Select foliage or furniture to edit it.')
        return false
      }
      if (selectionMode === 'zones') {
        const zoneRoot = findZoneRoot(target, scene)
        if (!zoneRoot) {
          setStatus('Click a room surface to edit the whole room.')
          return false
        }
        target = zoneRoot
      }
      const editable = !(target instanceof THREE.InstancedMesh && picked?.instanceId != null)
      if (!isInScene(target, scene)) {
        setStatus('That runtime object is no longer in the scene.')
        return false
      }
      target.updateMatrixWorld(true)
      const instanceSuffix =
        selectionMode === 'zones'
          ? ''
          : picked?.instanceId != null
            ? ` / instance:${picked.instanceId}`
            : ''
      const next: ObjectSelection = {
        kind: 'object',
        target,
        name: target.name || target.type,
        path: `${api.getPath(target)}${instanceSuffix}`,
        editable,
        deleted: false,
        info: api.getObjectInfo(target, picked),
        original: snapshot(target),
      }
      controls.detach()
      if (editable) controls.attach(target)
      selectionRef.current = next
      setSelection(next)
      setRevision((value) => value + 1)
      setStatus(
        editable
          ? selectionMode === 'zones'
            ? 'Whole room selected. Drag the gizmo or edit its transform, then save the scene override.'
            : 'GLB object selected. Copy its transform to update the source asset.'
          : 'Embedded GLB instance selected. Inspect only; no placement manifest is available for this instance.'
      )
      return true
    }

    const raycaster = new THREE.Raycaster()
    const onPointerDown = (event: PointerEvent) => {
      if (event.target !== canvas) return
      const requestId = ++selectionRequestRef.current
      event.preventDefault()
      event.stopImmediatePropagation()
      canvas.setPointerCapture(event.pointerId)
      const normalized = pointer(event)
      controls.pointerHover(normalized)
      if (controls.axis) {
        controls.pointerDown(normalized)
        return
      }
      raycaster.setFromCamera(pointerVector(event), camera)
      const hits = raycaster
        .intersectObjects(scene.children, true)
        .filter((hit) => isPickable(hit.object, helper))
      // Prefer editable catalog fields when an embedded decorative mesh overlaps
      // the same placement.
      const hit =
        hits.find((candidate) => {
          const field = findFieldHit(candidate.object, scene)
          return (
            field &&
            (candidate.object instanceof THREE.Mesh ||
              candidate.object instanceof THREE.InstancedMesh)
          )
        }) ?? hits[0]
      if (!hit) {
        controls.detach()
        selectionRef.current = null
        setSelection(null)
        setStatus(
          selectionMode === 'zones'
            ? 'Click a room in the scene to move the whole room.'
            : 'Click an object in the scene to edit it.'
        )
        return
      }
      const field = findFieldHit(hit.object, scene)
      if (
        selectionMode !== 'zones' &&
        field &&
        (hit.object instanceof THREE.Mesh || hit.object instanceof THREE.InstancedMesh)
      ) {
        const instanceIndex = hit.object instanceof THREE.InstancedMesh ? (hit.instanceId ?? 0) : 0
        void selectPlacement(hit.object, instanceIndex, field, requestId).then((selected) => {
          if (!selected && selectionRequestRef.current === requestId) {
            selectObjectAtPointer(event.clientX, event.clientY)
          }
        })
        return
      }
      selectObjectAtPointer(event.clientX, event.clientY)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (event.target !== canvas && !canvas.hasPointerCapture(event.pointerId)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      controls.pointerMove(pointer(event, -1))
      if (!controls.dragging) controls.pointerHover(pointer(event, -1))
    }
    const onPointerUp = (event: PointerEvent) => {
      if (event.target !== canvas && !canvas.hasPointerCapture(event.pointerId)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      controls.pointerUp(pointer(event))
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.shiftKey) {
          const entry = historyRef.current[historyIndexRef.current]
          if (entry) {
            selectionRef.current = entry.selection
            controls.detach().attach(entry.selection.target)
            applySnapshot(entry.selection.target, entry.after)
            controls.dispatchEvent({ type: 'objectChange' })
            historyIndexRef.current += 1
            setHistoryIndex(historyIndexRef.current)
          }
        } else if (historyIndexRef.current > 0) {
          const entry = historyRef.current[historyIndexRef.current - 1]
          selectionRef.current = entry.selection
          controls.detach().attach(entry.selection.target)
          applySnapshot(entry.selection.target, entry.before)
          controls.dispatchEvent({ type: 'objectChange' })
          historyIndexRef.current -= 1
          setHistoryIndex(historyIndexRef.current)
        }
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const active = selectionRef.current
        if (selectionMode === 'zones' || !active || active.kind !== 'object') return
        event.preventDefault()
        event.stopImmediatePropagation()
        setObjectDeleted(!active.deleted)
        return
      }
      const key = event.key.toLowerCase()
      if (key !== '1' && key !== '2' && key !== '3' && event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (key === '1') setMode('translate')
      if (key === '2') setMode('rotate')
      if (key === '3') setMode('scale')
      if (event.key === 'Escape') {
        selectionRequestRef.current += 1
        controls.detach()
        selectionRef.current = null
        setSelection(null)
        setStatus(
          selectionMode === 'zones'
            ? 'Click a room in the scene to move the whole room.'
            : 'Click an object in the scene to edit it.'
        )
      }
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    document.addEventListener('pointermove', onPointerMove, { capture: true })
    document.addEventListener('pointerup', onPointerUp, { capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('agent-hq:scene-zone-unloading', onZoneUnloading)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      document.removeEventListener('pointermove', onPointerMove, { capture: true })
      document.removeEventListener('pointerup', onPointerUp, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('agent-hq:scene-zone-unloading', onZoneUnloading)
      cancelAnimationFrame(selectionGraphFrame)
      controls.removeEventListener('objectChange', onObjectChange)
      controls.removeEventListener('mouseDown', onMouseDown)
      controls.removeEventListener('mouseUp', onMouseUp)
      controls.detach()
      // The editor supplies its own pointer events and intentionally creates
      // TransformControls without a DOM element, so there is no internal
      // listener connection to dispose here.
      helper.removeFromParent()
      placementTargetsRef.current.forEach((target) => target.removeFromParent())
      placementTargetsRef.current.clear()
      controlsRef.current = null
      window.dispatchEvent(new Event('blur'))
    }
  }, [api, cameraViewMode, lockedObjectPrefixes, manifest, selectionMode, setObjectDeleted])

  const updateSelection = (next: TransformSnapshot) => {
    const active = selectionRef.current
    if (!active) return
    applySnapshot(active.target, next)
    controlsRef.current?.dispatchEvent({ type: 'objectChange' })
  }

  const selectionEditable = Boolean(
    selection && (selection.kind === 'placement' || selection.editable)
  )

  const updateVectorComponent = (kind: 'position' | 'scale', index: number, value: number) => {
    if (!selectionEditable || !selection) return
    const next = snapshot(selection.target)
    if (kind === 'position') {
      const vector = [...next.position] as TransformSnapshot['position']
      vector[index] = value
      next.position = vector
    } else {
      const vector = [...next.scale] as TransformSnapshot['scale']
      vector[index] = value
      next.scale = vector
    }
    updateSelection(next)
  }

  const updateRotationComponent = (index: number, degrees: number) => {
    if (!selectionEditable || !selection) return
    const next = snapshot(selection.target)
    const euler = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(...next.quaternion),
      selection.target.rotation.order
    )
    if (index === 0) euler.x = THREE.MathUtils.degToRad(degrees)
    if (index === 1) euler.y = THREE.MathUtils.degToRad(degrees)
    if (index === 2) euler.z = THREE.MathUtils.degToRad(degrees)
    next.quaternion = new THREE.Quaternion()
      .setFromEuler(euler)
      .toArray() as TransformSnapshot['quaternion']
    updateSelection(next)
  }

  const undo = () => {
    if (!selectionEditable || historyIndex <= 0) return
    const entry = historyRef.current[historyIndex - 1]
    if (selectionRef.current !== entry.selection) {
      controlsRef.current?.detach().attach(entry.selection.target)
      selectionRef.current = entry.selection
      setSelection(entry.selection)
    }
    updateSelection(entry.before)
    historyIndexRef.current = historyIndex - 1
    setHistoryIndex(historyIndex - 1)
    setStatus('Undid transform.')
  }

  const redo = () => {
    if (!selectionEditable) return
    const entry = historyRef.current[historyIndex]
    if (!entry) return
    if (selectionRef.current !== entry.selection) {
      controlsRef.current?.detach().attach(entry.selection.target)
      selectionRef.current = entry.selection
      setSelection(entry.selection)
    }
    updateSelection(entry.after)
    historyIndexRef.current = historyIndex + 1
    setHistoryIndex(historyIndex + 1)
    setStatus('Redid transform.')
  }

  const reset = () => {
    if (!selection || !selectionEditable) return
    const before = snapshot(selection.target)
    updateSelection(selection.original)
    const next = historyRef.current.slice(0, historyIndex)
    next.push({ selection, before, after: selection.original })
    historyRef.current = next
    historyIndexRef.current = next.length
    setHistoryIndex(next.length)
    setStatus('Reset to the source transform.')
  }

  const exportData = selection
    ? {
        ...(selection.kind === 'placement'
          ? {
              scene: manifest.id,
              category: selection.category,
              modelId: selection.modelId,
              placementIndex: selection.placementIndex,
              placement: placementFromSnapshot(snapshot(selection.target)),
            }
          : {
              scene: manifest.id,
              objectPath: selection.path,
              objectName: selection.name,
              deleted: selection.deleted,
              ...(manifest.editorOverridesSourcePath
                ? { editorOverridesSourcePath: manifest.editorOverridesSourcePath }
                : {}),
              ...(manifest.editorOverridesPublicPath
                ? { editorOverridesPublicPath: manifest.editorOverridesPublicPath }
                : {}),
              transform: placementFromSnapshot(snapshot(selection.target)),
            }),
      }
    : null

  const copyTransform = async () => {
    if (!exportData) return
    const text = JSON.stringify(exportData, null, 2)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', 'true')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('Clipboard copy was rejected')
      }
      setStatus('Copied transform JSON.')
    } catch {
      setStatus('Could not copy JSON. Select the transform data from the browser instead.')
    }
  }

  const saveSource = async () => {
    if (!selection || !exportData || !selectionEditable || saving) return
    setSaving(true)
    setStatus(
      selection.kind === 'placement' ? 'Saving source placement...' : 'Saving scene override...'
    )
    try {
      const response = await fetch('/api/scene-editor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exportData),
      })
      const result = (await response.json()) as { error?: string; path?: string }
      if (!response.ok) {
        setStatus(result.error ?? 'Could not save the placement.')
        setSaving(false)
        return
      }
      selection.original = snapshot(selection.target)
      setStatus(`Saved ${result.path}. Continue editing.`)
      setSaving(false)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save the placement.')
      setSaving(false)
    }
  }

  const exitEditor = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('sceneEditor', '0')
    window.location.assign(url)
  }

  const transform = selection ? snapshot(selection.target) : null
  const rotation =
    transform && selection
      ? new THREE.Euler().setFromQuaternion(
          new THREE.Quaternion(...transform.quaternion),
          selection.target.rotation.order
        )
      : null
  const rotationDegrees = rotation
    ? [rotation.x, rotation.y, rotation.z].map((value) => THREE.MathUtils.radToDeg(value))
    : []
  const objectInfo = selection?.kind === 'object' ? selection.info : null
  const objectMaterials = Array.isArray(objectInfo?.materials)
    ? (objectInfo.materials as Array<{ name?: string; type?: string }>)
    : []
  const objectGeometry = objectInfo?.geometry as
    { vertexCount?: number; indexCount?: number; groupCount?: number } | null | undefined
  void revision

  return (
    <aside
      className="fixed inset-x-3 z-[80] mx-auto max-h-[calc(100dvh-var(--workspace-topbar-offset,0px)-1.5rem)] w-[min(28rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-white/15 bg-[#121820]/95 text-[#eef4f8] shadow-2xl backdrop-blur-md sm:right-3 sm:left-auto sm:mx-0"
      style={{ top: 'calc(var(--workspace-topbar-offset, 0px) + 0.75rem)' }}
    >
      <div className="h-1 bg-[linear-gradient(90deg,#f45b69_0_33%,#64d98b_33%_66%,#58a6ff_66%)]" />
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Box className="size-4 text-[#ffd166]" />
          <div className="min-w-0">
            <div className="text-xs font-semibold tracking-[0.14em] uppercase">Scene editor</div>
            <div className="truncate font-mono text-[10px] text-white/45">
              {manifest.label} / development only
            </div>
          </div>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-white/70 hover:bg-white/10 hover:text-white"
          onClick={exitEditor}
          aria-label="Exit scene editor"
        >
          <X />
        </Button>
      </header>

      <div className="grid grid-cols-3 border-b border-white/10">
        {MODE_LABELS.map(({ mode: option, label, icon: Icon }) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={`flex items-center justify-center gap-1.5 px-3 py-2 text-xs transition-colors ${mode === option ? 'bg-white/12 text-white' : 'text-white/50 hover:bg-white/5 hover:text-white/80'}`}
            aria-pressed={mode === option}
          >
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>

      <div className="space-y-3 p-3">
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            className="border-white/15 bg-transparent text-white/75 hover:bg-white/10 hover:text-white"
            onClick={() => setSpace(space === 'world' ? 'local' : 'world')}
          >
            {space === 'world' ? 'World' : 'Local'}
          </Button>
          <Button
            size="xs"
            variant="outline"
            className={`border-white/15 bg-transparent hover:bg-white/10 ${snapEnabled ? 'text-[#ffd166]' : 'text-white/75'}`}
            onClick={() => setSnapEnabled((value) => !value)}
          >
            <Grid3X3 /> Snap
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-white/65 hover:bg-white/10 hover:text-white"
              disabled={!selectionEditable || historyIndex === 0}
              onClick={undo}
              aria-label="Undo"
            >
              <Undo2 />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-white/65 hover:bg-white/10 hover:text-white"
              disabled={!selectionEditable || historyIndex >= historyRef.current.length}
              onClick={redo}
              aria-label="Redo"
            >
              <Redo2 />
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          {selection && transform ? (
            <>
              <div className="truncate text-sm font-medium">{selection.name}</div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-white/40">
                {selection.path}
              </div>
              {!selectionEditable ? (
                <div className="mt-1 text-[10px] font-semibold tracking-[0.12em] text-[#ffd166]">
                  READ ONLY INSPECTION
                </div>
              ) : null}
              <dl className="mt-3 grid grid-cols-[4.25rem_1fr] gap-y-1.5 font-mono text-[11px]">
                <dt className="pt-1 text-[#f45b69]">POSITION</dt>
                <dd className="grid grid-cols-3 gap-1">
                  {transform.position.map((value, index) => (
                    <TransformNumberInput
                      key={`position-${index}`}
                      label={`Position ${['X', 'Y', 'Z'][index]}`}
                      value={value}
                      disabled={!selectionEditable}
                      onChange={(next) => updateVectorComponent('position', index, next)}
                    />
                  ))}
                </dd>
                <dt className="pt-1 text-[#64d98b]">ROTATION</dt>
                <dd className="grid grid-cols-3 gap-1">
                  {rotationDegrees.map((value, index) => (
                    <TransformNumberInput
                      key={`rotation-${index}`}
                      label={`Rotation ${['X', 'Y', 'Z'][index]} degrees`}
                      value={value}
                      disabled={!selectionEditable}
                      onChange={(next) => updateRotationComponent(index, next)}
                    />
                  ))}
                </dd>
                <dt className="pt-1 text-[#58a6ff]">SCALE</dt>
                <dd className="grid grid-cols-3 gap-1">
                  {transform.scale.map((value, index) => (
                    <TransformNumberInput
                      key={`scale-${index}`}
                      label={`Scale ${['X', 'Y', 'Z'][index]}`}
                      value={value}
                      disabled={!selectionEditable}
                      onChange={(next) => updateVectorComponent('scale', index, next)}
                    />
                  ))}
                </dd>
              </dl>
              {objectInfo ? (
                <div className="mt-3 border-t border-white/10 pt-3 font-mono text-[10px] text-white/65">
                  <div>TYPE {String(objectInfo.type ?? '?')}</div>
                  {objectInfo.instanceId != null ? (
                    <div>INSTANCE {String(objectInfo.instanceId)}</div>
                  ) : null}
                  <div>WORLD {formatInfoVector(objectInfo.worldPosition)}</div>
                  <div>
                    BOUNDS{' '}
                    {Array.isArray(objectInfo.worldBounds)
                      ? objectInfo.worldBounds.map(formatInfoVector).join(' -> ')
                      : '?'}
                  </div>
                  {objectMaterials.length > 0 ? (
                    <div>
                      MATERIALS{' '}
                      {objectMaterials
                        .map((material) => `${material.name ?? '?'} (${material.type ?? '?'})`)
                        .join(', ')}
                    </div>
                  ) : null}
                  {objectGeometry ? (
                    <div>
                      GEOMETRY {objectGeometry.vertexCount ?? 0} vertices ·{' '}
                      {objectGeometry.indexCount ?? 0} indices · {objectGeometry.groupCount ?? 0}{' '}
                      groups
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="py-3 text-center text-xs text-white/50">
              {selectionMode === 'zones'
                ? 'Click a room to move the whole room.'
                : 'Click a scene object to place the transform gizmo.'}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            className="bg-[#ffd166] text-[#171a1f] hover:bg-[#ffe099]"
            disabled={!selection || !selectionEditable || saving}
            onClick={saveSource}
          >
            <Save /> {saving ? 'Saving...' : 'Save source'}
          </Button>
          {selection?.kind === 'object' && selectionMode !== 'zones' && (
            <Button
              size="sm"
              variant="outline"
              className="border-[#f45b69]/40 bg-transparent text-[#ff9da5] hover:bg-[#f45b69]/15 hover:text-white"
              disabled={saving || !selection.editable}
              onClick={() => setObjectDeleted(!selection.deleted)}
            >
              <Trash2 /> {selection.deleted ? 'Restore' : 'Delete'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="border-white/15 bg-transparent text-white/75 hover:bg-white/10 hover:text-white"
            disabled={!selection}
            onClick={copyTransform}
          >
            <Copy /> Copy JSON
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-white/55 hover:bg-white/10 hover:text-white"
            disabled={!selection || !selectionEditable}
            onClick={reset}
          >
            Reset
          </Button>
        </div>

        <p className="min-h-7 text-[11px] leading-4 text-white/45">{status}</p>
        <p className="font-mono text-[10px] text-white/30">
          1 move / 2 rotate / 3 scale /{' '}
          {selectionMode === 'zones'
            ? 'room transforms are saved as overrides'
            : 'delete or backspace removes an object'}
        </p>
      </div>
    </aside>
  )
}
