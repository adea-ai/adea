export const projectQueryKeys = {
  archived: (workspaceId: string) => ['workspaces', workspaceId, 'projects', 'archived'] as const,
  all: (workspaceId: string) => ['workspaces', workspaceId, 'projects'] as const,
  detail: (workspaceId: string, projectId: string) =>
    ['workspaces', workspaceId, 'projects', 'detail', projectId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'projects', 'list'] as const,
}
