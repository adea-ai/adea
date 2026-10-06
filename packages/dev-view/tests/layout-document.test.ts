import { describe, expect, test } from 'bun:test'

import {
  decodeLayoutDocument,
  layoutStorageKeyV2,
  migrateLayoutPreferencesV1,
  serializeLayoutPreferencesV2,
} from '../src/layout/persistence'
import type { DevLayoutPreferencesV2, DevUtilityPreference } from '@adea-ai/types/dev-runtime'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

const pane = (
  name: DevUtilityPreference['pane'],
  overrides: Partial<DevUtilityPreference> = {}
): DevUtilityPreference => ({
  pane: name,
  side: name === 'files' || name === 'source_control' ? 'left' : 'right',
  order: 0,
  visible: false,
  size: 288,
  lastNonzeroSize: 288,
  fullWidth: false,
  ...overrides,
})

const utility = (): DevLayoutPreferencesV2['utility'] => [
  pane('files', { order: 0, visible: true }),
  pane('source_control', { order: 1 }),
  pane('browser', { order: 2 }),
  pane('devices', { order: 3 }),
  pane('agents', { order: 4 }),
  pane('history', { order: 5 }),
]

const preferences = (): DevLayoutPreferencesV2 => ({
  schemaVersion: 2,
  scope,
  projectId: 'project-a',
  runtimeSessionId: 'session-a',
  center: { kind: 'leaf', id: 'terminal-a', pane: 'terminal' },
  utility: utility(),
  focusMode: false,
  focusTargetId: 'terminal-a',
})

// A V2 document whose right-side panes all carry one stored width.
const atSize = (size: number, lastNonzeroSize = size) =>
  preferences().utility.map((entry) =>
    entry.side === 'right' ? { ...entry, size, lastNonzeroSize } : entry
  )

describe('Dev V2 layout document', () => {
  test('round trips a session-scoped version-two document', () => {
    const value = preferences()
    const raw = serializeLayoutPreferencesV2(value)
    expect(raw).not.toContain('credential')
    expect(decodeLayoutDocument(raw)).toEqual({ state: 'ready', value, migrated: false })
    expect(layoutStorageKeyV2(scope, 'project-a', 'session-a')).toContain(
      'adea.dev-layout.v2:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:project-a:session-a'
    )
    expect(layoutStorageKeyV2(scope, 'project-a', 'session-b')).not.toBe(
      layoutStorageKeyV2(scope, 'project-a', 'session-a')
    )
  })

  test('normalizes missing and split-node focus targets to the first center leaf', () => {
    const withoutTarget = serializeLayoutPreferencesV2({
      ...preferences(),
      focusTargetId: undefined,
    })
    expect(decodeLayoutDocument(withoutTarget)).toMatchObject({
      state: 'ready',
      value: { focusTargetId: 'terminal-a' },
    })

    const splitTarget = serializeLayoutPreferencesV2({
      schemaVersion: 2,
      scope,
      projectId: 'project-a',
      runtimeSessionId: 'session-a',
      center: {
        kind: 'split',
        id: 'dev-root',
        direction: 'row',
        ratio: 0.5,
        children: [
          { kind: 'leaf', id: 'terminal-a', pane: 'terminal' },
          { kind: 'leaf', id: 'editor-a', pane: 'editor' },
        ],
      },
      utility: utility(),
      focusMode: false,
      focusTargetId: 'dev-root',
    })
    expect(decodeLayoutDocument(splitTarget)).toMatchObject({
      state: 'ready',
      value: { focusTargetId: 'terminal-a' },
    })
  })

  test('requires all six utility panes exactly once with a total order', () => {
    const base = preferences()
    const missing = { ...base, utility: base.utility.slice(1) }
    expect(() => serializeLayoutPreferencesV2(missing)).toThrow()
    expect(decodeLayoutDocument(JSON.stringify(missing))).toMatchObject({ state: 'corrupt' })

    const duplicated = {
      ...base,
      utility: base.utility.map((entry, index) =>
        index === 1 ? { ...entry, pane: 'files' as const } : entry
      ),
    }
    expect(decodeLayoutDocument(JSON.stringify(duplicated))).toMatchObject({ state: 'corrupt' })

    const orderGap = {
      ...base,
      utility: base.utility.map((entry, index) => ({ ...entry, order: index === 5 ? 9 : index })),
    }
    expect(decodeLayoutDocument(JSON.stringify(orderGap))).toMatchObject({ state: 'corrupt' })
  })

  test('allows both sides visible once each but rejects two visible panes on one side', () => {
    const both = preferences()
    const withBrowserVisible = {
      ...both,
      utility: both.utility.map((entry) =>
        entry.pane === 'browser' ? { ...entry, visible: true } : entry
      ),
    }
    expect(decodeLayoutDocument(serializeLayoutPreferencesV2(withBrowserVisible))).toMatchObject({
      state: 'ready',
    })

    const twiceLeft = {
      ...both,
      utility: both.utility.map((entry) =>
        entry.pane === 'source_control' ? { ...entry, visible: true } : entry
      ),
    }
    expect(decodeLayoutDocument(JSON.stringify(twiceLeft))).toMatchObject({
      state: 'corrupt',
    })
  })

  test('rejects unknown keys and non-preference payloads without deleting them', () => {
    const polluted = JSON.stringify({
      ...preferences(),
      credentials: 'must-never-persist',
    })
    expect(decodeLayoutDocument(polluted)).toEqual({ state: 'corrupt', raw: polluted })
    expect(decodeLayoutDocument('not json')).toEqual({ state: 'corrupt', raw: 'not json' })
    expect(decodeLayoutDocument(JSON.stringify({ ...preferences(), schemaVersion: 3 }))).toEqual({
      state: 'unsupported',
      raw: JSON.stringify({ ...preferences(), schemaVersion: 3 }),
    })
  })
})

