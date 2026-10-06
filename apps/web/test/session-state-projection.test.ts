// Projection-mapping logic from the desktop runtime bridge, tested without a
// DOM. These are the decisions that used to be buried inside a Solid component,
// where a wrong answer renders as "everything looks fine" and a test cannot see
// it: `packages/dev-view/tests` contains no `.tsx` test at all.
import { describe, expect, test } from 'bun:test'

import {
  CANONICAL_SESSION_STATES,
  canonicalSessionState,
  toProjection,
} from '../src/lib/desktop-dev-runtime'

describe('session state projection', () => {
  // Every lifecycle `RuntimeSession` can carry must survive the projection. It
  // used to collapse to `active`/`ready`, so a session whose run had FAILED was
  // announced and coloured "ready" — while the projection type explicitly
  // promised those states were "not coerced into active/ready".
  test('carries every canonical lifecycle through unchanged', () => {
    for (const state of CANONICAL_SESSION_STATES) expect(canonicalSessionState(state)).toBe(state)
  })

  test('never coerces a terminal or errored lifecycle into ready', () => {
    // These five are exactly what the old ternary destroyed.
    for (const state of ['preparing', 'disconnected', 'completed', 'failed', 'cancelled'])
      expect(canonicalSessionState(state)).not.toBe('ready')
  })

  test('falls back to ready only for a lifecycle it does not recognise', () => {
    // A future register value must not be passed through into a union the type
    // does not allow, and must not blank the row either.
    for (const unknown of ['', 'READY', 'exploded', 'active ', 7, null, undefined, {}])
      expect(canonicalSessionState(unknown)).toBe('ready')
  })

  test('is case sensitive, because the register is', () => {
    expect(canonicalSessionState('active')).toBe('active')
    expect(canonicalSessionState('Active')).toBe('ready')
    expect(canonicalSessionState('FAILED')).toBe('ready')
  })
})

function project(session: Record<string, unknown>) {
  return toProjection(
    { items: [{ id: 'project' }] },
    {
      items: [
        {
          id: 'session',
          projectId: 'project',
          worktreeId: 'worktree',
          lifecycle: 'active',
          ...session,
        },
      ],
    }
  ).projects[0]!.sessions[0]!
}

describe('selected session terminal identity', () => {
  test('preserves the primary terminal and session generation supplied by the runtime', () => {
    expect(project({ terminalId: 'primary-terminal', generation: 7 })).toMatchObject({
      terminalId: 'primary-terminal',
      generation: 7,
      worktreeId: 'worktree',
    })
    expect(project({ terminalId: 'primary-terminal', generation: 0 }).generation).toBe(0)
  })

  test('does not invent a primary terminal or generation for older projections', () => {
    expect(project({})).not.toHaveProperty('terminalId')
    expect(project({})).not.toHaveProperty('generation')
  })

  test('does not promote malformed optional identity fields into usable authority', () => {
    for (const terminalId of ['', 7, null, {}])
      expect(project({ terminalId })).not.toHaveProperty('terminalId')
    for (const generation of [-1, 1.5, NaN, Infinity, '7', null])
      expect(project({ generation })).not.toHaveProperty('generation')
  })
})

describe('flat project binding projection', () => {
  test('keeps every binding in register order with its local facts and sessions', () => {
    const projection = toProjection(
      {
        items: [
          { id: 'project-b', repoIds: ['repo-b'], defaultBaseRef: 'main', version: 3 },
          { id: 'project-a', repoIds: [] },
        ],
      },
      { items: [{ id: 'session', projectId: 'project-a', worktreeId: 'w', lifecycle: 'ready' }] }
    )
    expect(projection).not.toHaveProperty('groups')
    expect(projection.projects.map((entry) => entry.id)).toEqual(['project-b', 'project-a'])
    expect(projection.projects[0]).toEqual({
      id: 'project-b',
      repoIds: ['repo-b'],
      branch: 'main',
      version: 3,
      sessions: [],
    })
    expect(projection.projects[1]!.sessions.map((session) => session.id)).toEqual(['session'])
    // The register carries no names; the projection never invents one.
    expect(projection.projects[1]).not.toHaveProperty('name')
  })
})
