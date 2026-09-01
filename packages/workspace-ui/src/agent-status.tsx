import type { AgentSummary } from '@agent-hq/types'

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

export function AgentStatus({
  agent,
  compact = false,
}: {
  agent: AgentSummary
  compact?: boolean
}) {
  const status = agentStatusModel(agent)
  return (
    <div
      className={`conventional-agent-status${compact ? ' conventional-agent-status--compact' : ''}`}
    >
      <span
        className={`conventional-status-chip conventional-status-chip--${status.configuration.tone}`}
        title="Persisted Agent lifecycle and AgentProfile configuration"
      >
        {status.configuration.label}
      </span>
      <span
        className={`conventional-status-chip conventional-status-chip--${status.runtime.tone}`}
        title={status.runtime.detail}
      >
        {status.runtime.label}
      </span>
      <span
        className={`conventional-status-chip conventional-status-chip--${status.execution.tone}`}
        title={status.execution.detail}
      >
        {status.execution.label}
      </span>
    </div>
  )
}