describe('V1 to V2 layout migration', () => {
  const v1 = {
    schemaVersion: 1 as const,
    scope,
    projectId: 'project-a',
    runtimeSessionId: 'session-a',
    center: { kind: 'leaf' as const, id: 'terminal-a', pane: 'terminal' as const },
    utility: [
      {
        pane: 'files' as const,
        side: 'left' as const,
        visible: true,
        size: 10000,
        lastNonzeroSize: 280,
      },
      {
        pane: 'browser' as const,
        side: 'right' as const,
        visible: true,
        size: 320,
        lastNonzeroSize: 320,
      },
    ],
    focusMode: true,
    focusTargetId: 'terminal-a',
  }

  test('fills all six panes, keeps explicit full width, and preserves the center', () => {
    const migrated = migrateLayoutPreferencesV1(v1)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.center).toEqual(v1.center)
    expect(migrated.focusMode).toBe(true)
    expect(migrated.focusTargetId).toBe('terminal-a')
    expect(migrated.utility.map((entry) => entry.pane)).toEqual([
      'files',
      'source_control',
      'browser',
      'devices',
      'agents',
      'history',
    ])
    expect(migrated.utility.map((entry) => entry.order)).toEqual([0, 1, 2, 3, 4, 5])
    const files = migrated.utility[0]
    expect(files).toMatchObject({
      visible: true,
      fullWidth: true,
      size: 280,
      lastNonzeroSize: 280,
    })
    expect(migrated.utility[2]).toMatchObject({ visible: true, fullWidth: false, size: 320 })
    expect(migrated.utility[1]).toMatchObject({ visible: false, fullWidth: false })
  })

  test('seeds the shared default when a width is absent and collapses per-side widths onto the anchor', () => {
    const migrated = migrateLayoutPreferencesV1({
      ...v1,
      utility: v1.utility.filter((entry) => entry.pane !== 'browser'),
    })
    // Absent widths seed the side's default: right-side panes inherit the
    // Browser anchor's wider default.
    expect(migrated.utility.find((entry) => entry.pane === 'browser')).toMatchObject({
      size: 600,
      lastNonzeroSize: 600,
    })
    expect(migrated.utility.find((entry) => entry.pane === 'devices')).toMatchObject({
      size: 600,
      lastNonzeroSize: 600,
    })

    const collapsed = migrateLayoutPreferencesV1(v1)
    expect(collapsed.utility.find((entry) => entry.pane === 'browser')).toMatchObject({
      size: 320,
      lastNonzeroSize: 320,
    })
    for (const paneName of ['devices', 'agents', 'history'] as const)
      expect(collapsed.utility.find((entry) => entry.pane === paneName)).toMatchObject({
        size: 320,
        lastNonzeroSize: 320,
      })
    // The left side collapses onto the files pane's width the same way.
    expect(collapsed.utility.find((entry) => entry.pane === 'source_control')).toMatchObject({
      size: 280,
      lastNonzeroSize: 280,
    })
  })

  test('applies the wider right-side fallback only when a stored width is absent', () => {
    const migrated = migrateLayoutPreferencesV1({
      ...v1,
      utility: v1.utility.map((entry) =>
        entry.pane === 'browser' ? { ...entry, size: 384, lastNonzeroSize: 384 } : entry
      ),
    })
    expect(migrated.utility.find((entry) => entry.pane === 'browser')).toMatchObject({
      size: 384,
      lastNonzeroSize: 384,
    })
    for (const paneName of ['devices', 'agents', 'history'] as const)
      expect(migrated.utility.find((entry) => entry.pane === paneName)).toMatchObject({
        size: 384,
        lastNonzeroSize: 384,
      })

    const stored = {
      ...preferences(),
      utility: utility().map((entry) =>
        entry.pane === 'browser' ? { ...entry, size: 384, lastNonzeroSize: 384 } : entry
      ),
    }
    const decoded = decodeLayoutDocument(serializeLayoutPreferencesV2(stored))
    expect(decoded.state).toBe('ready')
    if (decoded.state !== 'ready') throw new Error('expected a ready decode')
    expect(decoded.value.utility.find((entry) => entry.pane === 'browser')).toMatchObject({
      size: 384,
      lastNonzeroSize: 384,
    })
    expect(decoded.value.utility.find((entry) => entry.pane === 'devices')).toMatchObject({
      size: 384,
      lastNonzeroSize: 384,
    })
  })

  test('keeps a saved right-side width when a legacy document has no Browser anchor', () => {
    const migrated = migrateLayoutPreferencesV1({
      ...v1,
      utility: [
        v1.utility[0]!,
        {
          pane: 'devices' as const,
          side: 'right' as const,
          visible: true,
          size: 336,
          lastNonzeroSize: 336,
        },
      ],
    })
    for (const paneName of ['browser', 'devices', 'agents', 'history'] as const)
      expect(migrated.utility.find((entry) => entry.pane === paneName)).toMatchObject({
        size: 336,
        lastNonzeroSize: 336,
      })
  })

  test('collapses stored per-pane widths onto one width per side when decoding', () => {
    const divergent = preferences()
    const resized = divergent.utility.map((entry) =>
      entry.pane === 'browser'
        ? { ...entry, size: 336, lastNonzeroSize: 336 }
        : entry.pane === 'history'
          ? { ...entry, size: 288, lastNonzeroSize: 288 }
          : entry
    )
    const decoded = decodeLayoutDocument(JSON.stringify({ ...divergent, utility: resized }))
    expect(decoded).toMatchObject({ state: 'ready' })
    if (decoded.state !== 'ready') throw new Error('expected a ready decode')
    for (const paneName of ['devices', 'agents', 'history'] as const)
      expect(decoded.value.utility.find((entry) => entry.pane === paneName)).toMatchObject({
        size: 336,
        lastNonzeroSize: 336,
      })
    expect(decoded.value.utility.find((entry) => entry.pane === 'browser')).toMatchObject({
      size: 336,
      lastNonzeroSize: 336,
    })
  })

  test('demotes extra visible panes per side instead of deleting them', () => {
    const migrated = migrateLayoutPreferencesV1({
      ...v1,
      utility: [
        ...v1.utility,
        {
          pane: 'source_control' as const,
          side: 'left' as const,
          visible: true,
          size: 300,
          lastNonzeroSize: 300,
        },
      ],
    })
    const files = migrated.utility.find((entry) => entry.pane === 'files')
    const source = migrated.utility.find((entry) => entry.pane === 'source_control')
    expect(files?.visible).toBe(true)
    expect(source).toMatchObject({ visible: false, fullWidth: false })
  })

  test('normalizes a stale V1 focus target to the first center leaf', () => {
    const migrated = migrateLayoutPreferencesV1({ ...v1, focusTargetId: 'gone-pane' })
    expect(migrated.focusTargetId).toBe('terminal-a')
  })

  test('decodeLayoutDocument migrates V1 and retains corrupt originals', () => {
    const result = decodeLayoutDocument(JSON.stringify(v1))
    expect(result).toMatchObject({ state: 'ready', migrated: true })
    if (result.state === 'ready') expect(result.value.schemaVersion).toBe(2)
    const broken = JSON.stringify({ ...v1, center: { kind: 'leaf', id: '', pane: 'terminal' } })
    expect(decodeLayoutDocument(broken)).toEqual({ state: 'corrupt', raw: broken })
  })
})

