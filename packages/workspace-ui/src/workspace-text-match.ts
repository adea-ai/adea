import type { AgentSummary, ConversationParticipantRef } from '@adea-ai/types'

export function fuzzySearchMatch(candidate: string, query: string) {
  const target = candidate.toLocaleLowerCase()
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  let cursor = 0
  for (const character of target) if (character === needle[cursor]) cursor += 1
  return cursor === needle.length
}

export function parseAgentMentions(
  text: string,
  agents: readonly AgentSummary[]
): readonly ConversationParticipantRef[] {
  const normalized = text.toLocaleLowerCase()
  return agents
    .filter(({ name }) => normalized.includes(`@${name.toLocaleLowerCase()}`))
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    )
    .map(({ id }) => Object.freeze({ agentId: id, kind: 'agent' as const }))
}
