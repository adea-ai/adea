/*
 * Editor save-conflict experience model (#677 — the UI-lane half of the
 * "terminal + editor concurrent edit" acceptance case). The provider-level
 * compare-and-swap refusal is proven in the desktop suite; this model owns
 * what the EDITOR SURFACE does with that refusal when a live external writer
 * (a terminal, an agent, another process) changed the file between the
 * editor's read and its save:
 *
 * - the refusal surfaces as a typed conflict — local edits are kept, nothing
 *   is silently clobbered, and the banner names the external-writer case;
 * - the only two ways out are the explicit resolution records: Reload
 *   (discards local edits and re-pins to the disk identity) or Overwrite
 *   (re-pins to a freshly observed identity and retries — the retry is
 *   itself a CAS over the external writer's bytes);
 * - the pinned-identity chain stays continuous, so once a save or an
 *   overwrite lands, later saves carry the new identity and never
 *   re-conflict against it.
 *
 * Pure data: the component holds this state in one signal and binds its
 * buttons to the resolution records, so surface and model cannot drift.
 */
import type { FileIdentity } from '@adea-ai/types/dev-runtime'

export type SaveConflictDecision =
  | Readonly<{ kind: 'saved' }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'error'; code: string; message: string }>

/** Classify a save reply. Only the provider's `file_changed` refusal is a
 *  conflict; every other rejection is a plain typed error. */
export function classifySaveReply(reply: unknown): SaveConflictDecision {
  const code = (reply as { error?: { code?: string; message?: string } } | null)?.error?.code
  if (code === 'file_changed') return { kind: 'conflict' }
  const error = (reply as { error?: { code?: string; message?: string } } | null)?.error
  return {
    kind: 'error',
    code: error?.code ?? 'error',
    message: error?.message ?? 'operation failed',
  }
}

/** The editor's compare-and-swap chain: the identity the next save pins, and
 *  whether a conflict is being surfaced. */
export type EditorCasState = Readonly<{
  pinnedIdentity: FileIdentity
  conflict: boolean
}>

export function initialEditorCas(identity: FileIdentity): EditorCasState {
  return { pinnedIdentity: identity, conflict: false }
}

export function editorCasAfterSave(
  state: EditorCasState,
  decision: SaveConflictDecision,
  savedIdentity?: FileIdentity
): EditorCasState {
  switch (decision.kind) {
    case 'saved':
      return {
        pinnedIdentity: savedIdentity ?? state.pinnedIdentity,
        conflict: false,
      }
    case 'conflict':
      // An external writer won the race. The pin is unchanged, so a retry
      // without a resolution would refuse again — nothing is overwritten.
      return { pinnedIdentity: state.pinnedIdentity, conflict: true }
    case 'error':
      return state
  }
}

/** Reload resolution: the fresh read's identity becomes the pin and the
 *  conflict clears. The component discards local edits in the same flow. */
export function editorCasAfterReload(diskIdentity: FileIdentity): EditorCasState {
  return { pinnedIdentity: diskIdentity, conflict: false }
}

/** Overwrite resolution, step one: re-stat the live identity and pin it so
 *  the retry refuses if the external writer moved again mid-flight. */
export function editorCasAfterOverwritePin(liveIdentity: FileIdentity): EditorCasState {
  return { pinnedIdentity: liveIdentity, conflict: false }
}

export type ConflictResolutionAction = 'reload' | 'overwrite'

export type ConflictResolution = Readonly<{
  action: ConflictResolutionAction
  label: string
  discardsLocalEdits: boolean
  requiresFreshIdentity: boolean
}>

/** The banner's choices, stated as records. `requiresFreshIdentity` is the
 *  overwrite contract: the live identity is observed immediately before the
 *  retrying write, never reused from the conflicted attempt. */
export const CONFLICT_RESOLUTIONS: readonly ConflictResolution[] = [
  {
    action: 'reload',
    label: 'Reload (discard local edits)',
    discardsLocalEdits: true,
    requiresFreshIdentity: false,
  },
  {
    action: 'overwrite',
    label: 'Overwrite disk copy',
    discardsLocalEdits: false,
    requiresFreshIdentity: true,
  },
]

export function conflictResolution(
  action: ConflictResolutionAction
): ConflictResolution | undefined {
  return CONFLICT_RESOLUTIONS.find((resolution) => resolution.action === action)
}

/** The conflict banner names the external-writer case a person can act on. */
export function conflictBannerCopy(): string {
  return 'The file changed on disk since it was loaded — a terminal or another process may have written it.'
}

/** The one-line audit sentence for an overwrite (who consented, to what). */
export function overwriteAuditCopy(relativePath: string): string {
  return `Overwrote ${relativePath} over the changed disk copy at your explicit request.`
}
