import type { WorkspaceView } from './workspace-view-toggle'
import type { WorkspacePlugin } from './platform'

/**
 * Compiled trusted first-party entry registry (Dev Runtime spec,
 * "Appearance and App Library": M12 App Library can activate only a bundled
 * first-party entry ID after existing catalog signature/digest/install-plan
 * checks).
 *
 * The registry is compiled into the client bundle: it lists exactly the entry
 * IDs this build ships, each bound to the view the app itself renders. A
 * catalog or plugin manifest can never add, remove, or retarget an entry —
 * an arbitrary non-empty `bundledEntryId` in a manifest is untrusted input.
 * `entryDigest` is the build-time identity the catalog record must echo
 * verbatim; any other value is an integrity failure.
 */
export type TrustedFirstPartyEntry = Readonly<{
  entryId: string
  label: string
  /** The compiled view the entry mounts. */
  view: WorkspaceView
  entryDigest: string
}>

export const trustedFirstPartyAppEntries: Readonly<Record<string, TrustedFirstPartyEntry>> =
  Object.freeze({
    'adea.app.chat': Object.freeze({
      entryId: 'adea.app.chat',
      label: 'Chat',
      view: 'chat',
      entryDigest: 'entry-v1-3f9c2b7a51d08e64',
    }),
    'adea.app.dev': Object.freeze({
      entryId: 'adea.app.dev',
      label: 'Dev',
      view: 'dev',
      entryDigest: 'entry-v1-8c14d2f6a90b5e37',
    }),
    'adea.app.virtual': Object.freeze({
      entryId: 'adea.app.virtual',
      label: 'Virtual',
      view: 'virtual',
      entryDigest: 'entry-v1-b72e409ac5d3168f',
    }),
  })

export type WorkspaceAppActivation =
  | Readonly<{ status: 'activatable'; entryId: string }>
  | Readonly<{
      status: 'activation-unavailable'
      reason:
        | 'not-installed'
        | 'catalog-only'
        /** `bundledEntryId` is not in the compiled registry. */
        | 'untrusted-entry'
        /** Entry digest missing or mismatched. */
        | 'integrity-failure'
        /** Install plan missing or fails the verified-shape check. */
        | 'plan-unverified'
        /** Catalog record carries no source revision. */
        | 'stale'
    }>

/**
 * Activation authority for app surfaces. Resolution is fail-closed and
 * ordered: catalog-only metadata first, then installation, then trust
 * (registry membership), then integrity (entry digest), then the verified
 * install plan, then catalog freshness (source revision). Every rejection
 * names its reason; nothing falls back to activation.
 */
export function resolveAppActivation(plugin: WorkspacePlugin): WorkspaceAppActivation {
  const app = plugin.appSurface
  if (!app?.bundledEntryId) return { status: 'activation-unavailable', reason: 'catalog-only' }
  if (!plugin.installed) return { status: 'activation-unavailable', reason: 'not-installed' }
  const entry = trustedFirstPartyAppEntries[app.bundledEntryId]
  if (!entry) return { status: 'activation-unavailable', reason: 'untrusted-entry' }
  if (!app.digest || app.digest !== entry.entryDigest)
    return { status: 'activation-unavailable', reason: 'integrity-failure' }
  const plan = plugin.installationPlan
  if (
    !plan ||
    plan.planVersion !== 2 ||
    plan.strategy === 'unavailable' ||
    plan.allowedToActivate !== false ||
    plan.approvalRequired !== true
  )
    return { status: 'activation-unavailable', reason: 'plan-unverified' }
  if (!plugin.sourceRevision) return { status: 'activation-unavailable', reason: 'stale' }
  return { status: 'activatable', entryId: entry.entryId }
}

/**
 * Backward-compatible single-argument activation check. The hardened
 * authority above replaced the manifest-trusting behavior; this re-export
 * keeps existing callers on the trusted path.
 */
export const workspaceAppActivation: (plugin: WorkspacePlugin) => WorkspaceAppActivation =
  resolveAppActivation
