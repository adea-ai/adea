import { describe, expect, test } from 'bun:test'

import { resolveDevSelection } from '../src/selection'

const projects = [
  {
    id: 'project-a',
    sessions: [
      { id: 'session-a1', archived: false },
      { id: 'session-a2', archived: true },
    ],
  },
  {
    id: 'project-b',
    sessions: [{ id: 'session-b1', archived: false }],
  },
]

describe('Dev selection resolution', () => {
  test('resolves a live project/session pair', () => {
    expect(
      resolveDevSelection({
        projects,
        requestedProjectId: 'project-b',
        requestedSessionId: 'session-b1',
      })
    ).toEqual({ status: 'resolved', projectId: 'project-b', runtimeSessionId: 'session-b1' })
  })

  test('defaults to the first project and its first live session', () => {
    expect(resolveDevSelection({ projects })).toEqual({
      status: 'recovered',
      projectId: 'project-a',
      runtimeSessionId: 'session-a1',
      reason: 'session_missing',
    })
  })

  test('recovers a missing project to the first project without crossing sessions', () => {
    expect(
      resolveDevSelection({
        projects,
        requestedProjectId: 'ghost',
        requestedSessionId: 'session-b1',
      })
    ).toEqual({
      status: 'recovered',
      projectId: 'project-a',
      runtimeSessionId: 'session-a1',
      reason: 'project_missing',
    })
  })

  test('recovers an archived selection to a live session in the same project', () => {
    expect(
      resolveDevSelection({
        projects,
        requestedProjectId: 'project-a',
        requestedSessionId: 'session-a2',
      })
    ).toEqual({
      status: 'recovered',
      projectId: 'project-a',
      runtimeSessionId: 'session-a1',
      reason: 'session_archived',
    })
  })

  test('reports an empty project without inventing a session', () => {
    const archivedOnly = [{ id: 'project-z', sessions: [{ id: 'z1', archived: true }] }]
    expect(
      resolveDevSelection({ projects: archivedOnly, requestedProjectId: 'project-z' })
    ).toEqual({
      status: 'recovered',
      projectId: 'project-z',
      runtimeSessionId: '',
      reason: 'project_empty',
    })
  })

  test('reports an empty projection', () => {
    expect(resolveDevSelection({ projects: [] })).toEqual({ status: 'empty' })
  })
})
