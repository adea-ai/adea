import { describe, expect, test } from 'bun:test'
import {
  parseAgentPresentationChange,
  parseAgentProjectChange,
} from '../src/server/agent-edit-request'

describe('Agent presentation and placement requests', () => {
  test('presentation edits carry a safe revision and at least one known, typed field', () => {
    expect(parseAgentPresentationChange({ expectedRevision: 0, name: 'Ada' })).toEqual({
      expectedRevision: 0,
      name: 'Ada',
    })
    expect(
      parseAgentPresentationChange({
        avatarRef: null,
        characterRef: 'character:75',
        expectedRevision: 2,
        presentationMetadata: { accent: 'violet' },
        roleSummary: null,
      })
    ).toEqual({
      avatarRef: null,
      characterRef: 'character:75',
      expectedRevision: 2,
      presentationMetadata: { accent: 'violet' },
      roleSummary: null,
    })
  })

  test('presentation edits without a revision, a field, or a valid shape are refused', () => {
    for (const body of [
      null,
      [],
      {},
      { name: 'Ada' },
      { expectedRevision: -1, name: 'Ada' },
      { expectedRevision: 1.5, name: 'Ada' },
      { expectedRevision: '1', name: 'Ada' },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1, name: 'Ada' },
      { expectedRevision: 0 },
      { expectedRevision: 0, name: '   ' },
      { expectedRevision: 0, name: 7 },
      { expectedRevision: 0, name: 'Ada', profileId: 'prf_01JABCDEF0123456789ABCDEFG' },
      { expectedRevision: 0, presentationMetadata: { accent: 1 } },
      { expectedRevision: 0, roleSummary: 7 },
    ]) {
      expect(parseAgentPresentationChange(body)).toBeNull()
    }
  })

  test('placement edits carry a safe revision and an explicit project or null', () => {
    expect(parseAgentProjectChange({ expectedRevision: 3, projectId: 'project-1' })).toEqual({
      expectedRevision: 3,
      projectId: 'project-1',
    })
    expect(parseAgentProjectChange({ expectedRevision: 3, projectId: null })).toEqual({
      expectedRevision: 3,
      projectId: null,
    })
  })

  test('placement edits without a revision, an explicit project, or extra fields are refused', () => {
    for (const body of [
      { projectId: 'project-1' },
      { expectedRevision: 3 },
      { expectedRevision: 3, projectId: '  ' },
      { expectedRevision: 3, projectId: 7 },
      { expectedRevision: 3, projectId: 'project-1', extra: true },
      { expectedRevision: -1, projectId: null },
    ]) {
      expect(parseAgentProjectChange(body)).toBeNull()
    }
  })
})
