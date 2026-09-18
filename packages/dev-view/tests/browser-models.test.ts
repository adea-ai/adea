// Browser pane models. Mini-player geometry cases are transcribed from
// t3code previewMiniPlayerLayout.test.ts (MIT); ports merge cases from
// useDiscoveredLocalServers.test.ts; annotation submission cases from
// AnnotationKeyboard.test.ts and PickedElementPayload.test.ts. Adea cases:
// previewability gating, command builder invariants, and responsive presets.
import { describe, expect, test } from 'bun:test'

import {
  clampPreviewMiniPlayerPosition,
  resolveDeviceMiniPlayerCornerRadius,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
} from '../src/browser/mini-preview-layout'
import { canonicalKey, isPreviewableRow, mergeServers } from '../src/browser/ports-model'
import {
  isPickedElementPayload,
  isPreviewAnnotationPayload,
  resolveAnnotationShortcut,
  resolveAnnotationSubmission,
} from '../src/browser/annotation-model'
import { buildDevCommand } from '../src/browser/command'
import {
  RESPONSIVE_PRESETS,
  buildMobileUserAgentOverride,
  resolvePresetViewport,
} from '../src/browser/responsive-presets'

const CONTAINER = { width: 1000, height: 700 }
const SOURCE = { width: 1600, height: 1000 } // aspect 1.6

const scannerServer = (port: number, overrides: Record<string, unknown> = {}) => ({
  host: 'localhost',
  port,
  url: `http://localhost:${port}/`,
  processName: 'vite',
  owner: 'adea' as const,
  health: 'listening' as const,
  ...overrides,
})

describe('mini player geometry (t3code ports)', () => {
  test('fresh player defaults to the top-right corner at the default box', () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: null,
        position: null,
        source: SOURCE,
        container: CONTAINER,
      })
    ).toEqual({ x: 668, y: 12, width: 320, height: 200 })
  })

  test('a tall source binds at the minimum width', () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: null,
        position: null,
        source: { width: 390, height: 844 },
        container: CONTAINER,
      })
    ).toEqual({ x: 748, y: 12, width: 240, height: 519 })
  })

  test('a stored width and position survive the layout pass', () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: 480,
        position: { x: 100, y: 80 },
        source: SOURCE,
        container: CONTAINER,
      })
    ).toEqual({ x: 100, y: 80, width: 480, height: 300 })
  })

  test('a tall composer shrinks the player without losing the stored width', () => {
    expect(
      resolvePreviewMiniPlayerFrame({
        width: 800,
        position: { x: 100, y: 12 },
        source: SOURCE,
        container: CONTAINER,
        obstacles: { composer: { left: 100, right: 900, height: 300 } },
      })
    ).toEqual({ x: 100, y: 12, width: 602, height: 376 })
  })

  test('resize east then resolve reproduces the exact resized frame', () => {
    const start = { x: 300, y: 200, width: 320, height: 200 }
    const resized = resizePreviewMiniPlayer({
      start,
      direction: 'east',
      delta: { x: 160, y: 0 },
      source: SOURCE,
      container: CONTAINER,
    })
    expect(resized).toEqual({ x: 300, y: 200, width: 480, height: 300 })
    expect(
      resolvePreviewMiniPlayerFrame({
        width: resized.width,
        position: { x: resized.x, y: resized.y },
        source: SOURCE,
        container: CONTAINER,
      })
    ).toEqual(resized)
  })

  test('west/north drags anchor the opposite edge; corner growth leads by relative delta', () => {
    const start = { x: 300, y: 200, width: 320, height: 200 }
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: 'west',
        delta: { x: -160, y: 0 },
        source: SOURCE,
        container: CONTAINER,
      })
    ).toEqual({ x: 140, y: 200, width: 480, height: 300 })
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: 'north',
        delta: { x: 0, y: -100 },
        source: SOURCE,
        container: CONTAINER,
      })
    ).toEqual({ x: 300, y: 100, width: 480, height: 300 })
    expect(
      resizePreviewMiniPlayer({
        start,
        direction: 'southeast',
        delta: { x: 20, y: 100 },
        source: SOURCE,
        container: CONTAINER,
      })
    ).toEqual({ x: 300, y: 200, width: 480, height: 300 })
  })

  test('container edges stop growth; minimum size holds on shrink', () => {
    expect(
      resizePreviewMiniPlayer({
        start: { x: 600, y: 12, width: 320, height: 200 },
        direction: 'east',
        delta: { x: 500, y: 0 },
        source: SOURCE,
        container: CONTAINER,
      })
    ).toEqual({ x: 600, y: 12, width: 388, height: 243 })
    expect(
      resizePreviewMiniPlayer({
        start: { x: 300, y: 200, width: 320, height: 200 },
        direction: 'southeast',
        delta: { x: -300, y: -300 },
        source: SOURCE,
        container: CONTAINER,
      })
    ).toEqual({ x: 300, y: 200, width: 240, height: 150 })
  })

  test('drags slide along the composer into the margin', () => {
    const player = { width: 360, height: 240 }
    const obstacles = { composer: { left: 100, right: 900, height: 160 } }
    expect(
      clampPreviewMiniPlayerPosition({ x: 500, y: 448 }, CONTAINER, player, obstacles)
    ).toEqual({ x: 500, y: 288 })
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 850, y: 500 },
        CONTAINER,
        { width: 60, height: 150 },
        obstacles
      )
    ).toEqual({ x: 912, y: 500 })
    expect(
      clampPreviewMiniPlayerPosition(
        { x: 100, y: 100 },
        CONTAINER,
        { width: 976, height: 500 },
        obstacles
      )
    ).toEqual({ x: 12, y: 28 })
  })

  test('device source size and corner radius (t3code/orca cases)', () => {
    expect(resolveDeviceMiniPlayerSourceSize('ios', null).width).toBe(1000)
    expect(
      resolveDeviceMiniPlayerSourceSize('ios', {
        width: 1179,
        height: 2556,
        orientation: 'landscape_left',
      })
    ).toEqual({ width: 2556, height: 1179 })
    expect(resolveDeviceMiniPlayerCornerRadius('android', { width: 240, height: 520 })).toBe(34)
    expect(resolveDeviceMiniPlayerCornerRadius('ios', { width: 240, height: 520 })).toBe(12)
  })
})

