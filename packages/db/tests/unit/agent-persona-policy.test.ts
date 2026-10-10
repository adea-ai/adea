// Pure policy suite for Agent persona changes (M14.03.2, adea#1218): a
// profile/presentation change never broadens structural authority, never
// rewrites the revision token, and fails closed on a stale or malformed pin.
import { describe, expect, test } from 'bun:test'

import {
  AGENT_AUTHORITY_FIELDS,
  decideAgentPersonaChange,
  type AgentAuthoritySnapshot,
} from '../../src/agent-persona-policy'

const WORKSPACE = '00000000-0000-4000-8000-00000000000a'
const ELSEWHERE = '00000000-0000-4000-8000-00000000000b'

function agent(overrides: Partial<AgentAuthoritySnapshot> = {}): AgentAuthoritySnapshot {
  return {
    agentId: '00000000-0000-4000-8000-0000000000aa',
    isWorkspaceLead: false,
    lifecycleState: 'active',
    profileRevision: 3,
    workspaceId: WORKSPACE,
    ...overrides,
  }
}

function decide(overrides: Partial<Parameters<typeof decideAgentPersonaChange>[0]> = {}) {
  return decideAgentPersonaChange({
    agent: agent(),
    authorizedWorkspaceId: WORKSPACE,
    change: { profileId: 'prf_next', profileVersion: 'pfv_2' },
    expectedRevision: 3,
    ...overrides,
  })
}

describe('agent persona change decision', () => {
  test('an allowed change carries the observed authority through unchanged', () => {
    const decision = decide()
    expect(decision.allowed).toBe(true)
    if (!decision.allowed) return
    expect(decision.plan).toEqual({
      agentId: agent().agentId,
      workspaceId: WORKSPACE,
      preservedAuthority: agent(),
      profileId: 'prf_next',
      profileVersion: 'pfv_2',
      observedProfileRevision: 3,
      nextProfileRevision: 4,
    })
    // Normalization happens in the plan, never in the raw change.
    const padded = decide({ change: { profileId: '  prf_next  ', profileVersion: ' pfv_2 ' } })
    expect(padded.allowed && padded.plan.profileId).toBe('prf_next')
  })

  test('a presentation-only change is allowed; profile state passes through', () => {
    const decision = decide({
      change: {
        avatarRef: 'avatar://next',
        name: 'Renamed',
        presentationMetadata: { accent: 'violet' },
        profileId: 'prf_next',
        profileState: 'deprecated',
        profileVersion: 'pfv_2',
        roleSummary: 'Keeps the books',
      },
    })
    expect(decision.allowed).toBe(true)
  })

  test('every structural field in the change refuses as grant broadening', () => {
    const attempts: ReadonlyArray<Record<string, unknown>> = [
      { id: '00000000-0000-4000-8000-0000000000ff' },
      { workspaceId: ELSEWHERE },
      { projectId: '00000000-0000-4000-8000-0000000000ff' },
      { isWorkspaceLead: true },
      { lifecycleState: 'archived' },
      { profileRevision: 99 },
    ]
    for (const attempt of attempts) {
      const decision = decide({
        change: { profileId: 'prf_next', profileVersion: 'pfv_2', ...attempt },
      })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('persona_change_would_broaden_grants')
    }
    // The list the guard enforces is exported so the shared API can build its
    // accepted-field projection from the same source.
    expect(new Set(AGENT_AUTHORITY_FIELDS).size).toBe(AGENT_AUTHORITY_FIELDS.length)
  })

  test('a foreign or missing agent is unavailable', () => {
    expect(
      decide({ agent: null }).allowed === false &&
        (decide({ agent: null }) as { reason: string }).reason
    ).toBe('agent_unavailable')
    const foreign = decide({ agent: agent({ workspaceId: ELSEWHERE }) })
    expect(foreign.allowed).toBe(false)
    if (!foreign.allowed) expect(foreign.reason).toBe('agent_unavailable')
  })

  test('a stale revision or malformed pin refuses without broadening', () => {
    const stale = decide({ expectedRevision: 2 })
    expect(stale.allowed).toBe(false)
    if (!stale.allowed) expect(stale.reason).toBe('persona_stale_revision')
    for (const change of [{}, { profileId: 'prf_next' }, { profileVersion: 'pfv_2' }]) {
      const decision = decide({ change })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toBe('persona_invalid_profile')
    }
    expect(decide({ change: { profileId: '  ', profileVersion: 'pfv_2' } }).allowed).toBe(false)
  })
})
