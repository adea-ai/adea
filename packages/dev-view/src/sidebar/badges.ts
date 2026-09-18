/**
 * Independent per-session badge projection for the contextual sidebar. Each
 * badge stands alone: a missing state renders nothing and never reserves
 * space, so row height is unchanged whether zero or four badges are present.
 * Badge data is presentation-only and grants no authority.
 */
export type DevSessionBadgeState = Readonly<{
  harness?: 'working' | 'awaiting_input' | 'awaiting_approval' | 'idle'
  dirty?: boolean
  checks?: 'running' | 'passed' | 'failed'
  ports?: readonly number[]
}>

export type DevSessionBadge = Readonly<{
  kind: 'harness' | 'dirty' | 'checks' | 'ports'
  /** Stable accessible name describing the state in full. */
  label: string
  /** Compact visible pill text that fits the existing row height. */
  short: string
  tone: 'neutral' | 'progress' | 'success' | 'failure'
}>

const harnessBadge: Readonly<
  Record<
    NonNullable<DevSessionBadgeState['harness']>,
    { label: string; short: string; tone: DevSessionBadge['tone'] }
  >
> = {
  working: { label: 'Harness working', short: 'harness', tone: 'success' },
  awaiting_input: { label: 'Harness awaiting input', short: 'input', tone: 'progress' },
  awaiting_approval: { label: 'Harness awaiting approval', short: 'approval', tone: 'progress' },
  idle: { label: 'Harness idle', short: 'harness', tone: 'neutral' },
}

export function sessionBadges(state: DevSessionBadgeState | undefined): readonly DevSessionBadge[] {
  if (!state) return []
  const badges: DevSessionBadge[] = []
  if (state.harness) {
    const harness = harnessBadge[state.harness]
    badges.push({ kind: 'harness', label: harness.label, short: harness.short, tone: harness.tone })
  }
  if (state.dirty === true)
    badges.push({ kind: 'dirty', label: 'Uncommitted changes', short: 'dirty', tone: 'failure' })
  if (state.checks === 'running')
    badges.push({ kind: 'checks', label: 'Checks running', short: 'checks…', tone: 'progress' })
  else if (state.checks === 'passed')
    badges.push({ kind: 'checks', label: 'Checks passed', short: 'checks ✓', tone: 'success' })
  else if (state.checks === 'failed')
    badges.push({ kind: 'checks', label: 'Checks failed', short: 'checks ✗', tone: 'failure' })
  if (state.ports && state.ports.length > 0)
    badges.push({
      kind: 'ports',
      label: `Owned ports ${state.ports.join(', ')}`,
      short: state.ports.map((port) => `:${port}`).join(' '),
      tone: 'neutral',
    })
  return badges
}