describe('ports menu merge (t3code ports)', () => {
  test('loopback aliases collapse to one entry', () => {
    expect(canonicalKey('Localhost', 5173)).toBe('loopback:5173')
    expect(canonicalKey('127.0.0.1', 5173)).toBe('loopback:5173')
    expect(canonicalKey('[::1]', 5173)).toBe('loopback:5173')
    expect(canonicalKey('example.test', 5173)).toBe('example.test:5173')
  })

  test('configured entries keep their full URL and sort first', () => {
    const rows = mergeServers({
      scanner: [scannerServer(3000)],
      configuredUrls: ['http://localhost:8080/app?token=1#debug'],
    })
    expect(rows[0]).toMatchObject({
      port: 8080,
      source: 'configured',
      requestedUrl: 'http://localhost:8080/app?token=1#debug',
    })
    expect(rows[1]).toMatchObject({ port: 3000, source: 'scanner' })
  })

  test('non-loopback and non-http configured URLs are ignored', () => {
    const rows = mergeServers({
      scanner: [],
      configuredUrls: ['https://example.test/', 'ws://localhost:8080', 'not a url'],
    })
    expect(rows).toEqual([])
  })

  test('only proven Adea-owned listening rows are previewable', () => {
    expect(
      isPreviewableRow(scannerServer(3000, { owner: 'adea', health: 'listening' }) as never)
    ).toBe(true)
    expect(isPreviewableRow(scannerServer(3000, { owner: 'unknown' }) as never)).toBe(false)
    expect(isPreviewableRow(scannerServer(3000, { health: 'stale' }) as never)).toBe(false)
  })
})

