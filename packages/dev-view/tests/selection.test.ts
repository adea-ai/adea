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

  test('a cross-scope deep link never resolves; the active scope recovers visibly', () => {
    const scope = { accountId: 'a', workspaceId: 'w', runtimeNodeId: 'n' }
    const otherScope = { accountId: 'a', workspaceId: 'other', runtimeNodeId: 'n' }
    expect(
      resolveDevSelection({
        projects,
        scope,
        requestedScope: otherScope,
        requestedProjectId: 'project-b',
        requestedSessionId: 'session-b1',
      })
    ).toEqual({
      status: 'recovered',
      projectId: 'project-a',
      runtimeSessionId: 'session-a1',
      reason: 'cross_scope',
    })
    // The same IDs inside the active scope resolve normally.
    expect(
      resolveDevSelection({
        projects,
        scope,
        requestedScope: scope,
        requestedProjectId: 'project-b',
        requestedSessionId: 'session-b1',
      })
    ).toEqual({ status: 'resolved', projectId: 'project-b', runtimeSessionId: 'session-b1' })
  })

  test('a generation-mismatched selection recovers instead of pairing stale authority', () => {
    const generated = [
      {
        id: 'project-a',
        sessions: [{ id: 'session-a1', archived: false, generation: 3 }],
      },
    ]
    expect(
      resolveDevSelection({
        projects: generated,
        requestedProjectId: 'project-a',
        requestedSessionId: 'session-a1',
        requestedGeneration: 2,
      })
    ).toEqual({
      status: 'recovered',
      projectId: 'project-a',
      runtimeSessionId: 'session-a1',
      reason: 'stale_generation',
    })
    expect(
      resolveDevSelection({
        projects: generated,
        requestedProjectId: 'project-a',
        requestedSessionId: 'session-a1',
        requestedGeneration: 3,
      })
    ).toEqual({ status: 'resolved', projectId: 'project-a', runtimeSessionId: 'session-a1' })
  })

  test('an explicitly revoked session recovers within its project, never across projects', () => {
    const twoLive = [
      {
        id: 'project-b',
        sessions: [
          { id: 'session-b1', archived: false },
          { id: 'session-b2', archived: false },
        ],
      },
    ]
    expect(
      resolveDevSelection({
        projects: twoLive,
        requestedProjectId: 'project-b',
        requestedSessionId: 'session-b1',
        revokedRuntimeSessionIds: ['session-b1'],
      })
    ).toEqual({
      status: 'recovered',
      projectId: 'project-b',
      runtimeSessionId: 'session-b2',
      reason: 'session_revoked',
    })
    // With no other live session in the project, recovery stays empty-handed
    // rather than pulling a session from another project.
    expect(
      resolveDevSelection({
        projects,
        requestedProjectId: 'project-b',
        requestedSessionId: 'session-b1',
        revokedRuntimeSessionIds: ['session-b1'],
      })
    ).toEqual({
      status: 'recovered',
      projectId: 'project-b',
      runtimeSessionId: '',
      reason: 'project_empty',
    })
  })

  test('a projection past its freshness window is reported stale, not silently trusted', () => {
    expect(
      resolveDevSelection({
        projects,
        requestedProjectId: 'project-b',
        requestedSessionId: 'session-b1',
        observedAt: '2026-09-19T10:00:00.000Z',
        staleAfterMs: 30_000,
        now: '2026-09-19T10:01:00.000Z',
      })
    ).toEqual({
      status: 'resolved',
      projectId: 'project-b',
      runtimeSessionId: 'session-b1',
      stale: true,
    })
    expect(
      resolveDevSelection({
        projects,
        requestedProjectId: 'project-b',
        requestedSessionId: 'session-b1',
        observedAt: '2026-09-19T10:00:00.000Z',
        staleAfterMs: 30_000,
        now: '2026-09-19T10:00:20.000Z',
      })
    ).toEqual({
      status: 'resolved',
      projectId: 'project-b',
      runtimeSessionId: 'session-b1',
      stale: false,
    })
  })
})
