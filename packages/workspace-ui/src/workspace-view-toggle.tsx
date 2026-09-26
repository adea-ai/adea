/**
 * The workspace surfaces the rail can switch between.
 *
 * The toggle component that used to live here is gone: `GlobalWorkspaceRail`
 * replaced it, and nothing in the monorepo imported it. Unlike `@adea-ai/app-ui`,
 * `workspace-ui` is not a published package, so an unimported export here is
 * dead code rather than library surface. The type stays — the rail consumes it.
 */
export type WorkspaceView = 'chat' | 'dev' | 'virtual'
