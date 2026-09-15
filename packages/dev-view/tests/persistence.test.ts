import { describe, expect, test } from 'bun:test'

import {
  decodeLayoutPreferences,
  layoutStorageKey,
  serializeLayoutPreferences,
} from '../src/layout/persistence'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

const preferences = {
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
  ],
  focusMode: false,
  focusTargetId: 'terminal-a',
}

describe('Dev layout persistence', () => {
  test('round trips a scoped version-one document', () => {
    expect(decodeLayoutPreferences(serializeLayoutPreferences(preferences))).toEqual({
      state: 'ready',
      value: preferences,
    })
    expect(layoutStorageKey(scope, 'project-a')).toContain(
      '00000000-0000-4000-8000-000000000003:project-a'
    )
  })

  test('retains unread corrupt and unknown-version values for recovery', () => {
    expect(decodeLayoutPreferences('{bad json')).toEqual({ state: 'corrupt', raw: '{bad json' })
    const future = JSON.stringify({ ...preferences, schemaVersion: 2 })
    expect(decodeLayoutPreferences(future)).toEqual({ state: 'unsupported', raw: future })
  })

  test('rejects unknown keys, duplicate IDs, invalid ratios, and excessive depth', () => {
    expect(
      decodeLayoutPreferences(JSON.stringify({ ...preferences, credential: 'must-not-persist' }))
    ).toMatchObject({ state: 'corrupt' })

    const duplicate = {
      ...preferences,
      center: {
        kind: 'split',
        id: 'same',
        direction: 'row',
        ratio: 0.5,
        children: [
          { kind: 'leaf', id: 'same', pane: 'terminal' },
          { kind: 'leaf', id: 'other', pane: 'editor' },
        ],
      },
    }
    expect(decodeLayoutPreferences(JSON.stringify(duplicate))).toMatchObject({ state: 'corrupt' })
    expect(
      decodeLayoutPreferences(
        JSON.stringify({
          ...preferences,
          center: { ...duplicate.center, id: 'split', ratio: 0.99 },
        })
      )
    ).toMatchObject({ state: 'corrupt' })
  })

  test('serializes only the declared ephemeral preference fields', () => {
    const raw = serializeLayoutPreferences(preferences)
    expect(raw).not.toContain('credential')
    expect(raw).not.toContain('terminal output')
    expect(raw).not.toContain('processId')
  })
})
