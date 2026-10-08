import type { ChannelSummary, ProjectSummary } from '@adea-ai/types'

export type ProjectNavigationItem = Readonly<{
  primaryChannel?: ChannelSummary
  project: ProjectSummary
  selectionChannelId?: string
  visibleChannels: readonly ChannelSummary[]
}>

export type WorkspaceNavigation = Readonly<{
  directAgentChannels: readonly ChannelSummary[]
  groupChannels: readonly ChannelSummary[]
  projects: readonly ProjectNavigationItem[]
}>

export type WorkspaceSelectionDecision =
  | Readonly<{ action: 'wait' }>
  | Readonly<{ action: 'clear' }>
  | Readonly<{ action: 'preserve'; clearExplicitSelection: boolean }>
  | Readonly<{ action: 'select'; channelId: string; projectId: string | null }>

/**
 * Preserve a valid selection, including one just created while its list query
 * is refreshing. The caller must not call the store's channel setter for the
 * preserve result because changing channels closes an open thread.
 */
export function reconcileWorkspaceChannelSelection(
  input: Readonly<{
    channels: readonly ChannelSummary[] | undefined
    explicitSelection: string | null
    navigation: WorkspaceNavigation
    selectedChannelId: string | null
  }>
): WorkspaceSelectionDecision {
  if (!input.channels) return { action: 'wait' }

  if (input.selectedChannelId && input.channels.some(({ id }) => id === input.selectedChannelId)) {
    return {
      action: 'preserve',
      clearExplicitSelection: input.explicitSelection === input.selectedChannelId,
    }
  }

  if (input.selectedChannelId && input.selectedChannelId === input.explicitSelection) {
    return { action: 'preserve', clearExplicitSelection: false }
  }

  const firstProject = input.navigation.projects.find(
    ({ selectionChannelId }) => selectionChannelId
  )
  const channelId =
    firstProject?.selectionChannelId ??
    input.navigation.directAgentChannels[0]?.id ??
    input.navigation.groupChannels[0]?.id
  return channelId
    ? { action: 'select', channelId, projectId: firstProject?.project.id ?? null }
    : input.selectedChannelId
      ? { action: 'clear' }
      : { action: 'wait' }
}

function compareChannels(left: ChannelSummary, right: ChannelSummary) {
  return (
    left.sortOrder - right.sortOrder ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  )
}

export function projectWorkspaceNavigation(
  projects: readonly ProjectSummary[],
  channels: readonly ChannelSummary[]
): WorkspaceNavigation {
  const activeChannels = channels.filter(({ lifecycleState }) => lifecycleState === 'active')
  const projectItems = [...projects]
    .filter(({ lifecycleState }) => lifecycleState === 'active')
    .toSorted(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
    )
    .map((project) => {
      const projectChannels = activeChannels
        .filter((channel) => channel.kind === 'project' && channel.projectId === project.id)
        .toSorted(compareChannels)
      const primaryChannel = projectChannels.find(
        ({ isPrimaryProjectChannel }) => isPrimaryProjectChannel
      )
      return Object.freeze({
        ...(primaryChannel ? { primaryChannel } : {}),
        project,
        ...(primaryChannel || projectChannels[0]
          ? { selectionChannelId: (primaryChannel ?? projectChannels[0])!.id }
          : {}),
        visibleChannels: Object.freeze(projectChannels.length > 1 ? projectChannels : []),
      })
    })
  return Object.freeze({
    directAgentChannels: Object.freeze(
      activeChannels.filter(({ kind }) => kind === 'direct_agent').toSorted(compareChannels)
    ),
    groupChannels: Object.freeze(
      activeChannels.filter(({ kind }) => kind === 'group').toSorted(compareChannels)
    ),
    projects: Object.freeze(projectItems),
  })
}
