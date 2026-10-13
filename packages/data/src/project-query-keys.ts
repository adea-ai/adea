export const projectQueryKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'projects'] as const,
  detail: (workspaceId: string, projectId: string) =>
    ['workspaces', workspaceId, 'projects', 'detail', projectId] as const,
  list: (workspaceId: string) => ['workspaces', workspaceId, 'projects', 'list'] as const,
}
