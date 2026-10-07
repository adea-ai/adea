/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Center-pane empty states for views that need a selected project before they
 * can show anything (terminal, files). The add-project action expands the
 * sidebar's authorize panel through the opener the workspace entry registers;
 * when no panel is mounted the action is omitted rather than rendered dead.
 */
import { FolderPlus } from 'lucide-solid'
import { Show } from 'solid-js'

import { cn } from '@adea-ai/app-ui/lib/utils'
import { Button } from '@adea-ai/ui/components/ui/button'

export function SelectProjectEmptyState(props: {
  message: string
  hint?: string
  onAddProject?: () => void
  /**
   * The action stays mounted while its runtime is unavailable (a scope still
   * resolving): a disabled control reads as "not yet", an absent one as
   * "never".
   */
  addDisabled?: boolean
  /** Extra host hook, e.g. the center-pane variant that fills and centers. */
  class?: string
}) {
  return (
    <div class={cn('dev-empty-state', props.class)} role="status">
      <p>{props.message}</p>
      <Show when={props.hint}>
        <p class="dev-empty-state__hint">{props.hint}</p>
      </Show>
      <Show when={props.onAddProject}>
        {/* The primary variant paints the accent, so the one action an empty
            pane offers reads as the action to take. */}
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={props.addDisabled}
          onClick={() => props.onAddProject?.()}
        >
          <FolderPlus aria-hidden="true" />
          Add project
        </Button>
      </Show>
    </div>
  )
}