describe('stored legacy right default', () => {
  // The v0.83.0 build wrote its 512 right-pane default into stored documents
  // on first run, so decode resolves a stored right-side 512 to the current
  // 600 default; every other stored width stays verbatim.
  const v1 = {
    schemaVersion: 1 as const,
    scope,
    projectId: 'project-a',
    runtimeSessionId: 'session-a',
    center: { kind: 'leaf' as const, id: 'terminal-a', pane: 'terminal' as const },
    utility: [
      {
        pane: 'files' as const,
        side: 'left' as const,
        visible: true,
        size: 280,
        lastNonzeroSize: 280,
      },
      {
        pane: 'browser' as const,
        side: 'right' as const,
        visible: true,
        size: 512,
        lastNonzeroSize: 512,
      },
    ],
    focusMode: true,
    focusTargetId: 'terminal-a',
  }

  test('resolves a stored right-side 512 to the current default on decode', () => {
    const decoded = decodeLayoutDocument(JSON.stringify({ ...preferences(), utility: atSize(512) }))
    expect(decoded).toMatchObject({ state: 'ready', migrated: false })
    if (decoded.state !== 'ready') throw new Error('expected a ready decode')
    for (const paneName of ['browser', 'devices', 'agents', 'history'] as const)
      expect(decoded.value.utility.find((entry) => entry.pane === paneName)).toMatchObject({
        size: 600,
        lastNonzeroSize: 600,
      })
  })

  test('keeps every other stored width, including the pre-v0.83.0 448 default', () => {
    for (const size of [240, 288, 336, 384, 448, 536]) {
      const decoded = decodeLayoutDocument(
        JSON.stringify({ ...preferences(), utility: atSize(size) })
      )
      expect(decoded).toMatchObject({ state: 'ready' })
      if (decoded.state !== 'ready') throw new Error('expected a ready decode')
      expect(decoded.value.utility.find((entry) => entry.pane === 'browser')).toMatchObject({
        size,
        lastNonzeroSize: size,
      })
    }
  })

  test('maps size and lastNonzeroSize independently and never touches the left side', () => {
    const mixed = preferences().utility.map((entry) =>
      entry.pane === 'browser'
        ? { ...entry, size: 448, lastNonzeroSize: 512 }
        : entry.pane === 'files'
          ? { ...entry, size: 512, lastNonzeroSize: 512 }
          : entry
    )
    const decoded = decodeLayoutDocument(JSON.stringify({ ...preferences(), utility: mixed }))
    expect(decoded).toMatchObject({ state: 'ready' })
    if (decoded.state !== 'ready') throw new Error('expected a ready decode')
    expect(decoded.value.utility.find((entry) => entry.pane === 'browser')).toMatchObject({
      size: 448,
      lastNonzeroSize: 600,
    })
    expect(decoded.value.utility.find((entry) => entry.pane === 'files')).toMatchObject({
      size: 512,
      lastNonzeroSize: 512,
    })
  })

  test('a V1 document with a stored right-side 512 also resolves to 600', () => {
    const result = decodeLayoutDocument(
      JSON.stringify({
        ...v1,
        utility: [{ ...v1.utility[1]!, size: 512, lastNonzeroSize: 512 }],
      })
    )
    expect(result).toMatchObject({ state: 'ready', migrated: true })
    if (result.state !== 'ready') throw new Error('expected a ready decode')
    for (const paneName of ['browser', 'devices', 'agents', 'history'] as const)
      expect(result.value.utility.find((entry) => entry.pane === paneName)).toMatchObject({
        size: 600,
        lastNonzeroSize: 600,
      })
  })

  test('serialization stays faithful: a stored 512 is rewritten only on the next decode', () => {
    const stored = { ...preferences(), utility: atSize(512) }
    const raw = serializeLayoutPreferencesV2(stored)
    expect(raw).toContain('"size":512')
    const decoded = decodeLayoutDocument(raw)
    if (decoded.state !== 'ready') throw new Error('expected a ready decode')
    expect(decoded.value.utility.find((entry) => entry.pane === 'browser')).toMatchObject({
      size: 600,
    })
  })
})
