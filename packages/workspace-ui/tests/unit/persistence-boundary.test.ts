// Regression pins for the conventional-workspace persistence boundary (#302).
//
// `restoreConventionalState` merges whatever it is handed straight into the
// store, so the validator is the only thing standing between a corrupt
// localStorage blob and a corrupted workspace. Before the boundary, the reader
// deleted malformed text outright and handed anything that parsed to the store.
import { expect, test } from 'bun:test'

import { validatePersistedState } from '../../src/use-workspace-persistence'

const blob = {
  activeSurface: 'conversation',
  collapsedProjectIds: ['project-a', 'project-b'],
  drafts: { 'project-a': 'unsent text' },
  selectedAgentId: null,
  selectedChannelId: 'channel-1',
  selectedProjectId: 'project-a',
  selectedTaskId: null,
  selectedWorkspaceId: 'workspace-1',
  threadRootMessageId: null,
}

test('a well-formed blob restores every persisted field', () => {
  expect(validatePersistedState({ ...blob })).toEqual(blob)
})

test('a legacy blob missing newer fields still restores what it has', () => {
  const legacy = { selectedProjectId: 'project-a', activeSurface: 'agents' }
  expect(validatePersistedState(legacy)).toEqual(legacy)
})

test('a present field of the wrong type rejects the whole blob', () => {
  // Each of these parsed as JSON but would have been merged into the store:
  // a numeric id, a string where a list belongs, a non-object draft map.
  expect(validatePersistedState({ ...blob, selectedProjectId: 42 })).toBeUndefined()
  expect(validatePersistedState({ ...blob, collapsedProjectIds: 'project-a' })).toBeUndefined()
  expect(validatePersistedState({ ...blob, collapsedProjectIds: [1, 2] })).toBeUndefined()
  expect(validatePersistedState({ ...blob, drafts: 'nope' })).toBeUndefined()
  expect(validatePersistedState({ ...blob, drafts: ['nope'] })).toBeUndefined()
  expect(validatePersistedState({ ...blob, drafts: { 'project-a': 7 } })).toBeUndefined()
  expect(validatePersistedState({ ...blob, selectedAgentId: {} })).toBeUndefined()
  expect(validatePersistedState({ ...blob, activeSurface: 'nowhere' })).toBeUndefined()
})

test('anything that is not an object is rejected', () => {
  expect(validatePersistedState(null)).toBeUndefined()
  expect(validatePersistedState('a string')).toBeUndefined()
  expect(validatePersistedState(42)).toBeUndefined()
  expect(validatePersistedState(['project-a'])).toBeUndefined()
})
