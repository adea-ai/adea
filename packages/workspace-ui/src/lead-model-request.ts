import type { ApiRequestedRoleModelSelections } from '@adea-ai/api-client'
import type {
  AgentHqModelConnectionsClient,
  ApiModelChoice,
} from '@adea-ai/api-client/model-connections'
import { projectSelectableModels } from './lead-model-state'
import { leadRequestedChoicesKey } from './request-id'

export type LeadRequestedChoices = Readonly<{ lead?: ApiModelChoice; child?: ApiModelChoice }>

/** Resolve at save, retain the same refs across an ambiguous message retry, never infer authority. */
export function createLeadModelRequestResolver(client: AgentHqModelConnectionsClient) {
  let retained:
    | { workspaceId: string; key: string; refs: ApiRequestedRoleModelSelections; choices: string }
    | undefined
  return {
    reset() {
      retained = undefined
    },
    async resolve(
      workspaceId: string,
      key: string,
      choices: LeadRequestedChoices,
      current: () => boolean
    ) {
      if (retained?.workspaceId === workspaceId && retained.key === key) {
        if (retained.choices !== leadRequestedChoicesKey(choices))
          throw new Error('Lead model retry changed')
        if (!current()) throw new Error('Lead model scope changed')
        return retained.refs
      }
      const roles = (['lead', 'child'] as const).filter((role) => choices[role])
      if (!roles.length) return undefined
      const inventory = await client.listModelConnections(workspaceId)
      if (!current()) throw new Error('Lead model scope changed')
      const eligible = projectSelectableModels(inventory)
      const refs: {
        lead?: { selectionRef: string; selectionRevision: number }
        child?: { selectionRef: string; selectionRevision: number }
      } = {}
      for (const role of roles) {
        const choice = choices[role]!
        if (
          !eligible.some(
            ({ choice: candidate }) =>
              candidate.connectionRef === choice.connectionRef &&
              candidate.providerModel === choice.providerModel
          )
        )
          throw new Error('Requested model unavailable')
        const { selection } = await client.resolveWorkspaceModelSelection(workspaceId, {
          role,
          override: choice,
        })
        if (!current()) throw new Error('Lead model scope changed')
        if (
          !selection ||
          !/^msel_[a-f0-9]{32}$/.test(selection.selectionRef) ||
          !Number.isSafeInteger(selection.selectionRevision) ||
          selection.selectionRevision < 1 ||
          selection.connectionRef !== choice.connectionRef ||
          selection.providerModel !== choice.providerModel ||
          (['location', 'harness', 'harnessVersion', 'providerBinding'] as const).some(
            (field) => selection.target?.[field] !== inventory.target?.[field]
          )
        )
          throw new Error('Requested model response invalid')
        refs[role] = Object.freeze({
          selectionRef: selection.selectionRef,
          selectionRevision: selection.selectionRevision,
        })
      }
      retained = {
        workspaceId,
        key,
        refs: Object.freeze(refs),
        choices: leadRequestedChoicesKey(choices),
      }
      return retained.refs
    },
  }
}
