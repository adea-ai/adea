import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import {
  getOrthographicGroundHalfExtents,
  getPerspectiveCameraDistance,
} from '../src/camera-controller'
import { CameraController } from '../src/camera-controller'

describe('perspective camera obstruction framing', () => {
  test('keeps the authored distance when nothing blocks the character', () => {
    expect(
      getPerspectiveCameraDistance({ baseDistance: 1.7, obstructionDistance: Infinity })
    ).toBeCloseTo(1.7, 5)
  })

  test('stops at the same obstruction distance as Nifty World', () => {
    expect(
      getPerspectiveCameraDistance({ baseDistance: 1.7, obstructionDistance: 1.2 })
    ).toBeCloseTo(1.2, 5)
  })

  test('allows the camera to move close enough for a nearby object to stay behind it', () => {
    expect(
      getPerspectiveCameraDistance({ baseDistance: 1.7, obstructionDistance: 0.18 })
    ).toBeCloseTo(0.18, 5)
  })
})

describe('perspective camera input', () => {
  test('supports drag orbit and pan without enabling pointer lock', () => {
    const windowTarget = new EventTarget() as EventTarget & {
      innerWidth: number
      innerHeight: number
    }
    windowTarget.innerWidth = 1280
    windowTarget.innerHeight = 720
    const documentTarget = new EventTarget() as EventTarget & {
      pointerLockElement: Element | null
    }
    const canvas = new EventTarget() as EventTarget & HTMLCanvasElement
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }) as DOMRect
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget })

    const controller = new CameraController({
      canvas,
      enableInput: true,
      mouseInputEnabled: false,
      dragInputEnabled: true,
    })
    const target = new THREE.Vector3(0, 1, 0)
    controller.update(target, 1 / 60)
    const initialYaw = controller.state.cameraYaw

    canvas.dispatchEvent(
      Object.assign(new Event('pointerdown'), {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 400,
        clientY: 300,
      })
    )
    canvas.dispatchEvent(
      Object.assign(new Event('pointermove'), {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 500,
        clientY: 340,
      })
    )
    canvas.dispatchEvent(
      Object.assign(new Event('pointerup'), {
        pointerId: 1,
        pointerType: 'mouse',
      })
    )

    expect(controller.state.cameraYaw).not.toBe(initialYaw)
    expect(controller.state.pitch).not.toBe(-0.2)

    const beforePan = controller.camera.position.clone()
    canvas.dispatchEvent(
      Object.assign(new Event('pointerdown'), {
        pointerId: 2,
        pointerType: 'mouse',
        button: 2,
        clientX: 400,
        clientY: 300,
      })
    )
    canvas.dispatchEvent(
      Object.assign(new Event('pointermove'), {
        pointerId: 2,
        pointerType: 'mouse',
        clientX: 500,
        clientY: 350,
      })
    )
    canvas.dispatchEvent(
      Object.assign(new Event('pointerup'), {
        pointerId: 2,
        pointerType: 'mouse',
      })
    )
    controller.update(target, 1)

    expect(controller.camera.position.distanceTo(beforePan)).toBeGreaterThan(0.1)
    controller.dispose()
  })

  test('does not attach pointer-lock mouse input when disabled', () => {
    const windowTarget = new EventTarget() as EventTarget & {
      innerWidth: number
      innerHeight: number
    }
    windowTarget.innerWidth = 1280
    windowTarget.innerHeight = 720
    const documentTarget = new EventTarget() as EventTarget & {
      pointerLockElement: Element | null
    }
    const canvas = new EventTarget() as EventTarget & HTMLCanvasElement
    let pointerLockRequests = 0
    canvas.requestPointerLock = () => {
      pointerLockRequests += 1
      return Promise.resolve()
    }
    Object.defineProperty(documentTarget, 'pointerLockElement', {
      configurable: true,
      value: canvas,
    })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget })

    const controller = new CameraController({
      canvas,
      enableInput: true,
      mouseInputEnabled: false,
    })
    documentTarget.dispatchEvent(
      Object.assign(new Event('mousemove'), { movementX: 100, movementY: 0 })
    )
    canvas.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerType: 'mouse' }))

    expect(controller.state.cameraYaw).toBe(0)
    expect(pointerLockRequests).toBe(0)
    controller.dispose()
  })
})

