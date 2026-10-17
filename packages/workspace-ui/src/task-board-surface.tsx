import { createSignal, onMount, Show, type ComponentProps } from 'solid-js'
import { Dynamic } from 'solid-js/web'

import { createLazyModule } from './lazy-module'
import type { TaskBoard } from './task-board'
import { WorkspaceError, WorkspaceSkeleton } from './workspace-states'

// The board, its cards and (through it) the task panel are off the Chat
// route's static graph: they load when the Tasks surface opens.
const taskBoardModule = createLazyModule(() =>
  import('./task-board').then((module) => module.TaskBoard)
)

/**
 * The Tasks surface: loads the board on first use. A browser keeps a failed
 * module fetch for the life of the page, so Retry reloads it (the surface, its
 * URL and drafts are persisted) rather than importing again in place.
 */
export function TaskBoardSurface(props: ComponentProps<typeof TaskBoard>) {
  const [board, setBoard] = createSignal<typeof TaskBoard | undefined>(taskBoardModule.current())
  const [failure, setFailure] = createSignal<{ error: unknown } | undefined>()
  // Browser-only, like the other deferred surfaces: a server render never
  // starts the import.
  onMount(() => {
    if (board()) return
    taskBoardModule.load().then(
      (component) => setBoard(() => component),
      (error: unknown) => setFailure({ error })
    )
  })

  return (
    <Show
      when={board()}
      fallback={
        <Show when={failure()} fallback={<WorkspaceSkeleton label="Loading tasks" />}>
          {(failed) => (
            <WorkspaceError error={failed().error} retry={() => window.location.reload()} />
          )}
        </Show>
      }
    >
      {(Board) => <Dynamic component={Board()} {...props} />}
    </Show>
  )
}
