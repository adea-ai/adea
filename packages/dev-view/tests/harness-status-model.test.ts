// Agents-pane harness status model (#400): truthful state derivation and
// labels pinned without DOM.
import { describe, expect, test } from 'bun:test'

import type {
  HarnessPreference,
  HarnessRun,
  RuntimeConnectionInventoryEntry,
  Scope,
} from '@adea-ai/types/dev-runtime'
import {
  buildHarnessInventoryRows,
  capabilityLabel,
  deriveHarnessStatus,
  harnessStatusLabel,
  installationDisplayState,
  INSTALLATION_STATE_LABELS,
  isGlobalDefault,
  selectActiveRun,
  storedWorkspaceDefault,
  summarizeHarnessDefault,
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

function entry(
  overrides: Partial<RuntimeConnectionInventoryEntry> = {}
): RuntimeConnectionInventoryEntry {
  return {
    id: 'inst-codex',
    scope: SCOPE,
    family: 'codex',
    displayName: 'Codex',
    driverId: 'local-executable',
    driverVersion: '1',
    provenance: 'user_managed',
    executableIdentity: '/usr/local/bin/codex',
    executableLabel: 'codex (system)',
    protocol: 'native',
    acpAvailability: 'unavailable',
    version: '1.2.3',
    auth: 'ready',
    health: 'healthy',
    capabilities: ['native', 'models', 'resume'],
    sessionOperations: ['session.new'],
    entitlementHints: [],
    limitations: [],
    eligibility: { eligible: true, blockers: [] },
    transport: 'direct_local',
    models: [],
    observedAt: '2026-10-13T12:00:00Z',
    generation: 1,
    ...overrides,
  }
}

function preference(overrides: Partial<HarnessPreference> = {}): HarnessPreference {
  return {
    scope: SCOPE,
    harnessInstallationId: 'inst-codex',
    enabled: true,
    sortKey: '0000000001',
    default: false,
    version: 1,
    ...overrides,
  }
}

const base = (items: RuntimeConnectionInventoryEntry[], extra = {}) => ({
  inventory: { items, freshness: items.map(() => 'fresh' as const) },
  preferences: [] as HarnessPreference[],
  managedPi: undefined,
  ...extra,
})

describe('buildHarnessInventoryRows', () => {
  test('an empty or missing inventory is an empty list, never a guess', () => {
    expect(
      buildHarnessInventoryRows({ inventory: undefined, preferences: [], managedPi: undefined })
    ).toEqual([])
    expect(
      buildHarnessInventoryRows({
        inventory: { items: [], freshness: [] },
        preferences: [],
        managedPi: { state: 'absent', installationId: undefined, executableLabel: undefined },
      })
    ).toEqual([])
  })

  test('rows carry reported names, versions, capabilities and what can be made default', () => {
    const [row] = buildHarnessInventoryRows(base([entry()]))
    expect(row).toMatchObject({
      installationId: 'inst-codex',
      family: 'codex',
      name: 'Codex',
      version: '1.2.3',
      state: 'ready',
      capabilities: ['native', 'models', 'resume'],
      isDeviceDefault: false,
      isWorkspaceDefault: false,
      canMakeDeviceDefault: true,
      canUseInWorkspace: true,
      stale: false,
    })
  })

  test('auth-required, ineligible and disabled installations cannot become a default', () => {
    const rows = buildHarnessInventoryRows(
      base(
        [
          entry({ id: 'a', auth: 'required' }),
          entry({
            id: 'b',
            eligibility: {
              eligible: false,
              blockers: [{ code: 'incompatible', message: 'Codex 0.1 is too old' }],
            },
          }),
          entry({ id: 'c' }),
        ],
        { preferences: [preference({ harnessInstallationId: 'c', enabled: false })] }
      )
    )
    expect(rows.map((row) => [row.state, row.canMakeDeviceDefault, row.canUseInWorkspace])).toEqual(
      [
        ['auth_required', false, false],
        ['ready', false, false],
        ['disabled', false, false],
      ]
    )
    expect(rows[1]?.blockers).toEqual(['Codex 0.1 is too old'])
  })

  test('the device default is a family; a workspace default is a stored global preference', () => {
    const [row] = buildHarnessInventoryRows(
      base([entry()], {
        deviceDefaultFamily: 'codex',
        preferences: [preference({ default: true })],
      })
    )
    expect(row).toMatchObject({
      isDeviceDefault: true,
      isWorkspaceDefault: true,
      canMakeDeviceDefault: false,
      canUseInWorkspace: false,
    })
    const [other] = buildHarnessInventoryRows(
      base([entry()], {
        deviceDefaultFamily: 'claude-code',
        preferences: [preference({ default: true, projectId: 'project-1' })],
      })
    )
    expect(other).toMatchObject({ isDeviceDefault: false, isWorkspaceDefault: false })
  })

  test('the synthesized managed-Pi fallback is never shown as a workspace choice', () => {
    const rows = buildHarnessInventoryRows(
      base([entry()], {
        preferences: [
          preference({ harnessInstallationId: 'managed-1', default: true, rootDefault: true }),
        ],
        managedPi: { state: 'ready', installationId: 'managed-1', executableLabel: 'Pi (managed)' },
      })
    )
    expect(rows[0]).toMatchObject({
      installationId: 'managed-1',
      family: 'pi',
      name: 'Pi (managed)',
      capabilities: [],
      isWorkspaceDefault: false,
      canUseInWorkspace: true,
    })
    expect(rows).toHaveLength(2)
  })
})

describe('summarizeHarnessDefault', () => {
  const managedPi = {
    state: 'ready' as const,
    installationId: 'managed-1',
    executableLabel: 'Pi (managed)',
  }
  const summary = (
    entries: RuntimeConnectionInventoryEntry[],
    preferences: HarnessPreference[],
    deviceDefaultFamily?: string
  ) => {
    const rows = buildHarnessInventoryRows({
      inventory: { items: entries, freshness: entries.map(() => 'fresh' as const) },
      preferences,
      managedPi,
      deviceDefaultFamily,
    })
    return summarizeHarnessDefault({ rows, preferences, deviceDefaultFamily, managedPi })
  }
  const claude = entry({ id: 'inst-claude', family: 'claude-code', displayName: 'Claude Code' })
  const codex = entry()

  test('with nothing chosen the managed Pi is a labelled fallback', () => {
    expect(summary([claude], [])).toMatchObject({ source: 'fallback', name: 'Pi (managed)' })
  })

  test('the device default applies to a workspace that has no override', () => {
    expect(summary([claude, codex], [], 'codex')).toMatchObject({ source: 'device', name: 'Codex' })
  })

  test('a workspace default overrides the device default and names what it overrides', () => {
    expect(
      summary(
        [claude, codex],
        [preference({ harnessInstallationId: 'inst-claude', default: true })],
        'codex'
      )
    ).toMatchObject({ source: 'workspace', name: 'Claude Code', overriddenDeviceName: 'Codex' })
  })

  test('a device default that is not usable here is reported missing, never substituted', () => {
    expect(summary([claude], [], 'codex')).toEqual({ source: 'none', deviceDefaultMissing: true })
    expect(summary([claude, entry({ auth: 'required' })], [], 'codex')).toEqual({
      source: 'none',
      deviceDefaultMissing: true,
    })
  })

  test('a device default the backend marks ineligible is missing even when it looks ready', () => {
    const blocked = entry({
      eligibility: {
        eligible: false,
        blockers: [{ code: 'incompatible', message: 'Codex 0.1 is too old' }],
      },
    })
    expect(summary([claude, blocked], [], 'codex')).toEqual({
      source: 'none',
      deviceDefaultMissing: true,
    })
    // Another installation of the same family that is eligible wins.
    expect(summary([blocked, entry({ id: 'inst-codex-2' })], [], 'codex')).toMatchObject({
      source: 'device',
      deviceDefaultMissing: false,
    })
  })

  test('a workspace default that is ineligible is flagged unavailable, never replaced', () => {
    const blocked = entry({
      id: 'inst-claude',
      family: 'claude-code',
      displayName: 'Claude Code',
      eligibility: { eligible: false, blockers: [{ code: 'auth_required', message: 'Sign in' }] },
    })
    expect(
      summary(
        [blocked, codex],
        [preference({ harnessInstallationId: 'inst-claude', default: true })],
        'codex'
      )
    ).toMatchObject({
      source: 'workspace',
      name: 'Claude Code',
      overriddenDeviceName: 'Codex',
      workspaceOverrideUnavailable: true,
    })
  })

  test('a workspace default whose installation is gone stays the workspace default', () => {
    const gone = summary(
      [codex],
      [preference({ harnessInstallationId: 'inst-gone', default: true })],
      'codex'
    )
    expect(gone).toEqual({
      source: 'workspace',
      overriddenDeviceName: 'Codex',
      deviceDefaultMissing: false,
      workspaceOverrideUnavailable: true,
    })
    expect(
      storedWorkspaceDefault([preference({ harnessInstallationId: 'inst-gone', default: true })])
    ).toMatchObject({
      harnessInstallationId: 'inst-gone',
    })
    // The synthesized managed-Pi root default and project defaults are not it.
    expect(
      storedWorkspaceDefault([
        preference({ default: true, rootDefault: true }),
        preference({ default: true, projectId: 'project-1' }),
        preference({ default: true, enabled: false }),
      ])
    ).toBeUndefined()
  })
})

describe('capabilityLabel', () => {
  test('names known capabilities and keeps unknown ones readable', () => {
    expect(capabilityLabel('slash_commands')).toBe('Slash commands')
    expect(capabilityLabel('tool.use')).toBe('Tool use')
  })
})