describe('annotation model (t3code ports)', () => {
  test('keyboard submissions: Enter attach, Cmd/Ctrl+Enter send, Shift/IME null', () => {
    expect(
      resolveAnnotationSubmission({
        key: 'Enter',
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe('attach')
    expect(
      resolveAnnotationSubmission({
        key: 'Enter',
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe('send')
    expect(
      resolveAnnotationSubmission({
        key: 'Enter',
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        isComposing: false,
      })
    ).toBe('send')
    expect(
      resolveAnnotationSubmission({
        key: 'Enter',
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        isComposing: false,
      })
    ).toBeNull()
    expect(
      resolveAnnotationSubmission({
        key: 'Enter',
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isComposing: true,
      })
    ).toBeNull()
  })

  test('tool shortcuts: v/r/d/e switch, Escape cancels, modifiers ignored', () => {
    expect(
      resolveAnnotationShortcut({ key: 'v', metaKey: false, ctrlKey: false, altKey: false })
    ).toEqual({
      kind: 'tool',
      tool: 'select',
    })
    expect(
      resolveAnnotationShortcut({ key: 'Escape', metaKey: false, ctrlKey: false, altKey: false })
    ).toEqual({
      kind: 'cancel',
    })
    expect(
      resolveAnnotationShortcut({ key: 'd', metaKey: true, ctrlKey: false, altKey: false })
    ).toBeNull()
  })

  test('picked element payload validation fails closed on malformed shapes', () => {
    const valid = {
      pageUrl: 'http://localhost:5173/',
      pageTitle: null,
      tagName: 'button',
      selector: null,
      componentName: null,
      htmlPreview: '<button>hi</button>',
      styles: '',
      pickedAt: '2026-09-18T12:00:00.000Z',
      source: null,
      stack: [],
    }
    expect(isPickedElementPayload(valid)).toBe(true)
    expect(
      isPickedElementPayload({
        ...valid,
        stack: [{ functionName: null, fileName: null, lineNumber: NaN, columnNumber: null }],
      })
    ).toBe(false)
    expect(isPickedElementPayload({ ...valid, tagName: 42 })).toBe(false)
    expect(isPickedElementPayload(null)).toBe(false)
    expect(isPickedElementPayload('payload')).toBe(false)
    const annotation = {
      id: 'a1',
      pageUrl: 'http://localhost:5173/',
      pageTitle: null,
      comment: 'look here',
      createdAt: '2026-09-18T12:00:00.000Z',
      screenshot: null,
      elements: [{ id: 'e1', element: valid, rect: { x: 0, y: 0, width: 10, height: 10 } }],
      regions: [],
      strokes: [],
      styleChanges: [],
    }
    expect(isPreviewAnnotationPayload(annotation)).toBe(true)
    expect(isPreviewAnnotationPayload({ ...annotation, screenshot: { dataUrl: 'bad' } })).toBe(
      false
    )
    expect(
      isPreviewAnnotationPayload({
        ...annotation,
        elements: [{ id: 'e1', element: valid, rect: { x: 0, y: 0, width: '10', height: 10 } }],
      })
    ).toBe(false)
  })
})

describe('responsive presets and command builder', () => {
  test('every preset is unique with portrait-first phone shapes', () => {
    const ids = new Set(RESPONSIVE_PRESETS.map((preset) => preset.id))
    expect(ids.size).toBe(RESPONSIVE_PRESETS.length)
    expect(RESPONSIVE_PRESETS.some((preset) => preset.id === 'responsive')).toBe(true)
  })

  test('rotation swaps the preset dimensions', () => {
    const preset = RESPONSIVE_PRESETS.find((entry) => entry.id === 'iphone_15_pro')!
    expect(resolvePresetViewport(preset, 'portrait')).toMatchObject({ width: 393, height: 852 })
    expect(resolvePresetViewport(preset, 'landscape')).toMatchObject({
      width: 852,
      height: 393,
      rotated: true,
    })
  })

  test('mobile UA override carries matching client-hint metadata', () => {
    const override = buildMobileUserAgentOverride(
      'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/604.1'
    )
    expect(override.userAgent).toContain('CriOS/140.0.0.0')
    expect(override.userAgentMetadata.mobile).toBe(true)
    expect(override.userAgentMetadata.brands[0].version).toBe('140')
  })

  test('commands bind capabilities from the registry and require resources', () => {
    const scope = {
      accountId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      runtimeNodeId: '00000000-0000-4000-8000-000000000003',
    }
    const command = buildDevCommand(
      {
        operation: 'dev.browser.navigate',
        scope,
        body: { browserLaneId: 'lane-1', expectedGeneration: 2, url: 'https://example.test/' },
        resource: { kind: 'browser_lane', id: 'lane-1', generation: 2 },
      },
      {
        now: () => new Date('2026-09-18T12:00:00.000Z'),
        randomId: () => '00000000-0000-4000-8000-000000000004',
        nonce: () => 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      }
    )
    expect(command.capabilities).toEqual(['dev.browser.control'])
    expect(command.expiresAt).toBe('2026-09-18T12:01:00.000Z')
    expect(() =>
      buildDevCommand({
        operation: 'dev.browser.navigate',
        scope,
        body: {},
      })
    ).toThrow(/requires a resource/)
    expect(() =>
      buildDevCommand({
        operation: 'dev.browser.lanes',
        scope,
        body: {},
        resource: { kind: 'browser_lane', id: 'x', generation: 1 },
      })
    ).toThrow(/does not bind a resource/)
  })
})
