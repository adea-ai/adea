import type { AgentSummary } from '@adea-ai/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@adea-ai/ui/components/ui/tooltip'

function StatusChip(props: { detail: string; label: string; tone: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        as="span"
        class={`conventional-status-chip conventional-status-chip--${props.tone}`}
      >
        {props.label}
      </TooltipTrigger>
      <TooltipContent>{props.detail}</TooltipContent>
    </Tooltip>
  )
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
  const status = agentStatusModel(props.agent)
  return (
    <StatusChip
      detail="Persisted Agent lifecycle and AgentProfile configuration"
      label={status.configuration.label}
      tone={status.configuration.tone}
    />
  )
}

export function AgentStatus(props: { agent: AgentSummary; compact?: boolean }) {
  const status = agentStatusModel(props.agent)
  return (
    <div
      class={`conventional-agent-status${props.compact ? ' conventional-agent-status--compact' : ''}`}
    >
      <StatusChip
        detail="Persisted Agent lifecycle and AgentProfile configuration"
        label={status.configuration.label}
        tone={status.configuration.tone}
      />
      <StatusChip
        detail={status.runtime.detail}
        label={status.runtime.label}
        tone={status.runtime.tone}
      />
      <StatusChip
        detail={status.execution.detail}
        label={status.execution.label}
        tone={status.execution.tone}
      />
    </div>
  )
}