describe('perspective camera zoom framing', () => {
  test('moves the follow camera closer or farther without changing its target', () => {
    expect(
      getPerspectiveCameraDistance({
        baseDistance: 1.7,
        obstructionDistance: Infinity,
        zoom: 1.6,
      })
    ).toBeCloseTo(1.0625, 5)
    expect(
      getPerspectiveCameraDistance({
        baseDistance: 1.7,
        obstructionDistance: Infinity,
        zoom: 0.7,
      })
    ).toBeCloseTo(2.42857, 4)
  })

  test('keeps obstruction and perimeter limits below the requested zoom distance', () => {
    expect(
      getPerspectiveCameraDistance({
        baseDistance: 1.7,
        obstructionDistance: 1.2,
        zoom: 0.7,
        maxDistance: 2.4,
      })
    ).toBeCloseTo(1.2, 5)
    expect(
      getPerspectiveCameraDistance({
        baseDistance: 1.7,
        obstructionDistance: Infinity,
        zoom: 0.7,
        maxDistance: 1.9,
      })
    ).toBeCloseTo(1.9, 5)
  })

  test('uses a scene-specific perspective follow distance', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { innerWidth: 1280, innerHeight: 720 },
    })
    const controller = new CameraController({
      canvas: {} as HTMLCanvasElement,
      enableInput: false,
      characterScale: 0.75,
      perspectiveCameraDistance: 4.5,
    })

    controller.update(new THREE.Vector3(0, 1, 0), 1 / 60)

    expect(controller.baseDistance).toBeCloseTo(4.5, 5)
    expect(controller.state.cameraDistance).toBeCloseTo(4.5, 5)
  })

  test('caps perspective zoom-out at the supplied camera envelope', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { innerWidth: 1280, innerHeight: 720 },
    })
    const controller = new CameraController({
      canvas: {} as HTMLCanvasElement,
      enableInput: false,
      cameraBounds: { xMin: -2, xMax: 2, zMin: -2, zMax: 2 },
    })

    controller.setPerspectiveZoom(0.7)
    const target = new THREE.Vector3(0, 0, 0)
    for (let frame = 0; frame < 120; frame += 1) {
      controller.update(target, 1 / 60, Infinity)
    }

    expect(controller.state.cameraDistance).toBeLessThanOrEqual(2.1)
  })
})

describe('orthographic ground framing', () => {
  test('adjusts the orthographic zoom target independently of the map target', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { innerWidth: 1280, innerHeight: 720 },
    })
    const controller = new CameraController({
      canvas: {} as HTMLCanvasElement,
      enableInput: false,
    })
    controller.setViewMode('orthographic')
    controller.adjustOrthographicZoom(0.4)
    for (let frame = 0; frame < 60; frame += 1) {
      controller.update(new THREE.Vector3(0, 0, 0), 1 / 60, Infinity)
    }

    expect((controller.camera as THREE.OrthographicCamera).zoom).toBeGreaterThan(1)
  })

  test('accounts for the top-down pitch when fitting a map inside the viewport', () => {
    const extents = getOrthographicGroundHalfExtents({
      halfHeight: 10.5,
      aspect: 1280 / 720,
      zoom: 1,
      viewDirectionY: Math.sin(-0.9),
    })

    expect(extents.halfWidth).toBeCloseTo(18.667, 2)
    expect(extents.halfDepth).toBeCloseTo(13.404, 2)
  })

  test('restores the scene-authored pan after a temporary reset', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { innerWidth: 1280, innerHeight: 720 },
    })
    const controller = new CameraController({
      canvas: {} as HTMLCanvasElement,
      initialViewMode: 'orthographic',
      orthographicPan: { x: 0, z: 7.2 },
      orthographicHalfHeight: 10,
    })
    const target = new THREE.Vector3(0, 0, 0)

    controller.update(target, 1 / 60)
    const authoredPosition = controller.orthographicCamera.position.clone()
    controller.setOrthographicPan(0, 0)
    controller.resetOrthographicPan()
    controller.update(target, 1 / 60)

    expect(controller.orthographicCamera.position.z).toBeCloseTo(authoredPosition.z, 5)
  })
})
