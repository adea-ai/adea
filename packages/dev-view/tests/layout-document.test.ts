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
