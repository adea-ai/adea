// Agents-pane harness status model (#400): truthful state derivation and
// labels pinned without DOM.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun, Scope } from '@adea-ai/types/dev-runtime'
import {
  deriveHarnessStatus,
  harnessStatusLabel,
  installationDisplayState,
  INSTALLATION_STATE_LABELS,
  isGlobalDefault,
  selectActiveRun,
} from '../src/agents/harness-status-model'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function run(overrides: Partial<HarnessRun> = {}): HarnessRun {
  return {
    id: 'run-1',
    scope: SCOPE,
    runtimeSessionId: 'session-1',
    installationId: 'inst-1',
    agentProfile: {
      id: 'profile-1',
      version: 1,
      displayName: 'profile-1',
      capabilityPolicyVersion: 1,
    },
    state: 'starting',
    generation: 1,
    version: 1,
    ...overrides,
  }
}

describe('deriveHarnessStatus', () => {
  test('an empty history renders idle and never fabricates a run', () => {
    const view = deriveHarnessStatus([])
    expect(view.state).toBe('idle')
    expect(view.label).toBe('No harness run')
    expect(view.run).toBeUndefined()
    expect(view.terminalFallback).toBe(false)
  })

  test('live runs win over newer terminal runs and surface their state', () => {
    const older = run({ id: 'old', state: 'working', startedAt: '2026-09-19T10:00:00Z' })
    const newerTerminal = run({
      id: 'done',
      state: 'completed',
      startedAt: '2026-09-19T11:00:00Z',
      finishedAt: '2026-09-19T11:01:00Z',
    })
    // The live run wins even though the terminal run started later.
    expect(deriveHarnessStatus([newerTerminal, older]).run?.id).toBe('old')
    expect(deriveHarnessStatus([older]).state).toBe('working')
  })

  test('unknown states stay unknown with their own label and tone', () => {
    const view = deriveHarnessStatus([run({ state: 'unknown' })])
    expect(view.state).toBe('unknown')
    expect(view.label).toBe('Harness state unknown')
    expect(view.tone).toBe('unknown')
  })

  test('a working run with no ready connection flags the terminal fallback', () => {
    const working = run({ state: 'working' })
    expect(deriveHarnessStatus([working], []).terminalFallback).toBe(true)
    const readyConnection = {
      runtimeSessionId: 'session-1',
      state: 'ready',
    } as unknown as Parameters<typeof deriveHarnessStatus>[1][number]
    expect(deriveHarnessStatus([working], [readyConnection]).terminalFallback).toBe(false)
  })

  test('starting runs always flag the fallback until structured events arrive', () => {
    expect(deriveHarnessStatus([run({ state: 'starting' })]).terminalFallback).toBe(true)
  })
})

describe('labels and helpers', () => {
  test('every run state has a full accessible label', () => {
    for (const state of [
      'resolving',
      'starting',
      'working',
      'awaiting_input',
      'awaiting_approval',
      'completed',
      'failed',
      'cancelled',
      'disconnected',
      'unknown',
      'idle',
    ] as const) {
      expect(harnessStatusLabel(state).length).toBeGreaterThan(0)
    }
  })

  test('installation display states render distinctly', () => {
    const managedReady = { state: 'ready', installationId: 'managed-1' } as const
    const healthy = { auth: 'ready', health: 'healthy' } as const
    expect(
      installationDisplayState({
        preference: undefined,
        managedPi: managedReady,
        installationId: 'managed-1',
      })
    ).toBe('ready')
    // A discovered user-managed installation renders its facts.
    expect(
      installationDisplayState({
        preference: undefined,
        managedPi: managedReady,
        installationId: 'other',
        discovered: healthy,
      })
    ).toBe('ready')
    expect(
      installationDisplayState({
        preference: undefined,
        managedPi: managedReady,
        installationId: 'other',
        discovered: { auth: 'required', health: 'healthy' },
      })
    ).toBe('auth_required')
    expect(
      installationDisplayState({
        preference: undefined,
        managedPi: managedReady,
        installationId: 'other',
        discovered: { auth: 'ready', health: 'unhealthy' },
      })
    ).toBe('unhealthy')
    // No discovered facts and not the managed install: missing, not ready.
    expect(
      installationDisplayState({
        preference: undefined,
        managedPi: managedReady,
        installationId: 'other',
      })
    ).toBe('not_installed')
    expect(
      installationDisplayState({
        preference: {
          scope: SCOPE,
          harnessInstallationId: 'x',
          enabled: false,
          sortKey: '0',
          default: false,
          version: 1,
        },
        managedPi: undefined,
        installationId: 'x',
        discovered: healthy,
      })
    ).toBe('disabled')
    expect(
      installationDisplayState({
        preference: undefined,
        managedPi: { state: 'absent', installationId: undefined },
        installationId: 'managed-1',
      })
    ).toBe('not_installed')
    for (const label of Object.values(INSTALLATION_STATE_LABELS)) {
      expect(label.length).toBeGreaterThan(0)
    }
  })

  test('the global default needs enabled plus default without a project scope', () => {
    const base = { scope: SCOPE, harnessInstallationId: 'x', sortKey: '0', version: 1 }
    expect(isGlobalDefault(undefined)).toBe(false)
    expect(isGlobalDefault({ ...base, enabled: true, default: true } as never)).toBe(true)
    expect(
      isGlobalDefault({ ...base, enabled: true, default: true, projectId: 'p' } as never)
    ).toBe(false)
    expect(isGlobalDefault({ ...base, enabled: false, default: true } as never)).toBe(false)
  })

  test('selectActiveRun prefers recency among live runs', () => {
    const first = run({ id: 'a', state: 'awaiting_input', startedAt: '2026-09-19T10:00:00Z' })
    const second = run({ id: 'b', state: 'working', startedAt: '2026-09-19T10:01:00Z' })
    expect(selectActiveRun([first, second])?.id).toBe('b')
  })
})
