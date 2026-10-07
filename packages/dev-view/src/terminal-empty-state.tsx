/*
 * The Dev center's one standardized terminal empty state. Every terminal-leaf
 * circumstance that cannot mount a live pane — no authenticated scope, no
 * selected project, no worktree binding, or a closed pane whose runtime
 * instance the close ended — renders through this composed component with its
 * own copy and actions, so the center never grows a second empty-state shape.
 * Presentation rides the shared `.dev-empty-state`/`--center-pane` styling;
 * the actions come from the published Button, never raw markup.
 */
import { FolderPlus, TerminalSquare } from 'lucide-solid'
import { Show } from 'solid-js'

import { cn } from '@adea-ai/app-ui/lib/utils'
import { Button } from '@adea-ai/ui/components/ui/button'

export type TerminalEmptyStateProps = {
  /** The state's heading line, read at the pane-header scale. */
  title: string
  /** Muted follow-up line under the title. */
  hint?: string
  /**
   * Creates a fresh terminal instance in the selected session's worktree and
   * binds it on this leaf. Omitted when the runtime does not grant terminal
   * management or the host cannot create one here.
   */
  onNewTerminal?: () => void
  /** Disables the new-terminal action while its create command is in flight. */
  newTerminalPending?: boolean
  /**
   * Opens the sidebar's add-project panel; omitted when no panel is mounted
   * rather than rendered dead.
   */
  onAddProject?: () => void
  /** Extra host hook, e.g. the center-pane variant that fills and centers. */
  class?: string
}

export function TerminalEmptyState(props: TerminalEmptyStateProps) {
  // The primary variant paints the accent, so the one action an empty pane
  // offers reads as the action to take; with two actions the fresh terminal
  // leads and the project action steps down to outline.
  const soleAddProject = () => !props.onNewTerminal && Boolean(props.onAddProject)
  return (
    <div class={cn('dev-empty-state', props.class)} role="status">
      <p>{props.title}</p>
      <Show when={props.hint}>
        <p class="dev-empty-state__hint">{props.hint}</p>
      </Show>
      <Show when={props.onNewTerminal || props.onAddProject}>
        <div class="flex items-center gap-2">
          <Show when={props.onNewTerminal}>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={props.newTerminalPending}
              onClick={() => props.onNewTerminal?.()}
            >
              <TerminalSquare aria-hidden="true" />
              New terminal
            </Button>
          </Show>
          <Show when={props.onAddProject}>
            <Button
              type="button"
              variant={soleAddProject() ? 'default' : 'outline'}
              size="sm"
              onClick={() => props.onAddProject?.()}
            >
              <FolderPlus aria-hidden="true" />
              Add project
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
