/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Substantially translated from KiroCrew website/src/pages/ChatSidebar.tsx at
 * revision 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid and
 * the dependency-owned archive authority.
 */
import { Archive } from 'lucide-solid'
import { Show, createSignal } from 'solid-js'

export function ArchiveShelf() {
  const [expanded, setExpanded] = createSignal(false)
  return (
    <section class="dev-archive-shelf">
      <button
        type="button"
        class="dev-tree-row dev-tree-row--archive"
        aria-expanded={expanded()}
        aria-controls="dev-archive-shelf-content"
        onClick={() => setExpanded((value) => !value)}
      >
        <Archive aria-hidden="true" /> Archived sessions
      </button>
      <Show when={expanded()}>
        <p id="dev-archive-shelf-content" class="dev-tree-empty">
          Archived sessions are unavailable until the runtime archive provider is connected.
        </p>
      </Show>
    </section>
  )
}
