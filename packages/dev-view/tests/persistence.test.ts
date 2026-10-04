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
    expect(layoutStorageKey(scope, 'project-a', 'session-a')).toContain(
      '00000000-0000-4000-8000-000000000003:project-a:session-a'
    )
    expect(layoutStorageKey(scope, 'project-a', 'session-b')).not.toBe(
      layoutStorageKey(scope, 'project-a', 'session-a')
    )
    expect(layoutStorageKey(scope, 'project:a', 'session')).not.toBe(
      layoutStorageKey(scope, 'project', 'a:session')
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

  test('a balanced split layout round-trips through the stored document', () => {
    const balanced = {
      ...preferences,
      center: {
        kind: 'split' as const,
        id: 'split-b',
        direction: 'column' as const,
        ratio: 0.5,
        children: [
          {
            kind: 'split' as const,
            id: 'split-a',
            direction: 'row' as const,
            ratio: 0.5,
            children: [
              { kind: 'leaf' as const, id: 'pane-1', pane: 'terminal' as const },
              { kind: 'leaf' as const, id: 'pane-2', pane: 'terminal' as const },
            ],
          },
          { kind: 'leaf' as const, id: 'pane-3', pane: 'terminal' as const },
        ],
      },
      focusTargetId: 'pane-1',
    }
    expect(decodeLayoutPreferences(serializeLayoutPreferences(balanced))).toEqual({
      state: 'ready',
      value: balanced,
    })
  })

  test('a pre-balanced stored band layout restores unchanged', () => {
    // Ratios stored by older builds that evened only the joined band are still
    // valid strict-binary documents; adoption never rewrites layouts on load.
    const legacyBand = {
      ...preferences,
      center: {
        kind: 'split' as const,
        id: 'row-1',
        direction: 'column' as const,
        ratio: 0.5,
        children: [
          { kind: 'leaf' as const, id: 'pane-1', pane: 'terminal' as const },
          {
            kind: 'split' as const,
            id: 'row-2',
            direction: 'row' as const,
            ratio: 1 / 3,
            children: [
              { kind: 'leaf' as const, id: 'pane-2', pane: 'terminal' as const },
              {
                kind: 'split' as const,
                id: 'row-3',
                direction: 'row' as const,
                ratio: 0.5,
                children: [
                  { kind: 'leaf' as const, id: 'pane-3', pane: 'terminal' as const },
                  { kind: 'leaf' as const, id: 'pane-4', pane: 'editor' as const },
                ],
              },
            ],
          },
        ],
      },
      focusTargetId: 'pane-3',
    }
    expect(decodeLayoutPreferences(serializeLayoutPreferences(legacyBand))).toEqual({
      state: 'ready',
      value: legacyBand,
    })
  })
})
