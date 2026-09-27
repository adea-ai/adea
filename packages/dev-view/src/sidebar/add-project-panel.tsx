/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Add/search surface for the contextual sidebar (#398): recent authorized
 * roots, bounded monorepo scan previews, and a confirm-before-import flow.
 * Composition follows the add flows substantially translated from KiroCrew's
 * ChatSidebar and Orca's AddRepoDialog (donor audit #398), rebuilt for Solid,
 * Adea tokens, and the authority boundary: this component issues only
 * `dev.project.bookmarks`, `dev.project.scan`, `dev.group.list`,
 * `dev.group.create`, and `dev.project.import` commands. Scan results are
 * previews requiring confirmation; nothing here ever executes
 * install/bootstrap commands.
 */
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import { createSignal, lazy, Show, Suspense } from 'solid-js'

export type AddProjectPanelProps = Readonly<{
  scope: Scope
  execute(command: DevCommand): Promise<DevReply>
  /** Names of live projects, for the duplicate preview state. */
  knownProjectNames: readonly string[]
  onImported(): void
  announce(message: string): void
}>

const AddProjectForm = lazy(() =>
  import('./add-project-form').then((module) => ({ default: module.AddProjectForm }))
)

export function AddProjectPanel(props: AddProjectPanelProps) {
  // Once opened, retain the form owner while details hides it so scan and draft
  // state survive collapse without repeating the runtime requests.
  const [visited, setVisited] = createSignal(false)
  return (
    <details
      class="dev-tree-group"
      onToggle={(event) => {
        if (event.currentTarget.open) setVisited(true)
      }}
    >
      <summary class="dev-tree-row dev-tree-row--group">Add project</summary>
      <Show when={visited()}>
        <Suspense
          fallback={
            <p class="dev-tree-empty" role="status">
              Loading project options…
            </p>
          }
        >
          <AddProjectForm {...props} />
        </Suspense>
      </Show>
    </details>
  )
}
