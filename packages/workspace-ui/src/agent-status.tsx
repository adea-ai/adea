import { createMemo } from 'solid-js'
import type { AgentSummary } from '@adea-ai/types'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import type { StatusTone } from '@adea-ai/ui/components/ui/status-chip'

const TONES: Record<string, StatusTone> = {
  ready: 'success',
  warning: 'warning',
  muted: 'neutral',
  unknown: 'unknown',
}

export function agentStatusModel(agent: AgentSummary) {
  const configuration =
    agent.lifecycleState === 'archived'
      ? { label: 'Archived', tone: 'muted' as const }
      : agent.lifecycleState === 'configuration_error' || agent.profile.state !== 'available'
        ? { label: 'Needs configuration', tone: 'warning' as const }
        : { label: 'Configured', tone: 'ready' as const }
  return Object.freeze({
    configuration,
    execution: Object.freeze({
      detail: 'Execution activity becomes authoritative with M6 execution events.',
      label: 'Activity unknown',
      tone: 'unknown' as const,
    }),
    runtime: Object.freeze({
      detail: 'Runtime availability becomes authoritative with M5 RuntimeConnection data.',
      label: 'Runtime unknown',
      tone: 'unknown' as const,
    }),
  })
}

export function AgentStatusBadge(props: { agent: AgentSummary }) {
  const status = createMemo(() => agentStatusModel(props.agent))
  return (
    <StatusChip
      detail="Persisted Agent lifecycle and AgentProfile configuration"
      label={status().configuration.label}
      tone={TONES[status().configuration.tone]}
    />
  )
}

export function AgentStatus(props: { agent: AgentSummary; compact?: boolean }) {
  const status = createMemo(() => agentStatusModel(props.agent))
  return (
    <div
      class={`conventional-agent-status${props.compact ? ' conventional-agent-status--compact' : ''}`}
  >
      <StatusChip
        detail="Persisted Agent lifecycle and AgentProfile configuration"
        label={status().configuration.label}
        tone={TONES[status().configuration.tone]}
      />
      <StatusChip
        detail={status().runtime.detail}
        label={status().runtime.label}
        tone={TONES[status().runtime.tone]}
      />
      <StatusChip
        detail={status().execution.detail}
        label={status().execution.label}
        tone={TONES[status().execution.tone]}
      />
    </div>
  )
}
