// Harness preferences and launch resolution (#400).
//
// The user-expressed preference overlay on a runtime node, plus the
// resolution order the launch transaction consumes. Owner decision
// (2026-09-16): on a CLEAN desktop — no stored preference of any kind — the
// effective list synthesizes managed Pi as the enabled global default.
// Discovered user-installed harnesses enter the ordering only through user
// action (enable / reorder / set-default), and reset-to-discovered clears the
// stored overlay so the managed-Pi-first projection returns.
//
// Preferences reference installations by stable ID and never store credential
// values — there is no credential field in the model. A disabled preference
// is never auto-launched. An explicit default (project, then global) is
// AUTHORITATIVE: when the installation it names exists but is not
// launch-eligible, resolution refuses with the typed reason instead of
// silently launching a different harness. The managed-Pi root default applies
// only when the user expressed no global default.
import { join } from 'node:path'

import type { HarnessPreference, Scope } from '../../../../../../packages/types/src/dev-runtime'
import { createDurableJsonStore } from '../host-store'

const PREFS_STORE_FILE = join('dev-runtime', 'harness', 'preferences.json')
/** Maximum stored preference records per scope (bounded like every store). */
export const MAX_PREFERENCES = 128

/** Sort positions are padded record-array positions (register convention). */
const sortKeyFor = (index: number): string => String(index).padStart(10, '0')

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

export type HarnessPreferenceRecord = HarnessPreference

export type PreferenceResolution =
  | Readonly<{ kind: 'preference'; preference: HarnessPreference }>
  | Readonly<{ kind: 'root_default' }>

export type HarnessPreferenceAuthority = Readonly<{
  /** The effective projection: stored overlay plus the root default. */
  effective(projectId?: string): HarnessPreference[]
  stored(): readonly HarnessPreferenceRecord[]
  upsert(record: HarnessPreferenceRecord): void
  clear(projectId?: string): void
  /**
   * Resolves the launch candidate: an explicit project default, then an
   * explicit global default, then the managed-Pi root default. `undefined`
   * means nothing is launchable — the caller reports the typed gap.
   */
  resolveDefault(projectId: string | undefined): PreferenceResolution | undefined
}>

export function createHarnessPreferenceAuthority(input: {
  dataDir: string
  scope: Scope
  /** The managed installation id when ready; the root-default anchor. */
  managedInstallationId: () => string | undefined
}): HarnessPreferenceAuthority {
  const store = createDurableJsonStore<HarnessPreferenceRecord>({
    file: join(input.dataDir, PREFS_STORE_FILE),
    schemaVersion: 1,
    label: 'harness preferences',
  })

  const storedInScope = (): HarnessPreferenceRecord[] =>
    store
      .load()
      .records.filter((record) => sameScope(record.scope, input.scope))
      .toSorted((left, right) => left.sortKey.localeCompare(right.sortKey))

  const save = (records: readonly HarnessPreferenceRecord[]): void => store.save([...records])

  /** The synthesized managed-Pi-first root default: present exactly when no
   * stored ENABLED global default exists and the managed installation is
   * ready. A disabled stored default never blocks the root default — that is
   * the fallback chain, and a disabled harness is itself never auto-launched. */
  function rootDefault(): HarnessPreference | undefined {
    if (
      storedInScope().some(
        (record) => record.projectId === undefined && record.default && record.enabled
      )
    ) {
      return undefined
    }
    const managedId = input.managedInstallationId()
    if (!managedId) return undefined
    return {
      scope: input.scope,
      harnessInstallationId: managedId,
      enabled: true,
      sortKey: sortKeyFor(0),
      default: true,
      version: 1,
    }
  }

  return {
    effective(projectId) {
      const stored = storedInScope().filter(
        (record) =>
          projectId === undefined ||
          record.projectId === projectId ||
          record.projectId === undefined
      )
      const root = rootDefault()
      return root ? [root, ...stored] : stored
    },
    stored: () => storedInScope(),
    upsert(record) {
      if (!sameScope(record.scope, input.scope)) {
        throw {
          code: 'channel_unauthorized',
          retryable: false,
          message: 'preference scope is not authorized',
        }
      }
      const others = storedInScope().filter(
        (entry) =>
          !(
            entry.harnessInstallationId === record.harnessInstallationId &&
            (entry.projectId ?? undefined) === (record.projectId ?? undefined)
          )
      )
      if (others.length >= MAX_PREFERENCES) {
        throw {
          code: 'limit_exceeded',
          retryable: false,
          message: `harness preferences exceed the retained ${MAX_PREFERENCES} records`,
        }
      }
      // One default per scope slice: setting a default clears its siblings.
      const cleared = record.default
        ? others.map((entry) =>
            (entry.projectId ?? undefined) === (record.projectId ?? undefined) && entry.default
              ? { ...entry, default: false, version: entry.version + 1 }
              : entry
          )
        : others
      save(
        [...cleared, record].toSorted((left, right) => left.sortKey.localeCompare(right.sortKey))
      )
    },
    clear(projectId) {
      save(
        storedInScope().filter((record) =>
          projectId === undefined ? false : record.projectId !== projectId
        )
      )
    },
    resolveDefault(projectId) {
      const stored = storedInScope()
      if (projectId !== undefined) {
        const projectDefault = stored.find(
          (record) => record.projectId === projectId && record.default && record.enabled
        )
        if (projectDefault) return { kind: 'preference', preference: projectDefault }
      }
      const globalDefault = stored.find(
        (record) => record.projectId === undefined && record.default && record.enabled
      )
      if (globalDefault) return { kind: 'preference', preference: globalDefault }
      const root = rootDefault()
      if (root && root.enabled) return { kind: 'root_default' }
      return undefined
    },
  }
}
