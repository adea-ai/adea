/*
 * Computer-use pane model (issue #472): pure, DOM-free presentation logic
 * for the supervised desktop-automation lanes. Capability rows render only
 * what the injected runtime service reports — a missing report renders an
 * honest cannot-check state, never a fixture — and lane actions follow the
 * takeover/consent lifecycle pinned by the shell's authority gate (Orca's
 * status-pane structure, MIT, revision 403b62a8d8fa6e896a93acc4c15405be0f0
 * b7dc7, translated to Solid; see NOTICE and
 * docs/research/dev-view-donor-audit.md).
 */
import type {
  ComputerUseCapabilityRow,
  ComputerUseCapabilityReport,
  ComputerUseLane,
} from '@adea-ai/types/dev-runtime'

export type CapabilityTone = 'ready' | 'attention' | 'blocked' | 'unknown'

export type CapabilityRowView = Readonly<{
  id: ComputerUseCapabilityRow['id']
  label: string
  tone: CapabilityTone
  stateLabel: string
  /** Why, in plain language — including the exact missing piece. */
  hint: string
}>

const CAPABILITY_LABELS: Readonly<Record<ComputerUseCapabilityRow['id'], string>> = Object.freeze({
  input: 'Keyboard input',
  capture: 'Screen capture',
  ax_tree: 'Accessibility tree',
})

function presentCapability(row: ComputerUseCapabilityRow): CapabilityRowView {
  const label = CAPABILITY_LABELS[row.id]
  switch (row.state) {
    case 'available':
      return { id: row.id, label, tone: 'ready', stateLabel: 'Available', hint: '' }
    case 'denied':
      return {
        id: row.id,
        label,
        tone: 'blocked',
        stateLabel: 'Denied',
        hint: 'Repair it in System Settings; macOS ignores re-prompts once denied.',
      }
    case 'not_determined':
      return {
        id: row.id,
        label,
        tone: 'attention',
        stateLabel: 'Not requested',
        hint: 'Answer the macOS consent prompt, then re-check on the permissions page.',
      }
    case 'unavailable':
      return {
        id: row.id,
        label,
        tone: 'unknown',
        stateLabel: 'Cannot check',
        hint: row.missingPiece ?? 'This lane has no way to provide or prove this capability.',
      }
  }
}

/** Renders the report rows; `undefined` reports render an honest cannot-check. */
export function capabilityRows(
  report: ComputerUseCapabilityReport | undefined
): readonly CapabilityRowView[] {
  if (!report) {
    return (Object.keys(CAPABILITY_LABELS) as ComputerUseCapabilityRow['id'][]).map((id) => ({
      id,
      label: CAPABILITY_LABELS[id],
      tone: 'unknown' as const,
      stateLabel: 'Cannot check',
      hint: 'The desktop shell has not reported a capability check yet.',
    }))
  }
  return report.capabilities.map(presentCapability)
}

export type LaneActionKind = 'consent' | 'takeover' | 'release' | 'close'

export type LaneAction = Readonly<{
  kind: LaneActionKind
  label: string
  enabled: boolean
}>

/**
 * The affordances one lane offers in its current state. Consent appears only
 * for idle agent-owned lanes (the consent gate refuses everything else);
 * takeover and close are the human kill paths; release is the Escape path.
 */
export function laneActions(lane: ComputerUseLane | undefined): readonly LaneAction[] {
  if (!lane || lane.state === 'closed' || lane.state === 'crashed') return []
  const actions: LaneAction[] = []
  if (lane.automationOwner === 'agent' && lane.state === 'idle') {
    actions.push({ kind: 'consent', label: 'Grant input (consent)', enabled: true })
  }
  if (lane.automationOwner === 'agent') {
    actions.push({ kind: 'takeover', label: 'Take over', enabled: true })
  }
  if (lane.automationOwner === 'human_takeover') {
    actions.push({ kind: 'release', label: 'Release (Escape)', enabled: true })
  }
  actions.push({ kind: 'close', label: 'Close lane (kill switch)', enabled: true })
  return actions
}

/** Human-readable lane summary line, including honest authority state. */
export function laneSummary(lane: ComputerUseLane): string {
  const owner =
    lane.automationOwner === 'human_takeover'
      ? 'you hold control'
      : lane.automationOwner === 'agent'
        ? 'the agent holds control'
        : 'no one holds control'
  return `${lane.state} · generation ${lane.generation} · ${owner}`
}

/**
 * Screen-reader text for a lane state change between two polls.
 * `undefined` when nothing the user must know changed — the live region
 * stays quiet unless state actually moved (permissions-page rule).
 */
export function laneChangeAnnouncement(
  before: ComputerUseLane | undefined,
  after: ComputerUseLane
): string | undefined {
  if (!before) {
    return after.state === 'granted' || after.automationOwner === 'human_takeover'
      ? `Computer-use lane is ${after.state.replaceAll('_', ' ')}; ${laneSummary(after)}`
      : undefined
  }
  if (before.state === after.state && before.generation === after.generation) return undefined
  if (after.automationOwner === 'human_takeover')
    return 'Computer use: you have taken over; agent input is suspended.'
  if (before.automationOwner === 'human_takeover' && after.automationOwner === 'agent')
    return 'Computer use: control released to the agent.'
  if (after.state === 'closed') return 'Computer-use lane closed; input authority revoked.'
  return `Computer-use lane is now ${after.state.replaceAll('_', ' ')}.`
}
