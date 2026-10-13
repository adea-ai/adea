/** Explicit opt-in only. Lead admission never accepts caller execution authority. */
export function parseLeadTurnMode(body: Record<string, unknown>): 'lead' | 'history' | null {
  if (body.leadTurn === undefined)
    return body.requestedModelSelections === undefined ? 'history' : null
  if (body.leadTurn !== true) return null
  const allowed = new Set([
    'leadTurn',
    'artifactIds',
    'bodyContentRefId',
    'bodyText',
    'handoffTarget',
    'mentions',
    'requestedModelSelections',
  ])
  return Object.keys(body).every((key) => allowed.has(key)) ? 'lead' : null
}
